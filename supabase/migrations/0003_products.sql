-- 0003_products.sql
-- APPLY BY HAND, in numeric order, in the Supabase SQL editor.

CREATE TABLE public.products (
  sku                 text PRIMARY KEY,
  name                text NOT NULL,
  category            text NOT NULL,
  uom                 text NOT NULL DEFAULT 'EA',
  low_stock_threshold integer NOT NULL DEFAULT 5 CHECK (low_stock_threshold >= 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT products_sku_format    CHECK (sku ~ '^[A-Z]{3}-[0-9]{4}$'),
  CONSTRAINT products_name_nonempty CHECK (length(btrim(name)) > 0)
);

ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;

CREATE INDEX products_category_idx ON public.products (category);
CREATE INDEX products_name_idx     ON public.products (lower(name));

-- low_stock_threshold is per-product because "low" means different things for a 4-unit
-- conference table and a 400-unit stacking chair. The seed generator sets it per product;
-- app_settings.low_stock_default supplies the default for rows that do not set one.
--
-- No pg_trgm index: the catalogue is ~97 rows and search runs client-side. Adding one later
-- is a one-line migration.
