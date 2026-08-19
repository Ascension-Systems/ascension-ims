-- 0004_inventory.sql
-- APPLY BY HAND, in numeric order, in the Supabase SQL editor.

CREATE TABLE public.inventory (
  sku            text NOT NULL REFERENCES public.products (sku) ON DELETE CASCADE,
  location       text NOT NULL DEFAULT 'default',
  qty_on_hand    integer NOT NULL DEFAULT 0,
  qty_committed  integer NOT NULL DEFAULT 0 CHECK (qty_committed >= 0),
  qty_incoming   integer NOT NULL DEFAULT 0 CHECK (qty_incoming  >= 0),
  incoming_eta   date,
  source         public.inventory_source NOT NULL DEFAULT 'quickbooks_stub',
  source_payload jsonb,
  override_note  text,
  override_by    uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
  override_at    timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now(),

  -- available FROM THE SOURCE ONLY. The portal delta is applied in the view (0008), never
  -- stored here, because it is a live aggregate over the commitments ledger.
  qty_available_source integer
    GENERATED ALWAYS AS (qty_on_hand - qty_committed) STORED,

  PRIMARY KEY (sku, location),

  CONSTRAINT inventory_incoming_eta_needs_qty
    CHECK (incoming_eta IS NULL OR qty_incoming > 0),

  -- Enforces "overrides are visible as overrides, with who and when" at the database layer
  -- rather than trusting the UI to fill the fields in.
  CONSTRAINT inventory_override_is_attributed
    CHECK (source <> 'manual_override'
           OR (override_note IS NOT NULL AND override_at IS NOT NULL))
);

ALTER TABLE public.inventory ENABLE ROW LEVEL SECURITY;

CREATE INDEX inventory_updated_at_idx ON public.inventory (updated_at);
CREATE INDEX inventory_available_idx  ON public.inventory (qty_available_source);
CREATE INDEX inventory_source_idx     ON public.inventory (source);

-- There is deliberately NO qty_on_hand >= 0 constraint. QuickBooks can and does report a
-- negative on-hand figure when invoices outrun receipts. Rejecting real source data at the
-- constraint layer would make the sync fail on exactly the rows most worth looking at.
-- Negative on-hand is displayed honestly rather than clamped.
--
-- override_by is nullable because the seed fixture is authored before any admin user exists.
-- The note and timestamp are not nullable for an override row — the CHECK sees to that.
