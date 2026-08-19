-- 0006_app_settings.sql
-- APPLY BY HAND, in numeric order, in the Supabase SQL editor.

-- Singleton: the boolean primary key with CHECK (id) makes a second row impossible.
CREATE TABLE public.app_settings (
  id                  boolean PRIMARY KEY DEFAULT true CHECK (id),
  inventory_authority public.inventory_authority NOT NULL DEFAULT 'quickbooks',
  low_stock_default   integer NOT NULL DEFAULT 5   CHECK (low_stock_default >= 0),
  stale_after_minutes integer NOT NULL DEFAULT 360 CHECK (stale_after_minutes > 0),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

INSERT INTO public.app_settings (id) VALUES (true);

-- Ships in inventory_authority = 'quickbooks' mode per D4 — show both numbers, never
-- silently override. stale_after_minutes = 360 (6 hours) is the concrete "staler than a few
-- hours" threshold; it lives in the database so it is tunable without a redeploy, and the
-- app reads it rather than hard-coding it.
