-- --------------------------------------------------------------------------
-- 0013_provisioned_only_and_column_grants.sql
--
-- Three defects found by adversarial audit, all confirmed by execution against
-- the hosted project. None is reachable by a rep today; all are reachable by
-- anyone who can obtain an `authenticated` JWT.
--
-- 1. A SELF-REGISTERED STRANGER COULD READ THE WHOLE CATALOGUE.
--    `products_select_authenticated` and `inventory_select_authenticated` were
--    `USING (true) TO authenticated` -- ANY authenticated identity, with no
--    profiles row required. Supabase project-level signup is a dashboard
--    setting; while it is enabled, anyone can register with a mailbox they own,
--    confirm it themselves, and read every product, every quantity and all of
--    v_inventory straight from PostgREST with no application in the path.
--    `shouldCreateUser: false` in the login action governs only OUR form, not
--    GoTrue's /signup and /otp routes.
--
--    Being provisioned is now a REQUIREMENT TO READ ANYTHING. A stranger who
--    self-registers gets a valid JWT and sees nothing at all. That closes the
--    exposure in the database, where it belongs, rather than depending on a
--    dashboard toggle staying set.
--
-- 2. qty_committed AND OVERRIDE ATTRIBUTION WERE WRITABLE BY ANY ADMIN SESSION.
--    0012 granted blanket UPDATE on public.inventory to `authenticated`, and
--    `inventory_update_admin` is column-blind, so an admin JWT plus the public
--    anon key could write qty_committed directly through PostgREST (moving the
--    generated qty_available_source with it) and forge override_by to another
--    admin. app/api/inventory/route.ts claims "qty_committed IS NOT WRITABLE
--    HERE" and "database authoritative"; that was true of the handler and false
--    of the database. Now the grant is column-scoped so the claim holds.
--
-- 3. AN OVERRIDE COULD BE MISATTRIBUTED. Even column-scoped, override_by was
--    caller-supplied. A trigger now pins it to auth.uid() and stamps override_at
--    server-side whenever source becomes 'manual_override', so attribution
--    cannot be forged by anything that reaches the table.
--
-- Reversible, and safe to apply to a live database: no data is modified, only
-- policies, grants and one trigger. apply_inventory_sync is SECURITY DEFINER and
-- runs as its owner, so the sync path is unaffected by the narrowed grant.
-- --------------------------------------------------------------------------

-- --------------------------------------------------------------------------
-- 1. Reading requires a provisioned profile, not merely a session.
-- --------------------------------------------------------------------------

-- A profiles row whose role is a valid app_role. `app_role` has exactly two
-- values, so this is "is this account provisioned for the portal".
CREATE OR REPLACE FUNCTION public.is_provisioned()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid()
      AND p.role IN ('rep', 'admin')
  );
$$;

REVOKE EXECUTE ON FUNCTION public.is_provisioned() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.is_provisioned() TO authenticated, service_role;

DROP POLICY IF EXISTS products_select_authenticated ON public.products;
CREATE POLICY products_select_provisioned ON public.products
  FOR SELECT TO authenticated
  USING (public.is_provisioned());

DROP POLICY IF EXISTS inventory_select_authenticated ON public.inventory;
CREATE POLICY inventory_select_provisioned ON public.inventory
  FOR SELECT TO authenticated
  USING (public.is_provisioned());

-- --------------------------------------------------------------------------
-- 2. Column-scoped UPDATE. qty_committed is the SOURCE's figure; portal
--    commitments are a ledger layered over it, and merging the two blurs the
--    delta the product rests on. It is deliberately absent from this list, as
--    are the generated availability columns.
-- --------------------------------------------------------------------------

REVOKE UPDATE ON public.inventory FROM authenticated;

GRANT UPDATE (
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

-- --------------------------------------------------------------------------
-- 3. Attribution is stamped server-side, never taken from the caller.
-- --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.pin_override_attribution()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.source = 'manual_override' THEN
    -- service_role has no auth.uid(); leave its attribution alone so the
    -- verification harness and any server-side job remain able to seed rows.
    IF auth.uid() IS NOT NULL THEN
      NEW.override_by := auth.uid();
      NEW.override_at := now();
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inventory_pin_override_attribution ON public.inventory;
CREATE TRIGGER inventory_pin_override_attribution
  BEFORE INSERT OR UPDATE ON public.inventory
  FOR EACH ROW
  EXECUTE FUNCTION public.pin_override_attribution();


-- --------------------------------------------------------------------------
-- 4. A SYNC THAT CHANGES NOTHING MUST NOT CLAIM THE DATA IS FRESH.
--
-- Reproduced end to end: a row aged three days rendered the STALE badge; one
-- sync of that single row left all quantities byte-identical and the badge was
-- gone. `updated_at` was advanced on every applied row regardless of whether
-- anything actually changed, so pressing "Run sync" told ~120 reps that stale
-- figures were current.
--
-- This is a verbatim copy of apply_inventory_sync from 0010 with ONE change --
-- the updated_at assignment below -- so the role guard, the deterministic lock
-- ordering, the override-preservation branch and the match-only retirement are
-- all unchanged and still exactly as verified by attacks 3 and 4.
-- --------------------------------------------------------------------------

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
          -- `updated_at` means "when the FIGURES last changed", NOT "when a sync last ran".
          -- Advancing it unconditionally made the portal assert freshness it did not have:
          -- a row deliberately aged three days rendered the STALE badge, one sync left every
          -- quantity byte-identical, and the badge was gone. Reps quote customers from these
          -- numbers, so a false freshness signal is the same class of defect as a false
          -- quantity. Only a real change to the figures advances the clock.
          updated_at     = CASE
                             WHEN v_inv.qty_on_hand   IS DISTINCT FROM (v_row ->> 'qty_on_hand')::integer
                               OR v_inv.qty_committed IS DISTINCT FROM (v_row ->> 'qty_committed')::integer
                               OR v_inv.qty_incoming  IS DISTINCT FROM (v_row ->> 'qty_incoming')::integer
                               OR v_inv.incoming_eta  IS DISTINCT FROM NULLIF(v_row ->> 'incoming_eta', '')::date
                             THEN now()
                             ELSE v_inv.updated_at
                           END
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
