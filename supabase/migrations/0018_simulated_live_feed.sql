-- ============================================================================
-- 0018_simulated_live_feed.sql — a scheduled "live" QuickBooks feed for the demo
--
-- The inventory source is a stub (there is no real QuickBooks integration yet). This makes the
-- stub BREATHE: every 10 minutes it nudges the QuickBooks-side figures (on_hand, committed,
-- incoming, eta, updated_at) within realistic bounds, so the app looks live without anyone
-- clicking Sync. It is a DEMO aid, clearly labelled, and is trivial to remove when the real
-- integration lands (unschedule the job, drop the function).
--
-- WHAT IT DOES NOT TOUCH:
--   * Rep commitments (the commitments table) — those are real and reflect real usage.
--   * manual_override rows — an admin's hand-set figure is preserved, exactly as apply_inventory_sync does.
--
-- CONFINES (so numbers stay realistic):
--   * every quantity clamped to >= 0; on_hand capped at 999; incoming capped at 300.
--   * committed can never exceed on_hand (so QuickBooks-side availability is never negative).
--   * per-run steps are small (on_hand +/-3, committed +/-2), a gentle random walk, not jumps.
--   * only ~35% of rows move each run, so the board changes a little at a time.
--
-- Written, NOT applied — paste into the Supabase SQL editor. Requires the pg_cron extension;
-- if the CREATE EXTENSION line errors on permissions, enable "pg_cron" once under
-- Dashboard -> Database -> Extensions, then re-run this file.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;

CREATE OR REPLACE FUNCTION public.drift_inventory()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_touched integer;
BEGIN
  WITH ni AS (
    SELECT
      sku,
      location,
      -- on_hand: small random step, plus an occasional delivery landing from incoming.
      LEAST(999, GREATEST(0,
        qty_on_hand
        + (floor(random() * 7) - 3)::int
        + CASE WHEN random() < 0.15 AND qty_incoming > 0
               THEN LEAST(qty_incoming, (floor(random() * 5) + 1)::int) ELSE 0 END
      )) AS new_on_hand,
      GREATEST(0, qty_committed + (floor(random() * 5) - 2)::int) AS new_committed,
      -- incoming: occasionally a delivery arrives (down) or a new PO is raised (up).
      LEAST(300, GREATEST(0,
        qty_incoming
        - CASE WHEN random() < 0.15 THEN LEAST(qty_incoming, (floor(random() * 5) + 1)::int) ELSE 0 END
        + CASE WHEN random() < 0.10 THEN (floor(random() * 8) + 1)::int ELSE 0 END
      )) AS new_incoming
    FROM public.inventory
    WHERE source <> 'manual_override'
      AND random() < 0.35
  )
  UPDATE public.inventory AS i
  SET
    qty_on_hand   = ni.new_on_hand,
    qty_committed = LEAST(ni.new_committed, ni.new_on_hand),   -- committed never exceeds on_hand
    qty_incoming  = ni.new_incoming,
    incoming_eta  = CASE WHEN ni.new_incoming > 0
                         THEN COALESCE(i.incoming_eta, current_date + ((floor(random() * 14) + 3)::int))
                         ELSE NULL END,
    source        = 'quickbooks_stub',
    updated_at    = now()
  FROM ni
  WHERE i.sku = ni.sku AND i.location = ni.location;

  GET DIAGNOSTICS v_touched = ROW_COUNT;

  -- Leave a breadcrumb so the admin's "last synced" reflects the simulated feed.
  INSERT INTO public.inventory_sync_runs (rows_applied, report)
  VALUES (v_touched, jsonb_build_object('simulated', true, 'note', 'scheduled demo feed (0018)'));

  RETURN v_touched;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.drift_inventory() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.drift_inventory() TO service_role;

-- Schedule every 10 minutes. Unschedule any prior copy first so re-running this file is safe.
DO $$
BEGIN
  PERFORM cron.unschedule('drift-inventory');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule('drift-inventory', '*/10 * * * *', $$ SELECT public.drift_inventory(); $$);

-- To stop it later:   SELECT cron.unschedule('drift-inventory');
-- To remove entirely: also DROP FUNCTION public.drift_inventory();
