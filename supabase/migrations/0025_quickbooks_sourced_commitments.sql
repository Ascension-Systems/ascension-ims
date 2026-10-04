-- 0025_quickbooks_sourced_commitments.sql — "committed" comes from QuickBooks only.
--
-- DECISION (3 Oct 2026). Reps no longer record commitments in the portal. Committed stock is
-- whatever QuickBooks Desktop reports on open sales orders, delivered through the inventory
-- adapter (lib/inventory-source.ts) and apply_inventory_sync. The portal becomes read-only
-- toward the inventory source and records no commitments of its own. Accepted trade-off: stock
-- promised before a sales order is entered in QuickBooks is not shown as committed — the client
-- enters sales orders promptly (docs/QUESTIONS-FOR-LEVON.md item 3).
--
-- What this migration does, in dependency order:
--   1. v_inventory: committed and available come straight from the source row.
--   2. record_commitment() and pending_commitment_totals() are dropped.
--   3. apply_inventory_sync(): the commitment-matching loop is removed; a non-empty `matches`
--      payload is refused with KY016; an override row keeps its corrected fields but its
--      qty_committed is refreshed from the source.
--   4. pin_override_attribution(): attribution is re-stamped only on a human correction, so a
--      sync run by a different admin no longer re-credits someone else's override.
--   5. commitments: retained read-only as history; write privileges revoked outright.
--   6. inventory INSERT is column-scoped without qty_committed, so no portal path can enter a
--      committed figure (UPDATE has been column-scoped without it since 0013).
--   7. app_settings.inventory_authority pinned to 'quickbooks' (the app no longer reads it).
--
-- Forward-only. Requires 0001–0024. Historical commitments rows and inventory_sync_runs columns
-- are kept; nothing is deleted.

-- ----------------------------------------------------------------------------
-- 1. v_inventory — the source's figures, unblended.
--    Dropped and recreated because columns are removed (CREATE OR REPLACE VIEW cannot drop
--    columns). security_invoker stays ON: a default view would run as its owner and bypass RLS.
--    qty_available is NOT clamped at zero — negative means QuickBooks has more on open sales
--    orders than on hand, which a rep must see.
-- ----------------------------------------------------------------------------
DROP VIEW IF EXISTS public.v_inventory;

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
  i.qty_committed,
  i.qty_available_source AS qty_available,
  i.qty_incoming,
  i.incoming_eta,
  i.source,
  i.override_note,
  i.override_at,
  i.override_by,
  i.updated_at
FROM public.products p
JOIN public.inventory i
  ON i.sku = p.sku;

-- Same grant as 0012: authenticated only, never anon.
REVOKE ALL ON public.v_inventory FROM PUBLIC, anon;
GRANT SELECT ON public.v_inventory TO authenticated;

-- ----------------------------------------------------------------------------
-- 2. The portal commitment write path and its aggregate.
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.record_commitment(text, integer, text, text);
DROP FUNCTION IF EXISTS public.pending_commitment_totals();

