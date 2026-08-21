-- ============================================================================
-- 0016_admin_onboarding.sql — role-aware onboarding (admin code + rep codes)
--
-- Extends 0014 so an account's role is decided at enrollment, WITHOUT weakening
-- the load-bearing invariant: THE CODE ALONE IS NEVER ENOUGH. A leaked admin code
-- must not mint an admin.
--
-- The model, unchanged in spirit:
--   * The ALLOWLIST is the authority on WHO gets WHICH role. An admin invites an
--     address AS a rep (default) or AS an admin.
--   * The CODE gates JOINING and must MATCH the invited role. So provisioning as
--     an admin needs BOTH: the address invited as admin AND the admin code. A rep
--     who somehow gets the admin code cannot use it — their invite says 'rep', the
--     code says 'admin', and the two must agree.
--
-- This is the exact escalation a pen test probes; it is closed at the database.
-- Written, NOT applied — paste into the Supabase SQL editor.
-- ============================================================================

-- 1. Role on both tables. Default 'rep' so every existing row keeps today's meaning.
ALTER TABLE public.enrollment_codes ADD COLUMN IF NOT EXISTS role public.app_role NOT NULL DEFAULT 'rep';
ALTER TABLE public.invited_reps     ADD COLUMN IF NOT EXISTS role public.app_role NOT NULL DEFAULT 'rep';

-- 2. Claiming, now role-aware. Provisioned role comes from the INVITE (the allowlist
--    authority); the code's role must equal it. Everything else — service_role only,
--    row locks, usage cap, expiry, generic raises — is unchanged from 0014.
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

  -- The gate that makes the admin code safe: the code's role must match the invited
  -- role. A rep code cannot claim an admin invite; the admin code cannot claim a rep
  -- invite. Generic-ish code so /api/enroll's single refusal message stays uniform.
  IF v_code.role <> v_invite.role THEN
    RAISE EXCEPTION 'code does not match the invitation' USING ERRCODE = 'KY015';
  END IF;

  -- Provision at the INVITE's role, never the caller's choice. ON CONFLICT so a
  -- re-run cannot duplicate the profile; role is refreshed to the invited role.
  INSERT INTO public.profiles (id, email, role)
  VALUES (p_user_id, p_email::text, v_invite.role)
  ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, role = EXCLUDED.role;

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

-- 3. The admin onboarding code. Role 'admin', usage-capped low and expiring, so a
--    leak is bounded and it can be revoked from the Team page. Worthless without an
--    address invited AS an admin.
INSERT INTO public.enrollment_codes (code, label, role, max_uses, expires_at)
VALUES (
  'TORTUGA2026',
  'Admin onboarding',
  'admin',
  10,
  now() + interval '90 days'
)
ON CONFLICT (code) DO UPDATE SET role = 'admin', label = EXCLUDED.label;
