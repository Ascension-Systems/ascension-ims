-- ============================================================================
-- 0019_login_lockout.sql — per-EMAIL login lockout, DB-backed.
--
-- THE PROBLEM. `lib/rate-limit.ts` bounds a SINGLE source (keyed on the
-- non-spoofable x-nf-client-connection-ip) and lives in one serverless
-- instance's memory. A pen test flagged that the one known admin address
-- (info@kyriesystems.com) can be brute-forced from MANY IPs: each IP stays
-- under the per-IP ceiling, the global ceiling is generous, and nothing bounds
-- attempts against a single ACCOUNT across instances.
--
-- THE FIX. A per-EMAIL failure counter in Postgres — shared by every
-- serverless instance, unaffected by cold starts. After a threshold of failures
-- inside a rolling window the email is locked for a cooldown. The IP limiter in
-- lib/rate-limit.ts is UNCHANGED and still runs first; this is IN ADDITION.
--
-- POLICY (all three constants live in register_login_failure below):
--   * WINDOW    15 minutes — failures older than this start a fresh count.
--   * THRESHOLD 10 failures inside the window trips the lock.
--   * LOCKOUT   15 minutes — how long the email stays locked once tripped.
--
-- ENUMERATION SAFETY. Failures are tracked by the SUBMITTED email, whether or
-- not an account exists for it, and the caller-visible result is identical in
-- both cases (the app returns the same generic 'rate' message the IP limiter
-- already uses). This table is therefore NOT an oracle: it is service_role-only
-- (RLS on, no anon/authenticated grants, like the enrollment tables in 0014),
-- so nobody but the server can read it, and the server never branches
-- user-visible behaviour on whether a row — or an account — exists.
--
-- FAIL-OPEN is a CALLER property, not enforced here: app/login/actions.ts
-- catches any error from these functions and proceeds to normal auth, so a DB
-- hiccup can slow the hardening but can never lock every account out.
--
-- Written, NOT applied — paste into the Supabase SQL editor.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS citext;

-- --------------------------------------------------------------------------
-- The counter. citext PK so Admin@Firm.com and admin@firm.com are one email,
-- matching invited_reps and how the login form lower-cases before submitting.
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.login_attempts (
  email         citext      PRIMARY KEY,
  fail_count    integer     NOT NULL DEFAULT 0,
  first_fail_at timestamptz NOT NULL DEFAULT now(),
  last_fail_at  timestamptz NOT NULL DEFAULT now(),
  locked_until  timestamptz,

  CONSTRAINT login_attempts_fail_count_non_negative CHECK (fail_count >= 0)
);

COMMENT ON TABLE public.login_attempts IS
  'Per-email login failure counter for cross-instance account lockout. service_role only; '
  'never an account-existence oracle — see 0019 header.';

-- --------------------------------------------------------------------------
-- RLS. NOBODY reads or writes this but service_role.
--
-- There is no admin UI for it and no rep ever touches it; both login functions
-- run server-side under service_role. So — unlike the enrollment tables, which
-- grant admins management via a policy — this table has NO policy and NO
-- anon/authenticated grants at all. RLS is enabled anyway so a future
-- accidental grant still denies by default.
-- --------------------------------------------------------------------------

ALTER TABLE public.login_attempts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.login_attempts FROM anon, authenticated;
GRANT  SELECT, INSERT, UPDATE, DELETE ON public.login_attempts TO service_role;

-- --------------------------------------------------------------------------
-- register_login_failure — record one failed attempt, return the lock (or NULL).
--
-- SECURITY DEFINER and service_role-only. Upserts the counter under the row's
-- own lock (ON CONFLICT serialises concurrent failures for the same email):
--
--   * RESET the window to a fresh count of 1 when the last failure was longer
--     than WINDOW ago, OR a prior lockout has already elapsed. The second half
--     matters because while an email is locked the caller short-circuits and
--     never reaches this function, so the FIRST attempt after a lock expires
--     must start clean rather than immediately trip an eleventh failure.
--   * Otherwise INCREMENT within the open window.
--
-- When the running count reaches THRESHOLD, stamp locked_until = now() + LOCKOUT
-- and return it. Returns the current locked_until otherwise (usually NULL).
-- --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.register_login_failure(p_email citext)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  c_window    constant interval := interval '15 minutes';
  c_lockout   constant interval := interval '15 minutes';
  c_threshold constant integer  := 10;

  v_fail_count   integer;
  v_locked_until timestamptz;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'login attempts may only be recorded server-side' USING ERRCODE = 'KY003';
  END IF;

  INSERT INTO public.login_attempts (email, fail_count, first_fail_at, last_fail_at, locked_until)
  VALUES (p_email, 1, now(), now(), NULL)
  ON CONFLICT (email) DO UPDATE SET
    fail_count = CASE
      WHEN login_attempts.last_fail_at < now() - c_window
        OR (login_attempts.locked_until IS NOT NULL AND login_attempts.locked_until <= now())
      THEN 1
      ELSE login_attempts.fail_count + 1
    END,
    first_fail_at = CASE
      WHEN login_attempts.last_fail_at < now() - c_window
        OR (login_attempts.locked_until IS NOT NULL AND login_attempts.locked_until <= now())
      THEN now()
      ELSE login_attempts.first_fail_at
    END,
    -- Clear a stale (expired) lock on reset so it can't re-trip on the next hit.
    locked_until = CASE
      WHEN login_attempts.last_fail_at < now() - c_window
        OR (login_attempts.locked_until IS NOT NULL AND login_attempts.locked_until <= now())
      THEN NULL
      ELSE login_attempts.locked_until
    END,
    last_fail_at = now()
  RETURNING fail_count INTO v_fail_count;

  IF v_fail_count >= c_threshold THEN
    UPDATE public.login_attempts
       SET locked_until = now() + c_lockout
     WHERE email = p_email
    RETURNING locked_until INTO v_locked_until;
  ELSE
    SELECT locked_until INTO v_locked_until
      FROM public.login_attempts WHERE email = p_email;
  END IF;

  RETURN v_locked_until;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.register_login_failure(citext) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.register_login_failure(citext) TO service_role;

-- --------------------------------------------------------------------------
-- clear_login_failures — wipe the counter on a SUCCESSFUL login.
--
-- SECURITY DEFINER and service_role-only. Deleting the row is the simplest
-- reset: a fresh failure re-inserts it. Idempotent — deleting a non-existent
-- row is a no-op, so calling it after every success is safe.
-- --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.clear_login_failures(p_email citext)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'login attempts may only be cleared server-side' USING ERRCODE = 'KY003';
  END IF;

  DELETE FROM public.login_attempts WHERE email = p_email;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.clear_login_failures(citext) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.clear_login_failures(citext) TO service_role;

-- --------------------------------------------------------------------------
-- is_login_locked — the pre-auth gate. Returns locked_until IF the email is
-- CURRENTLY locked (locked_until still in the future), else NULL.
--
-- SECURITY DEFINER and service_role-only. Read-only; the caller checks this
-- BEFORE touching the auth server and, when it returns non-NULL, redirects with
-- the same generic 'rate' error the IP limiter uses — identical for a
-- locked-out known-good address and any other email.
-- --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.is_login_locked(p_email citext)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_locked_until timestamptz;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'login lock may only be checked server-side' USING ERRCODE = 'KY003';
  END IF;

  SELECT locked_until INTO v_locked_until
    FROM public.login_attempts
   WHERE email = p_email;

  IF v_locked_until IS NOT NULL AND v_locked_until > now() THEN
    RETURN v_locked_until;
  END IF;

  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.is_login_locked(citext) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.is_login_locked(citext) TO service_role;
