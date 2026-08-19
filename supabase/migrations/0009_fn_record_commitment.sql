-- 0009_fn_record_commitment.sql — the concurrency-controlled write path
-- APPLY BY HAND, in numeric order, in the Supabase SQL editor.
--
-- MECHANISM: SELECT … FOR UPDATE on the inventory row, inside a SECURITY DEFINER plpgsql
-- function, exposed as a PostgREST RPC.
--
-- The row lock is taken on inventory(sku, location) — the exact contended resource — BEFORE
-- the availability figure is read. Every concurrent caller for the same SKU serialises
-- behind it; callers for different SKUs never block each other.
--
-- Why this and not the alternatives:
--   * Not a serializable transaction. SET TRANSACTION ISOLATION LEVEL SERIALIZABLE must be
--     the first statement in a transaction; inside a PostgREST-invoked function the
--     transaction has already begun. It would also surface as 40001 and oblige every caller
--     to implement retry logic.
--   * Not a CHECK constraint on a derived total. A CHECK cannot reference other rows, so it
--     would need a denormalised counter maintained by a trigger: same guarantee, a second
--     source of truth for a derivable number.
--   * Not an advisory lock. hashtext collisions make unrelated SKUs contend, and — deciding
--     the matter — an advisory lock does NOT conflict with a plain UPDATE of the inventory
--     row, so a sync writing a new baseline would run straight through it. FOR UPDATE takes
--     the real row lock apply_inventory_sync also needs, serialising commit-versus-sync as
--     well as commit-versus-commit.
--
-- FORBIDDEN: reading availability from v_inventory (or from the client) and then inserting.
-- A naive read-then-write passes every single-user test and fails the concurrency attack.

CREATE OR REPLACE FUNCTION public.record_commitment(
  p_sku      text,
  p_qty      integer,
  p_location text DEFAULT 'default',
  p_note     text DEFAULT NULL
)
RETURNS public.commitments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid       uuid := auth.uid();
  v_inv       public.inventory%ROWTYPE;
  v_pending   integer;
  v_available integer;
  v_row       public.commitments;
BEGIN
  -- Identity comes from the signed JWT and nowhere else. NOTE: there is deliberately no
  -- p_rep_id parameter. A caller cannot record a commitment on another rep's behalf,
  -- which is what keeps this SECURITY DEFINER function from being an RLS bypass.
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = 'KY002';
  END IF;

  IF p_qty IS NULL OR p_qty <= 0 THEN
    RAISE EXCEPTION 'quantity must be a positive integer' USING ERRCODE = 'KY004';
  END IF;

  -- (1) TAKE THE LOCK FIRST. This is the whole mechanism. It serialises against other
  --     record_commitment calls for this SKU and against apply_inventory_sync, which
  --     UPDATEs the same row. Exactly one row is locked per call, so no deadlock is
  --     possible from this function.
  SELECT * INTO v_inv
  FROM public.inventory
  WHERE sku = p_sku AND location = p_location
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'no inventory row for sku % at location %', p_sku, p_location
      USING ERRCODE = 'KY005';
  END IF;

  -- (2) Recompute the ledger INSIDE the lock. Never trust a client-supplied availability
  --     figure, and never read this before the lock is held.
  SELECT COALESCE(SUM(c.qty), 0) INTO v_pending
  FROM public.commitments c
  WHERE c.sku = p_sku AND c.location = p_location AND c.state = 'pending';

  v_available := v_inv.qty_on_hand - v_inv.qty_committed - v_pending;

  IF p_qty > v_available THEN
    RAISE EXCEPTION
      'insufficient availability for % at %: requested %, available %',
      p_sku, p_location, p_qty, GREATEST(v_available, 0)
      USING ERRCODE = 'KY001',
            HINT    = 'INSUFFICIENT_AVAILABILITY';
  END IF;

  INSERT INTO public.commitments (sku, location, qty, rep_id, state, note)
  VALUES (p_sku, p_location, p_qty, v_uid, 'pending', p_note)
  RETURNING * INTO v_row;

  RETURN v_row;
  -- The lock is released at COMMIT, which PostgREST issues when the RPC returns.
END;
$$;
