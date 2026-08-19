-- --------------------------------------------------------------------------
-- 0002_seed_fixtures.sql -- the pinned fixtures
--
-- GENERATED FILE. Do not edit by hand -- edit scripts/generate-seed.mjs and re-run
-- `npm run seed:generate`. The generator is deterministic (mulberry32, fixed seed
-- 20260819), so regenerating produces byte-identical output.
--
-- Apply after 0001_seed_catalogue.sql.
--
-- These are deliberately awkward cases, kept in their own file so they are reviewable
-- at a glance rather than buried among 90 generated rows. They are PINNED: emitted
-- unconditionally on every run, never drawn from the PRNG.
--
--   SEA-9001  available at zero but stock incoming -> status "NONE - INCOMING"
--   SEA-9002  on_hand and available differ sharply -> available 14 out of an on-hand of 200
--   SEA-9003  admin override that contradicts the source number, attributed and timestamped (seed DATA, not step-3 editing UI)
--   SEA-9004  product name long enough to threaten a mobile layout (124 characters)
--   SEA-9005  stale row -> updated 3 days ago, past the 360-minute threshold, so the STALE badge is demonstrable
--   SEA-9006  last-unit SKU -> availability of exactly 1; the contended row in the concurrency attack
--   SEA-9007  delta-ledger baseline -> 40 on hand, 10 committed, available 30; the brief's own worked example
--
-- Contains no credentials of any kind. Timestamps are relative expressions, so the data is
-- correctly aged whenever the file is applied.
-- --------------------------------------------------------------------------


INSERT INTO public.products (sku, name, category, uom, low_stock_threshold) VALUES
  ('SEA-9001', 'Kestrel Stackable Guest Chair', 'Seating', 'EA', 10),
  ('SEA-9002', 'Meridian Contoured Mesh-Back Task Chair', 'Seating', 'EA', 20),
  ('SEA-9003', 'Halden Upholstered Executive Chair', 'Seating', 'EA', 6),
  ('SEA-9004', 'Continental Executive High-Back Ergonomic Swivel Conference Chair with Adjustable Lumbar Support and Polished Aluminium Base', 'Seating', 'EA', 4),
  ('SEA-9005', 'Fenwick Folding Bench Seat', 'Seating', 'EA', 8),
  ('SEA-9006', 'Corbel Drafting Stool', 'Seating', 'EA', 5),
  ('SEA-9007', 'Ashgrove Laminate-Top Training Table', 'Tables', 'EA', 6)
ON CONFLICT (sku) DO NOTHING;

INSERT INTO public.inventory (sku, location, qty_on_hand, qty_committed, qty_incoming, incoming_eta, source, source_payload, updated_at) VALUES
  ('SEA-9001', 'default', 0, 0, 48, current_date + 12, 'quickbooks_stub', '{"sku":"SEA-9001","location":"default","qty_on_hand":0,"qty_committed":0,"qty_incoming":48,"incoming_eta":"+12d","source":"quickbooks_stub","note":"Synthetic stub payload. Shape mirrors what the adapter returns."}'::jsonb, now() - interval '22 minutes'),
  ('SEA-9002', 'default', 200, 186, 0, NULL, 'quickbooks_stub', '{"sku":"SEA-9002","location":"default","qty_on_hand":200,"qty_committed":186,"qty_incoming":0,"incoming_eta":null,"source":"quickbooks_stub","note":"Synthetic stub payload. Shape mirrors what the adapter returns."}'::jsonb, now() - interval '41 minutes'),
  ('SEA-9004', 'default', 26, 9, 12, current_date + 21, 'quickbooks_stub', '{"sku":"SEA-9004","location":"default","qty_on_hand":26,"qty_committed":9,"qty_incoming":12,"incoming_eta":"+21d","source":"quickbooks_stub","note":"Synthetic stub payload. Shape mirrors what the adapter returns."}'::jsonb, now() - interval '8 minutes'),
  ('SEA-9005', 'default', 64, 21, 0, NULL, 'quickbooks_stub', '{"sku":"SEA-9005","location":"default","qty_on_hand":64,"qty_committed":21,"qty_incoming":0,"incoming_eta":null,"source":"quickbooks_stub","note":"Synthetic stub payload. Shape mirrors what the adapter returns."}'::jsonb, now() - interval '3 days'),
  ('SEA-9006', 'default', 1, 0, 0, NULL, 'quickbooks_stub', '{"sku":"SEA-9006","location":"default","qty_on_hand":1,"qty_committed":0,"qty_incoming":0,"incoming_eta":null,"source":"quickbooks_stub","note":"Synthetic stub payload. Shape mirrors what the adapter returns."}'::jsonb, now() - interval '15 minutes'),
  ('SEA-9007', 'default', 40, 10, 0, NULL, 'quickbooks_stub', '{"sku":"SEA-9007","location":"default","qty_on_hand":40,"qty_committed":10,"qty_incoming":0,"incoming_eta":null,"source":"quickbooks_stub","note":"Synthetic stub payload. Shape mirrors what the adapter returns."}'::jsonb, now() - interval '63 minutes')
ON CONFLICT (sku, location) DO NOTHING;

-- SEA-9003: an admin override that CONTRADICTS the source figure.
--
-- source_payload.last_source_snapshot carries what QuickBooks claimed, so both numbers
-- are on screen and the portal never silently overrides. override_note and override_at
-- are NOT NULL for an override row -- the inventory_override_is_attributed CHECK in
-- migration 0004 enforces that at the database layer rather than trusting the UI.
--
-- override_by is left NULL here because no admin user exists at seed time. It is
-- backfilled by 0003_seed_demo_delta.sql once the Human has created one.
--
-- This is seed DATA. No admin editing interface ships in this run.
INSERT INTO public.inventory (sku, location, qty_on_hand, qty_committed, qty_incoming, incoming_eta, source, source_payload, override_note, override_at, updated_at) VALUES
  ('SEA-9003', 'default', 48, 6, 0, NULL, 'manual_override',
   '{"last_source_snapshot":{"sku":"SEA-9003","location":"default","qty_on_hand":60,"qty_committed":6,"qty_incoming":0,"incoming_eta":null,"source":"quickbooks_stub"},"last_source_seen_at":"recorded at sync time"}'::jsonb,
   'Physical count on the warehouse floor found 48 units. QuickBooks reported 60 - twelve fewer are actually here. Portal figure stands until the source is corrected.',
   now() - interval '120 minutes',
   now() - interval '120 minutes')
ON CONFLICT (sku, location) DO NOTHING;
