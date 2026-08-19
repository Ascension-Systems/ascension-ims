-- 0011_rls_policies.sql — every policy, as SQL
-- APPLY BY HAND, in numeric order, in the Supabase SQL editor.
--
-- RLS was enabled on each table in its creating migration. Until this file is applied every
-- table is deny-all, which is the correct intermediate state.
--
-- Every policy is scoped TO authenticated. `anon` gets no policies at all, and additionally
-- has its grants revoked in 0012 — belt and braces, because a policy is only reachable if
-- the grant exists.
--
-- FORCE ROW LEVEL SECURITY is deliberately NOT used. The SECURITY DEFINER functions run as
-- postgres, which also owns the tables; a table owner bypasses RLS unless FORCE is set. That
-- bypass is exactly what lets record_commitment insert a row that no client-facing policy
-- permits. Setting FORCE would break the concurrency-controlled write path. Do not add it.

------------------------------------------------------------------------------
-- profiles
------------------------------------------------------------------------------

-- A rep sees exactly one row: their own. An admin sees all.
CREATE POLICY profiles_select_self_or_admin ON public.profiles
  FOR SELECT TO authenticated
  USING (id = auth.uid() OR public.is_admin());

-- Admin-only. No rep has any write path to this table, which is what makes
-- self-promotion to admin unreachable through the API.
CREATE POLICY profiles_update_admin ON public.profiles
  FOR UPDATE TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- No INSERT policy: profiles are created by handle_new_user() / ensure_profile(), both
-- SECURITY DEFINER. No DELETE policy: profiles follow auth.users via ON DELETE CASCADE.

------------------------------------------------------------------------------
-- products
------------------------------------------------------------------------------

-- The catalogue is readable by every signed-in user. It is not secret.
CREATE POLICY products_select_authenticated ON public.products
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY products_insert_admin ON public.products
  FOR INSERT TO authenticated
  WITH CHECK (public.is_admin());

CREATE POLICY products_update_admin ON public.products
  FOR UPDATE TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

CREATE POLICY products_delete_admin ON public.products
  FOR DELETE TO authenticated
  USING (public.is_admin());

------------------------------------------------------------------------------
-- inventory
------------------------------------------------------------------------------

CREATE POLICY inventory_select_authenticated ON public.inventory
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY inventory_insert_admin ON public.inventory
  FOR INSERT TO authenticated
  WITH CHECK (public.is_admin());

-- Attack 1 asserts this refuses a rep's write. Attack 4 asserts the same thing from the
-- role-enforcement direction.
CREATE POLICY inventory_update_admin ON public.inventory
  FOR UPDATE TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

CREATE POLICY inventory_delete_admin ON public.inventory
  FOR DELETE TO authenticated
  USING (public.is_admin());

------------------------------------------------------------------------------
-- commitments — ONE POLICY, DELIBERATELY
------------------------------------------------------------------------------

-- A rep reads their own commitments and nobody else's. An admin reads all.
-- This is the predicate attack 1 targets directly.
CREATE POLICY commitments_select_own_or_admin ON public.commitments
  FOR SELECT TO authenticated
  USING (rep_id = auth.uid() OR public.is_admin());

-- There is deliberately NO INSERT, UPDATE or DELETE policy on commitments, for any role,
-- INCLUDING admin.
--
-- An INSERT policy would let a rep write a commitment row directly and skip the availability
-- check inside record_commitment() — which would make the concurrency control (0009)
-- trivially bypassable. Every write to this table goes through a SECURITY DEFINER function
-- that takes the row lock first. Nothing else can write here.
--
-- An UPDATE policy would let a client edit `state` and bypass the lifecycle trigger's
-- intent. State transitions belong to apply_inventory_sync() and, later, step 3's admin
-- functions.
--
-- Direct INSERT/UPDATE/DELETE from any client therefore fails with SQLSTATE 42501.

------------------------------------------------------------------------------
-- app_settings
------------------------------------------------------------------------------

-- Every signed-in user must read inventory_authority and the thresholds to render the list.
CREATE POLICY app_settings_select_authenticated ON public.app_settings
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY app_settings_update_admin ON public.app_settings
  FOR UPDATE TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- No INSERT policy (the singleton row is inserted by migration 0006), no DELETE policy.

------------------------------------------------------------------------------
-- inventory_sync_runs
------------------------------------------------------------------------------

-- Admin only. A rep has no business reading sync internals, and this gives attack 1 a
-- second forbidden-read target that is not commitments.
CREATE POLICY sync_runs_select_admin ON public.inventory_sync_runs
  FOR SELECT TO authenticated
  USING (public.is_admin());

-- No INSERT/UPDATE/DELETE policies: rows are written only by apply_inventory_sync()
-- (SECURITY DEFINER).
