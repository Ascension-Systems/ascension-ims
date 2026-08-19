-- 0005_commitments.sql — the delta ledger
-- APPLY BY HAND, in numeric order, in the Supabase SQL editor.
--
-- The commitments DATA LAYER ships in full in build-order step 1. Its UI does not (D8).
-- There is no "record a commitment" screen, button or link anywhere in this run; the only
-- way to write this table is public.record_commitment() (migration 0009).

CREATE TABLE public.commitments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku          text NOT NULL,
  location     text NOT NULL DEFAULT 'default',
  qty          integer NOT NULL CHECK (qty > 0),
  rep_id       uuid NOT NULL REFERENCES public.profiles (id) ON DELETE RESTRICT,
  state        public.commitment_state NOT NULL DEFAULT 'pending',
  note         text,
  source_ref   text,          -- the source document reference that matched it, once matched
  created_at   timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  retired_at   timestamptz,

  FOREIGN KEY (sku, location)
    REFERENCES public.inventory (sku, location) ON DELETE RESTRICT,

  CONSTRAINT commitments_state_timestamps CHECK (
        (state = 'pending'             AND confirmed_at IS NULL     AND retired_at IS NULL)
     OR (state = 'confirmed_in_source' AND confirmed_at IS NOT NULL AND retired_at IS NULL)
     OR (state = 'retired'             AND confirmed_at IS NOT NULL AND retired_at IS NOT NULL)
  )
);

ALTER TABLE public.commitments ENABLE ROW LEVEL SECURITY;

-- Drives the availability aggregate. Partial index: only pending rows reduce available.
CREATE INDEX commitments_pending_idx
  ON public.commitments (sku, location) WHERE state = 'pending';

CREATE INDEX commitments_rep_idx   ON public.commitments (rep_id, created_at DESC);
CREATE INDEX commitments_state_idx ON public.commitments (state, created_at);

------------------------------------------------------------------------------
-- Lifecycle semantics — which states reduce `available`
--
--   pending              YES.  The portal knows about the sale; the source baseline does
--                             not. Set by record_commitment() on insert.
--   confirmed_in_source  NO.   The synced baseline's own qty_committed now includes it;
--                             counting it again would double-count. Set by
--                             apply_inventory_sync(), on an explicit match only.
--   retired              NO.   Terminal archival state. Nothing in this run sets it.
--                             Reachable only from confirmed_in_source.
--
-- The transition from pending to confirmed_in_source and the arrival of the new baseline
-- happen in the SAME TRANSACTION inside apply_inventory_sync(). If they were separate,
-- there would be a window where neither the ledger nor the baseline counted the commitment
-- and `available` would briefly jump up — the oversell bug, in miniature.
------------------------------------------------------------------------------

-- This is where "retirement by matching only, never by time" becomes structurally hard
-- rather than merely intended. The lifecycle is a one-way ratchet with no shortcut from
-- pending to retired, so no timer, cron job, or nightly reset can retire a live delta — it
-- would have to pass through confirmed_in_source, which only an explicit match sets.
CREATE OR REPLACE FUNCTION public.enforce_commitment_invariants()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- A commitment's identity is immutable. Without this, "retirement" could be faked by
  -- rewriting qty to 0, or the row repointed at a different SKU.
  IF NEW.sku <> OLD.sku
     OR NEW.location   <> OLD.location
     OR NEW.qty        <> OLD.qty
     OR NEW.rep_id     <> OLD.rep_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'commitment % is immutable in sku/location/qty/rep_id/created_at', OLD.id
      USING ERRCODE = 'KY006';
  END IF;

  IF NEW.state = OLD.state THEN
    RETURN NEW;
  END IF;

  IF OLD.state = 'pending' AND NEW.state = 'confirmed_in_source' THEN
    NEW.confirmed_at := COALESCE(NEW.confirmed_at, now());
    RETURN NEW;
  END IF;

  IF OLD.state = 'confirmed_in_source' AND NEW.state = 'retired' THEN
    NEW.retired_at := COALESCE(NEW.retired_at, now());
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'illegal commitment state transition % -> % on commitment %',
                  OLD.state, NEW.state, OLD.id
    USING ERRCODE = 'KY006',
          HINT = 'pending -> confirmed_in_source -> retired only; retirement is by explicit match, never by elapsed time';
END;
$$;

CREATE TRIGGER commitments_enforce_invariants
BEFORE UPDATE ON public.commitments
FOR EACH ROW EXECUTE FUNCTION public.enforce_commitment_invariants();

-- Rejected with KY006: pending -> retired, confirmed_in_source -> pending,
-- retired -> anything, and any edit to sku/location/qty/rep_id/created_at.
--
-- There is no DELETE policy on commitments (0011), so deletion is available only to the
-- table owner and service_role, never to an application user.
