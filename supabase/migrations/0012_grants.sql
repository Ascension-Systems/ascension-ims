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

-- Anything created later defaults to nothing for the client roles.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon;

-- Note the pairing that makes apply_inventory_sync safe: it permits a NULL auth.uid() (so
-- service_role can run an unattended sync), and that branch is only sound because EXECUTE is
-- revoked from anon, whose auth.uid() is also NULL. If a future change grants anon execute
-- on that function, the role guard opens. Both halves must stay.
