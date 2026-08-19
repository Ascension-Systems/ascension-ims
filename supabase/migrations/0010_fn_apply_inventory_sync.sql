-- 0010_fn_apply_inventory_sync.sql — matching-only retirement
-- APPLY BY HAND, in numeric order, in the Supabase SQL editor.
--
-- WHAT "MATCHING" MEANS, CONCRETELY. A pending commitment becomes confirmed_in_source ONLY
-- when the sync payload contains a `matches` entry that names it by its portal id and
-- agrees on every identifying field:
--
--   match.commitment_id = commitments.id
--   match.sku           = commitments.sku
--   match.location      = commitments.location
--   match.qty           = commitments.qty
--   commitments.state   = 'pending'
--
-- Anything else is recorded in the run report as match_fields_disagree or
-- unknown_commitment and the commitment STAYS PENDING.
--
-- Matching is explicit and never inferred. There is no quantity-absorption heuristic — the
-- function never reasons "the source's committed figure went up by 6, so retire six units'
-- worth of the oldest pending commitments." That heuristic silently retires the wrong
-- commitments whenever two reps commit the same SKU.
--
-- WHAT HAPPENS TO A COMMITMENT THE SYNC DOES NOT MENTION: it persists, unchanged, in
-- pending, and it keeps reducing `available`. For as long as that takes. There is no time
-- limit, no expiry, no grace period, and no "the sync ran and did not find it, so it must be
-- gone." That is not a side effect of the implementation — it is the default behaviour,
-- because the function only ever touches commitments named in `matches`.
--
-- There is no now(), no interval, no age(), and no date comparison anywhere in the
-- retirement path. Do not add one. Migration 0005 backs this up structurally: the state
-- trigger rejects pending -> retired, so even a hostile or careless future cron job cannot
-- retire a live delta in one step.
--
-- Nothing in this run sets `retired`. That transition exists in the schema and is legal from
-- confirmed_in_source, but no code path reaches it until step 3.

