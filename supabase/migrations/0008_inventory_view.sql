-- 0008_inventory_view.sql — the availability derivation
-- APPLY BY HAND, in numeric order, in the Supabase SQL editor.
--
-- Two objects. Read the note on security_invoker carefully; getting it wrong in either
-- direction produces a bug.

-- The portal delta, aggregated. SECURITY DEFINER is deliberate and load-bearing.
--
-- Reps may read only their OWN commitment rows (RLS, migration 0011). If this aggregate ran
-- as the invoker, every rep would compute a portal delta that counted only their own
-- commitments and would see an availability figure that is too high for everyone else's
-- sales -- which is precisely the oversell bug this project exists to prevent.
--
-- The exposure is deliberate and bounded: this returns a TOTAL per (sku, location) and
-- nothing else. Reps learn how many units are spoken for. They do not learn by whom, when,
-- for what, or in how many separate commitments. Individual rows stay protected by RLS.
CREATE OR REPLACE FUNCTION public.pending_commitment_totals()
RETURNS TABLE (sku text, location text, qty_committed_portal integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT c.sku, c.location, SUM(c.qty)::integer
  FROM public.commitments c
  WHERE c.state = 'pending'
  GROUP BY c.sku, c.location;
$$;

-- WITH (security_invoker = on) IS MANDATORY.
--
-- A Postgres view runs with the VIEW OWNER's privileges by default. The owner here is
-- postgres, which bypasses RLS -- so a default view over these tables would be a complete
-- RLS bypass reachable with the anon key. This is a known Supabase footgun and attack 1
-- asserts against it explicitly.
--
-- With security_invoker on, the caller's RLS applies to products and inventory (both of
-- which every authenticated user may read anyway), while the commitments aggregate arrives
-- via the SECURITY DEFINER function above. That combination is the whole point.
CREATE VIEW public.v_inventory
WITH (security_invoker = on)
AS
SELECT
  p.sku,
  p.name,
  p.category,
  p.uom,
  p.low_stock_threshold,
  i.location,
  i.qty_on_hand,
  i.qty_committed                                   AS qty_committed_source,
  COALESCE(t.qty_committed_portal, 0)               AS qty_committed_portal,
  i.qty_committed + COALESCE(t.qty_committed_portal, 0) AS qty_committed_total,
  i.qty_available_source,
  i.qty_available_source - COALESCE(t.qty_committed_portal, 0) AS qty_available,
  i.qty_incoming,
  i.incoming_eta,
  i.source,
  i.override_note,
  i.override_at,
  i.override_by,
  i.updated_at
FROM public.products p
JOIN public.inventory i
  ON i.sku = p.sku
LEFT JOIN public.pending_commitment_totals() t
  ON t.sku = i.sku AND t.location = i.location;

------------------------------------------------------------------------------
-- The four availability figures, and which one means what
--
--   qty_on_hand            source on-hand                            components line
--   qty_committed_source   committed per the source (QuickBooks)      components line
--   qty_committed_portal   sum of `pending` commitments               the advisory delta line
--   qty_available_source   on_hand - committed_source                 primary in 'quickbooks' mode
--   qty_available          on_hand - committed_source - committed_portal
--                                                                     primary in 'portal' mode;
--                                                                     ALWAYS drives the status badge
--
-- `available` is NEVER clamped at zero. A negative figure is real information — it means the
-- source reported an on-hand drop below what is already spoken for. Clamping it would hide
-- exactly the condition a rep needs to see.
--
-- The status badge is always computed from qty_available, the most conservative figure, in
-- BOTH authority modes. Authority mode governs presentation emphasis, not safety.
------------------------------------------------------------------------------
