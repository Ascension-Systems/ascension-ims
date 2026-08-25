-- 0024_inventory_admin_insert.sql — let an admin create inventory lines, not only correct them.
--
-- The spreadsheet import (/api/inventory/import) can UPDATE stock on the existing catalogue with
-- the grants already in place, because admins hold UPDATE on inventory (0011/0012). But a file
-- that introduces a NEW product needs a NEW inventory row, and `authenticated` has no INSERT
-- privilege on the table — the import reported "permission denied for table inventory" per row
-- and created the product without its stock.
--
-- Scope is deliberately narrow: INSERT only, admins only, RLS-checked. Reps remain unable to
-- touch inventory at all, and the atomic commitment path (record_commitment) is untouched — the
-- oversell guarantee does not depend on who may insert a line, only on the locked read/write
-- inside that function.

GRANT INSERT ON public.inventory TO authenticated;

DROP POLICY IF EXISTS inventory_insert_admin ON public.inventory;
CREATE POLICY inventory_insert_admin ON public.inventory
  FOR INSERT TO authenticated
  WITH CHECK (COALESCE(public.is_admin(), false));

NOTIFY pgrst, 'reload schema';
