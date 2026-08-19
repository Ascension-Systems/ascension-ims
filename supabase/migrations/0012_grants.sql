-- 0012_grants.sql — grants are the other half of the gate
-- APPLY BY HAND, in numeric order, in the Supabase SQL editor.
--
-- RLS alone is not sufficient. Supabase's default privileges grant anon and authenticated
-- broad access to new tables in public, and a policy is only consulted when the underlying
-- grant exists. Making the grants explicit is what makes the policy set actually describe
-- reality.

-- Schema usage
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- Start from nothing for the two client-facing roles.
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon;

-- anon gets nothing back. An unauthenticated caller with the anon key can read no
-- application data whatsoever.

-- authenticated: the minimum the app needs. Row visibility is then narrowed by RLS.
GRANT SELECT                 ON public.profiles            TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.products    TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.inventory   TO authenticated;
GRANT SELECT                 ON public.commitments         TO authenticated;
GRANT SELECT, UPDATE         ON public.app_settings        TO authenticated;
GRANT SELECT                 ON public.inventory_sync_runs TO authenticated;
GRANT SELECT                 ON public.v_inventory         TO authenticated;

-- UPDATE on profiles is granted so the admin UPDATE policy is reachable at all.
GRANT UPDATE                 ON public.profiles            TO authenticated;

-- Functions. EXECUTE is revoked from PUBLIC first, because functions are granted to
-- PUBLIC by default -- the most commonly missed line in a Supabase hardening pass.
REVOKE EXECUTE ON FUNCTION public.record_commitment(text, integer, text, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.apply_inventory_sync(jsonb)                  FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.ensure_profile()                             FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.pending_commitment_totals()                  FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.app_role()                                   FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.is_admin()                                   FROM PUBLIC, anon;

-- Trigger functions. Postgres refuses a direct call ("trigger functions can only be called as
-- triggers"), so this is hygiene rather than a live hole -- but a complete revoke list is the
-- thing a pen test checks, and "all functions except the two nobody thought of" is not one.
-- Line 15's REVOKE ALL ON ALL FUNCTIONS covers anon and not PUBLIC, so PUBLIC retained EXECUTE
-- on both of these until this pass.
REVOKE EXECUTE ON FUNCTION public.handle_new_user()                 FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.enforce_commitment_invariants()   FROM PUBLIC, anon;
-- No matching GRANT: trigger functions execute as the trigger owner and need none.

GRANT EXECUTE ON FUNCTION public.record_commitment(text, integer, text, text)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.apply_inventory_sync(jsonb)
  TO authenticated, service_role;   -- guarded internally by is_admin(); anon cannot reach it
GRANT EXECUTE ON FUNCTION public.ensure_profile()
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.pending_commitment_totals()
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.app_role()  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_admin()  TO authenticated, service_role;

-- Anything created LATER by this role defaults to nothing for the client roles. Scoped with
-- an explicit FOR ROLE so the statement is not silently a no-op: ALTER DEFAULT PRIVILEGES
-- without FOR ROLE applies only to objects created by the CURRENT role, which on a hosted
-- Supabase project is `postgres`. Objects created by any other role are NOT covered by this
-- and must be granted explicitly, as everything above is.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM PUBLIC, anon;

-- The SEQUENCES line was missing entirely. FUNCTIONS is revoked from PUBLIC as well as anon,
-- because functions default to PUBLIC, not to anon -- revoking only from anon left the default
-- wide open for every future function.

-- THE PAIRING, CORRECTED 2026-08-19. This note used to say apply_inventory_sync permits a NULL
-- auth.uid() and that "that branch is only sound because EXECUTE is revoked from anon". That is
-- now FALSE, and a false comment is worse than none.
--
-- 0010's role guard is fail-closed ON ITS OWN: it denies by default and admits only
-- COALESCE(public.is_admin(), false) or COALESCE(auth.role(), '') = 'service_role'. A NULL-uid
-- anonymous caller is refused with KY003 by the function itself, with or without this revoke.
--
-- THE REVOKE BELOW STAYS. It is now defence in depth rather than the only thing standing there,
-- and a future change that granted anon EXECUTE would no longer open the guard -- but it must
-- still not be made: two independent refusals is the correct posture, and the revoke is what
-- keeps anon from reaching the function at all rather than merely being refused inside it.
-- BOTH HALVES STAY. Assertion 4.13 proves the guard independently of the grant by deliberately
-- granting anon EXECUTE on a disposable local database and asserting KY003 anyway.
