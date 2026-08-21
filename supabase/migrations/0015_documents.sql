-- ============================================================================
-- 0015_documents.sql — the document distribution hub
--
-- The client's other half: one mobile place for current PROMOTIONS (flyers),
-- SPEC SHEETS and price sheets, replacing the Dropbox / weekly-email scatter.
-- Reps VIEW ONLY; admins manage.
--
-- FILES LIVE IN A PRIVATE BUCKET. Nothing is ever served from a public URL.
-- Access is a SHORT-LIVED SIGNED URL minted only after the row's RLS SELECT has
-- already authorised the caller, and the storage bucket carries its OWN RLS so a
-- guessed object path is refused even if the app layer were bypassed. Two gates,
-- same predicate: provisioned to read, admin to write.
--
-- Written, NOT applied. The Human pastes this into the Supabase SQL editor.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. The catalogue row. The file's bytes are in storage; this is the metadata
--    the app lists and searches, plus the pointer (storage_path) into the bucket.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL CHECK (kind IN ('promotion','spec_sheet','flyer','price_sheet')),
  title         text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  description   text CHECK (description IS NULL OR char_length(description) <= 1000),
  -- Optional link to a product. ON DELETE SET NULL: retiring a product must not
  -- silently delete its spec sheet.
  product_sku   text REFERENCES public.products(sku) ON DELETE SET NULL,
  storage_path  text NOT NULL UNIQUE,
  -- Allowlist enforced in the DB as well as the upload API. A type not on this
  -- list cannot be recorded even by a direct PostgREST insert.
  mime_type     text NOT NULL CHECK (mime_type IN (
                  'application/pdf','image/png','image/jpeg','image/webp')),
  size_bytes    bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 26214400), -- 25 MiB
  -- active + an optional window drive what reps see. A promotion outside its
  -- window is retained (history) but not shown as current.
  active        boolean NOT NULL DEFAULT true,
  starts_at     timestamptz,
  ends_at       timestamptz,
  uploaded_by   uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at >= starts_at)
);

CREATE INDEX IF NOT EXISTS documents_kind_idx ON public.documents (kind, active, created_at DESC);
CREATE INDEX IF NOT EXISTS documents_sku_idx  ON public.documents (product_sku);

ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;

-- Provisioned accounts (rep or admin) may READ. Same predicate as products/inventory,
-- so an unprovisioned signup or a raw anon token sees nothing.
DROP POLICY IF EXISTS documents_select_provisioned ON public.documents;
CREATE POLICY documents_select_provisioned ON public.documents
  FOR SELECT TO authenticated
  USING (public.is_provisioned());

-- Only admins may write (insert/update/delete) over PostgREST. The upload API adds
-- validation on top; this is the floor a direct API call cannot get under.
-- COALESCE so a NULL from is_admin() is deny, not "unknown".
DROP POLICY IF EXISTS documents_admin_write ON public.documents;
CREATE POLICY documents_admin_write ON public.documents
  FOR ALL TO authenticated
  USING (COALESCE(public.is_admin(), false))
  WITH CHECK (COALESCE(public.is_admin(), false));

-- updated_at maintenance.
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS documents_set_updated_at ON public.documents;
CREATE TRIGGER documents_set_updated_at
  BEFORE UPDATE ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 2. The private storage bucket + its own RLS. public=false means there is no
--    unauthenticated URL for these bytes at all; every fetch is a signed URL.
-- ----------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public)
VALUES ('documents', 'documents', false)
ON CONFLICT (id) DO NOTHING;

-- Provisioned accounts may READ objects (which is what lets them mint a signed URL);
-- admins may write. The predicate matches the table, so the two layers cannot drift.
DROP POLICY IF EXISTS documents_obj_read ON storage.objects;
CREATE POLICY documents_obj_read ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'documents' AND public.is_provisioned());

DROP POLICY IF EXISTS documents_obj_admin_write ON storage.objects;
CREATE POLICY documents_obj_admin_write ON storage.objects
  FOR ALL TO authenticated
  USING (bucket_id = 'documents' AND COALESCE(public.is_admin(), false))
  WITH CHECK (bucket_id = 'documents' AND COALESCE(public.is_admin(), false));
