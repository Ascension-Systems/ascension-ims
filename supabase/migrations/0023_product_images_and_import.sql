-- 0023_product_images_and_import.sql
--
-- Two client-facing asks from the 2026-08-24 walkthrough with Levon, plus one demo-stability fix.
--
--   1. PRODUCT PHOTOS. "How do they upload a photo of maybe a piece of the furniture?" Products
--      gain an image_path pointing at an object in a new, private `product-images` bucket. The
--      bucket mirrors the documents bucket's shape: private, size-capped, MIME-allowlisted, with
--      read granted to any provisioned user and write to admins only.
--
--   2. SPREADSHEET IMPORT. "Is there even any way to link an Excel file back to this?" Their
--      catalogue lives in Excel/QuickBooks today, and their real SKUs will not match the demo's
--      invented `AAA-9999` shape. The sku format check is widened to accept a realistic SKU
--      while still refusing whitespace, control characters and unbounded length.
--
--   3. DEMO STABILITY. drift_inventory() (0018) is a random walk with a floor at zero and an
--      upward bias from landing deliveries; after days of 10-minute ticks it had pushed 95 of 97
--      lines into "in stock", which makes the new red/amber status colours invisible. It is
--      unscheduled here so the seeded spread holds through the presentation.
--      RE-ENABLE with:  SELECT cron.schedule('drift-inventory', '*/10 * * * *', $$ SELECT public.drift_inventory(); $$);

-- ---------------------------------------------------------------------------
-- 1. Product photo reference
-- ---------------------------------------------------------------------------
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS image_path text;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS product_url text;

COMMENT ON COLUMN public.products.image_path IS
  'Object name in the product-images storage bucket, or NULL. Never a URL: the bytes are served
   through /api/products/[sku]/image so auth and RLS apply on every fetch.';

-- "Maybe if you''re seeing this and you say view, you hit something else and it links back to
-- the Plantation Prestige website" (Levon, 2026-08-24). NULL where a product has no public page
-- — he flagged that not everything they sell is online — and the UI hides the link when unset.
COMMENT ON COLUMN public.products.product_url IS
  'Public product-page URL on the client website, or NULL when the product is not published.';

-- ---------------------------------------------------------------------------
-- 2. Widen the SKU format so a real spreadsheet import can land
-- ---------------------------------------------------------------------------
ALTER TABLE public.products DROP CONSTRAINT IF EXISTS products_sku_format;
ALTER TABLE public.products
  ADD CONSTRAINT products_sku_format
  CHECK (sku ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,31}$');

-- ---------------------------------------------------------------------------
-- 3. The product-images bucket
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'product-images', 'product-images', false, 10485760,
  ARRAY['image/png', 'image/jpeg', 'image/webp']
)
ON CONFLICT (id) DO UPDATE
  SET file_size_limit    = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types,
      public             = EXCLUDED.public;

-- A product photo is catalogue data: any provisioned user may read it, admins alone may write.
-- Unlike documents there is no scheduling/visibility window to mirror, so the read rule is
-- simply "are you provisioned" — the same gate that guards the catalogue itself (0013).
DROP POLICY IF EXISTS product_images_read ON storage.objects;
CREATE POLICY product_images_read ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'product-images' AND public.is_provisioned());

DROP POLICY IF EXISTS product_images_admin_write ON storage.objects;
CREATE POLICY product_images_admin_write ON storage.objects
  FOR ALL TO authenticated
  USING (bucket_id = 'product-images' AND COALESCE(public.is_admin(), false))
  WITH CHECK (bucket_id = 'product-images' AND COALESCE(public.is_admin(), false));

-- ---------------------------------------------------------------------------
-- 4. Admins may correct catalogue rows (name, category, threshold, photo).
--    "How do I modify that? How do I change that?" — products had no UPDATE policy at all,
--    so the catalogue was read-only to everyone including admins.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS products_admin_write ON public.products;
CREATE POLICY products_admin_write ON public.products
  FOR ALL TO authenticated
  USING (COALESCE(public.is_admin(), false))
  WITH CHECK (COALESCE(public.is_admin(), false));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.products TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. Hold the demo distribution still
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  PERFORM cron.unschedule('drift-inventory');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

NOTIFY pgrst, 'reload schema';