-- ----------------------------------------------------------------------------
-- 3. apply_inventory_sync — rows only.
--    Copied from 0013 with three changes, each marked CHANGED (0025):
--      a. the `matches` loop is gone; a non-empty `matches` array is refused (KY016) so a
--         stale caller fails loudly instead of being silently ignored;
--      b. a manual_override row keeps qty_on_hand / qty_incoming / incoming_eta / source and
--         its attribution, but takes qty_committed from the source row;
--      c. the commitment counters in inventory_sync_runs are written as 0 (columns kept for
--         historical rows) and are no longer returned.
--    The fail-closed role guard is unchanged.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apply_inventory_sync(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_run_id    uuid  := gen_random_uuid();
  v_rows      jsonb := COALESCE(p_payload -> 'rows', '[]'::jsonb);
  v_row       jsonb;
  v_updated   integer := 0;
  v_overrides integer := 0;
  v_rejected  jsonb := '[]'::jsonb;
  v_inv       public.inventory%ROWTYPE;
  v_committed integer;
BEGIN
  -- ROLE GUARD — FAIL CLOSED (unchanged from 0013). Both COALESCEs are load-bearing: a NULL
  -- in `IF NOT (...)` would not fire and the function would be fail-open.
  IF NOT (
       COALESCE(public.is_admin(), false)
       OR COALESCE(auth.role(), '') = 'service_role'
     ) THEN
    RAISE EXCEPTION 'admin role required' USING ERRCODE = 'KY003';
  END IF;

  -- CHANGED (0025) a. Commitment matching no longer exists.
  IF jsonb_typeof(p_payload -> 'matches') = 'array'
     AND jsonb_array_length(p_payload -> 'matches') > 0 THEN
    RAISE EXCEPTION 'commitment matching was removed in 0025; committed comes from the source rows'
      USING ERRCODE = 'KY016';
  END IF;

  -- Locked in a deterministic (sku, location) order so two concurrent syncs cannot deadlock.
  FOR v_row IN
    SELECT e.value
    FROM jsonb_array_elements(v_rows) AS e(value)
    ORDER BY e.value ->> 'sku', e.value ->> 'location'
  LOOP
    SELECT * INTO v_inv
    FROM public.inventory
    WHERE sku = v_row ->> 'sku'
      AND location = COALESCE(v_row ->> 'location', 'default')
    FOR UPDATE;

    IF NOT FOUND THEN
      v_rejected := v_rejected ||
        jsonb_build_object('reason', 'unknown_sku_location', 'row', v_row);
      CONTINUE;
    END IF;

    v_committed := (v_row ->> 'qty_committed')::integer;

    IF v_inv.source = 'manual_override' THEN
      -- CHANGED (0025) b. The admin's correction stands; QuickBooks' committed does not wait
      -- for it. updated_at moves only if committed actually changed, so a no-op sync never
      -- claims freshness (the 0013 rule).
      UPDATE public.inventory
      SET qty_committed  = v_committed,
          source_payload = COALESCE(source_payload, '{}'::jsonb)
                           || jsonb_build_object('last_source_snapshot', v_row,
                                                 'last_source_seen_at', now()),
          updated_at     = CASE
                             WHEN v_inv.qty_committed IS DISTINCT FROM v_committed THEN now()
                             ELSE v_inv.updated_at
                           END
      WHERE sku = v_inv.sku AND location = v_inv.location;
      v_overrides := v_overrides + 1;
    ELSE
      UPDATE public.inventory
      SET qty_on_hand    = (v_row ->> 'qty_on_hand')::integer,
          qty_committed  = v_committed,
          qty_incoming   = (v_row ->> 'qty_incoming')::integer,
          incoming_eta   = NULLIF(v_row ->> 'incoming_eta', '')::date,
          source         = COALESCE((v_row ->> 'source')::public.inventory_source,
                                    'quickbooks_stub'::public.inventory_source),
          source_payload = v_row,
          updated_at     = CASE
                             WHEN v_inv.qty_on_hand   IS DISTINCT FROM (v_row ->> 'qty_on_hand')::integer
                               OR v_inv.qty_committed IS DISTINCT FROM v_committed
                               OR v_inv.qty_incoming  IS DISTINCT FROM (v_row ->> 'qty_incoming')::integer
                               OR v_inv.incoming_eta  IS DISTINCT FROM NULLIF(v_row ->> 'incoming_eta', '')::date
                             THEN now()
                             ELSE v_inv.updated_at
                           END
      WHERE sku = v_inv.sku AND location = v_inv.location;
      v_updated := v_updated + 1;
    END IF;
  END LOOP;

  -- CHANGED (0025) c.
  INSERT INTO public.inventory_sync_runs
    (id, run_by, rows_applied, overrides_preserved,
     commitments_confirmed, commitments_still_pending, report)
  VALUES
    (v_run_id, auth.uid(), v_updated, v_overrides,
     0, 0, jsonb_build_object('rejected', v_rejected));

  RETURN jsonb_build_object(
    'run_id',              v_run_id,
    'rows_applied',        v_updated,
    'overrides_preserved', v_overrides,
    'rejected',            v_rejected
  );
END;
$$;

-- Re-asserted after CREATE OR REPLACE, exactly as 0012.
REVOKE EXECUTE ON FUNCTION public.apply_inventory_sync(jsonb) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.apply_inventory_sync(jsonb) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 4. Override attribution — stamped on a human correction only.
--    0013 re-stamped override_by/override_at on EVERY update of an override row with a
--    non-NULL auth.uid(). Once syncs refresh qty_committed on override rows (3b), that would
--    credit admin B with admin A's correction whenever B ran a sync. Now:
--      * INSERT of an override row, the row BECOMING an override, or a change to a field a
--        person corrects (qty_on_hand, qty_incoming, incoming_eta, override_note) -> stamped
--        with the caller and now();
--      * any other update of an override row -> attribution forced back to OLD, which also
--        stops a caller rewriting override_by/override_at through an otherwise empty update.
--    A NULL auth.uid() (service_role, the harness) keeps the 0013 behaviour: values left as
--    supplied.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pin_override_attribution()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.source <> 'manual_override' OR auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT'
     OR OLD.source IS DISTINCT FROM 'manual_override'
     OR NEW.qty_on_hand   IS DISTINCT FROM OLD.qty_on_hand
     OR NEW.qty_incoming  IS DISTINCT FROM OLD.qty_incoming
     OR NEW.incoming_eta  IS DISTINCT FROM OLD.incoming_eta
     OR NEW.override_note IS DISTINCT FROM OLD.override_note THEN
    NEW.override_by := auth.uid();
    NEW.override_at := now();
  ELSE
    NEW.override_by := OLD.override_by;
    NEW.override_at := OLD.override_at;
  END IF;
  RETURN NEW;
END;
$$;
-- The trigger from 0013 (inventory_pin_override_attribution, BEFORE INSERT OR UPDATE) already
-- points at this function; replacing the body is sufficient.

-- ----------------------------------------------------------------------------
-- 5. commitments — history, read-only.
--    There was never an INSERT/UPDATE/DELETE policy (0011), so RLS already refused writes; the
--    privileges go too, as defence in depth. The SELECT policy and grant are unchanged.
-- ----------------------------------------------------------------------------
REVOKE INSERT, UPDATE, DELETE ON public.commitments FROM PUBLIC, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 6. inventory INSERT — column-scoped, without qty_committed.
--    0012 granted table-wide INSERT and 0024 re-granted it with an admin-only policy. A new
--    line now starts at committed 0 until the next sync; nothing in the portal can set it.
--    The admin-only INSERT policy (0024) is unchanged.
-- ----------------------------------------------------------------------------
REVOKE INSERT ON public.inventory FROM authenticated;

GRANT INSERT (
  sku,
  location,
  qty_on_hand,
  qty_incoming,
  incoming_eta,
  source,
  source_payload,
  override_note,
  override_by,
  override_at,
  updated_at
) ON public.inventory TO authenticated;

-- ----------------------------------------------------------------------------
-- 7. One authority. The column stays for compatibility; the app no longer reads it.
-- ----------------------------------------------------------------------------
UPDATE public.app_settings SET inventory_authority = 'quickbooks';

NOTIFY pgrst, 'reload schema';