CREATE OR REPLACE FUNCTION public.apply_inventory_sync(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_run_id    uuid  := gen_random_uuid();
  v_rows      jsonb := COALESCE(p_payload -> 'rows',    '[]'::jsonb);
  v_matches   jsonb := COALESCE(p_payload -> 'matches', '[]'::jsonb);
  v_row       jsonb;
  v_match     jsonb;
  v_updated   integer := 0;
  v_overrides integer := 0;
  v_confirmed integer := 0;
  v_unmatched integer := 0;
  v_rejected  jsonb := '[]'::jsonb;
  v_inv       public.inventory%ROWTYPE;
  v_c         public.commitments%ROWTYPE;
BEGIN
  -- ROLE GUARD — FAIL CLOSED, WITHIN THIS FILE.
  --
  -- Deny by default. Exactly two callers are permitted:
  --   * an admin  (public.is_admin(), which reads profiles.role via the signed JWT's sub)
  --   * service_role, for the unattended sync (auth.role() reads the JWT's role claim)
  --
  -- Both COALESCEs are load-bearing. auth.role() is NULL when there is no request.jwt.claims
  -- GUC, and in plpgsql `IF NULL THEN` does not fire — an un-COALESCEd expression would be
  -- fail-OPEN, which is the exact defect this amendment removes.
  --
  -- The previous form was `IF auth.uid() IS NOT NULL AND NOT public.is_admin()`, which
  -- permitted every NULL-uid caller and was safe only because 0012 revokes EXECUTE from anon.
  -- That is a TWO-FILE property, and during hand-paced manual migration application there is a
  -- window between pasting 0010 and pasting 0012 in which the database sits fail-open. The
  -- 0012 revoke STAYS — it is still correct and is now defence in depth rather than the only
  -- thing standing here.
  IF NOT (
       COALESCE(public.is_admin(), false)
       OR COALESCE(auth.role(), '') = 'service_role'
     ) THEN
    RAISE EXCEPTION 'admin role required' USING ERRCODE = 'KY003';
  END IF;

  ----------------------------------------------------------------------------
  -- 1. Apply the baseline rows.
  --    Locked in a deterministic (sku, location) order so two concurrent syncs
  --    cannot deadlock against each other.
  ----------------------------------------------------------------------------
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

    IF v_inv.source = 'manual_override' THEN
      -- NEVER silently overwrite an admin override. Record what the source claimed,
      -- leave the displayed quantities alone. This is inventory_authority = 'quickbooks'
      -- behaviour at the data layer: show both numbers, never silently override.
      UPDATE public.inventory
      SET source_payload = COALESCE(source_payload, '{}'::jsonb)
                           || jsonb_build_object('last_source_snapshot', v_row,
                                                 'last_source_seen_at', now())
      WHERE sku = v_inv.sku AND location = v_inv.location;
      v_overrides := v_overrides + 1;
    ELSE
      UPDATE public.inventory
      SET qty_on_hand    = (v_row ->> 'qty_on_hand')::integer,
          qty_committed  = (v_row ->> 'qty_committed')::integer,
          qty_incoming   = (v_row ->> 'qty_incoming')::integer,
          incoming_eta   = NULLIF(v_row ->> 'incoming_eta', '')::date,
          source         = COALESCE((v_row ->> 'source')::public.inventory_source,
                                    'quickbooks_stub'::public.inventory_source),
          source_payload = v_row,
          updated_at     = now()
      WHERE sku = v_inv.sku AND location = v_inv.location;
      v_updated := v_updated + 1;
    END IF;
  END LOOP;

  ----------------------------------------------------------------------------
  -- 2. Retire deltas BY EXPLICIT MATCH ONLY.
  --    No elapsed-time comparison appears anywhere in this block, by design.
  --    A commitment absent from p_payload->'matches' is not touched: it stays
  --    pending and keeps reducing available.
  ----------------------------------------------------------------------------
  FOR v_match IN SELECT e.value FROM jsonb_array_elements(v_matches) AS e(value)
  LOOP
    SELECT * INTO v_c
    FROM public.commitments
    WHERE id = (v_match ->> 'commitment_id')::uuid
    FOR UPDATE;

    IF NOT FOUND THEN
      v_rejected := v_rejected ||
        jsonb_build_object('reason', 'unknown_commitment', 'match', v_match);
      CONTINUE;
    END IF;

    IF v_c.state <> 'pending'
       OR v_c.sku      <> (v_match ->> 'sku')
       OR v_c.location <> (v_match ->> 'location')
       OR v_c.qty      <> (v_match ->> 'qty')::integer THEN
      v_rejected := v_rejected ||
        jsonb_build_object('reason', 'match_fields_disagree',
                           'match', v_match, 'commitment_id', v_c.id);
      CONTINUE;
    END IF;

    UPDATE public.commitments
    SET state        = 'confirmed_in_source',
        source_ref   = v_match ->> 'source_ref',
        confirmed_at = now()
    WHERE id = v_c.id;

    v_confirmed := v_confirmed + 1;
  END LOOP;

  SELECT count(*) INTO v_unmatched FROM public.commitments WHERE state = 'pending';

  INSERT INTO public.inventory_sync_runs
    (id, run_by, rows_applied, overrides_preserved,
     commitments_confirmed, commitments_still_pending, report)
  VALUES
    (v_run_id, auth.uid(), v_updated, v_overrides,
     v_confirmed, v_unmatched, jsonb_build_object('rejected', v_rejected));

  RETURN jsonb_build_object(
    'run_id',                    v_run_id,
    'rows_applied',              v_updated,
    'overrides_preserved',       v_overrides,
    'commitments_confirmed',     v_confirmed,
    'commitments_still_pending', v_unmatched,
    'rejected',                  v_rejected
  );
END;
$$;

------------------------------------------------------------------------------
-- Deadlock analysis
--
-- record_commitment locks one inventory row, then reads commitments without locking.
-- apply_inventory_sync locks inventory rows in (sku, location) order, then locks
-- commitments rows by id. The two never acquire locks in opposing order, so no deadlock is
-- reachable between them.
------------------------------------------------------------------------------
