-- --------------------------------------------------------------------------
-- 0014_enrollment.sql — self-serve onboarding for ~120 reps.
--
-- THE PROBLEM. Creating 120 accounts by hand in the Supabase dashboard is the
-- single most painful part of going live, and every magic link depends on email
-- delivery that is currently rate-capped.
--
-- WHAT THIS IS NOT. It is deliberately NOT a shared login code. Every commitment
-- is attributed to a specific rep (`record_commitment` reads auth.uid(), and
-- `commitments_select_own_or_admin` is `rep_id = auth.uid()`), so a shared
-- identity would make the reconciliation queue useless -- "6 units committed" by
-- nobody in particular, with no one to chase for the paperwork -- and would show
-- every rep every other rep's book. The code governs JOINING, not LOGGING IN.
--
-- THE SHAPE. An admin bulk-imports the rep email list once. A rep visits /join,
-- enters the shared code plus THEIR OWN email, and if that email is on the list
-- their account is created, provisioned as a rep, and signed in immediately --
-- no email sent, no link, no waiting.
--
-- WHY THE ALLOWLIST IS LOAD-BEARING. Without it, anyone holding the code could
-- enrol under a colleague's address and own that identity. With it, the code
-- alone is worthless: it must be paired with an address the admin already
-- invited. That is what makes a widely-shared code safe.
--
-- Codes expire, are usage-capped, and can be revoked without touching anyone
-- already enrolled.
-- --------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS citext;

-- --------------------------------------------------------------------------
-- Enrollment codes
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.enrollment_codes (
  code        text PRIMARY KEY,
  label       text        NOT NULL,
  expires_at  timestamptz,
  max_uses    integer,
  uses        integer     NOT NULL DEFAULT 0,
  is_active   boolean     NOT NULL DEFAULT true,
  created_by  uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT enrollment_code_min_length CHECK (length(code) >= 8),
  CONSTRAINT enrollment_uses_non_negative CHECK (uses >= 0),
  CONSTRAINT enrollment_max_uses_positive CHECK (max_uses IS NULL OR max_uses > 0)
);

COMMENT ON TABLE public.enrollment_codes IS
  'Shared codes that permit JOINING, never logging in. Always paired with an invited email.';

-- --------------------------------------------------------------------------
-- The allowlist. citext so Rep@Firm.com and rep@firm.com are the same person.
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.invited_reps (
  email       citext PRIMARY KEY,
  full_name   text,
  invited_by  uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  invited_at  timestamptz NOT NULL DEFAULT now(),
  claimed_by  uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  claimed_at  timestamptz,

  CONSTRAINT invited_email_shape CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  -- claimed_by and claimed_at move together or not at all.
  CONSTRAINT invited_claim_is_complete CHECK (
    (claimed_by IS NULL AND claimed_at IS NULL) OR
    (claimed_by IS NOT NULL AND claimed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS invited_reps_unclaimed_idx
  ON public.invited_reps (invited_at) WHERE claimed_at IS NULL;

COMMENT ON TABLE public.invited_reps IS
  'Allowlist of addresses permitted to enrol. Without this the shared code alone would let '
  'anyone claim any identity.';

-- --------------------------------------------------------------------------
-- RLS. NEITHER TABLE IS READABLE BY A REP.
--
-- The allowlist is a roster of the client''s entire sales network and the codes
-- are onboarding secrets. Enrollment itself runs server-side under service_role
-- (it must create an auth user), so no anon or authenticated read path is
-- needed at all. Admins can read and manage; nobody else sees anything.
-- --------------------------------------------------------------------------

ALTER TABLE public.enrollment_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invited_reps     ENABLE ROW LEVEL SECURITY;

CREATE POLICY enrollment_codes_admin_all ON public.enrollment_codes
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

CREATE POLICY invited_reps_admin_all ON public.invited_reps
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- No grants to anon. Admin access flows through the policies above.
REVOKE ALL ON public.enrollment_codes FROM anon;
REVOKE ALL ON public.invited_reps     FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.enrollment_codes TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.invited_reps     TO authenticated;

-- --------------------------------------------------------------------------
-- Claiming an invitation, atomically.
--
-- SECURITY DEFINER and callable ONLY by service_role: the enrollment route has
-- already created the auth user by the time it calls this, and a rep must never
-- be able to invoke it. Validates the code and the allowlist entry together,
-- increments the code''s usage, and marks the invitation claimed -- in one
-- statement each, under a row lock, so two people racing the last use of a
-- capped code cannot both succeed.
--
-- Raises, never returns a soft failure, so a caller cannot mistake a refusal
-- for success:
--   KY010 invalid or inactive code   KY011 code expired
--   KY012 code fully used            KY013 address not invited
--   KY014 invitation already claimed
-- --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.claim_enrollment(
  p_code    text,
  p_email   citext,
  p_user_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_code   public.enrollment_codes%ROWTYPE;
  v_invite public.invited_reps%ROWTYPE;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'enrollment may only be claimed server-side' USING ERRCODE = 'KY003';
  END IF;

  SELECT * INTO v_code FROM public.enrollment_codes
   WHERE code = p_code FOR UPDATE;

  IF NOT FOUND OR NOT v_code.is_active THEN
    RAISE EXCEPTION 'invalid enrollment code' USING ERRCODE = 'KY010';
  END IF;
  IF v_code.expires_at IS NOT NULL AND v_code.expires_at < now() THEN
    RAISE EXCEPTION 'enrollment code expired' USING ERRCODE = 'KY011';
  END IF;
  IF v_code.max_uses IS NOT NULL AND v_code.uses >= v_code.max_uses THEN
    RAISE EXCEPTION 'enrollment code fully used' USING ERRCODE = 'KY012';
  END IF;

  SELECT * INTO v_invite FROM public.invited_reps
   WHERE email = p_email FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'address not invited' USING ERRCODE = 'KY013';
  END IF;
  IF v_invite.claimed_at IS NOT NULL THEN
    RAISE EXCEPTION 'invitation already claimed' USING ERRCODE = 'KY014';
  END IF;

  -- Provision as a rep. ON CONFLICT so a re-run cannot duplicate the profile.
  INSERT INTO public.profiles (id, email, role)
  VALUES (p_user_id, p_email::text, 'rep')
  ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email;

  UPDATE public.invited_reps
     SET claimed_by = p_user_id, claimed_at = now()
   WHERE email = p_email;

  UPDATE public.enrollment_codes
     SET uses = uses + 1
   WHERE code = p_code;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_enrollment(text, citext, uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.claim_enrollment(text, citext, uuid) TO service_role;

-- --------------------------------------------------------------------------
-- A first code, so the flow works the moment this migration lands.
--
-- Not a secret in the cryptographic sense and not treated as one: it is
-- worthless without a matching invited address. Rotate it from the Team page
-- (or by inserting a new row and deactivating this one) whenever the client
-- wants; deactivating a code never affects anyone already enrolled.
-- --------------------------------------------------------------------------

INSERT INTO public.enrollment_codes (code, label, max_uses, expires_at)
VALUES (
  'ASCENSION-2026',
  'Initial rep onboarding',
  200,                      -- comfortably above ~120 reps, still finite
  now() + interval '90 days'
)
ON CONFLICT (code) DO NOTHING;
