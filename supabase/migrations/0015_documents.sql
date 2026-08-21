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
-- guessed object path is refused even if the app layer were bypassed. Both the
-- table and the bucket enforce the SAME rule in their policy predicate: admin sees
-- all; a rep sees only documents that are active and inside their start/end window;
-- write is admin-only. Visibility is not left to app code (see the READ policy note).
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

-- Base table privilege. RLS decides WHICH rows; the role still needs the table grant to see
-- any at all. SELECT only for authenticated (reps + admins read) -- writes go through the
-- service role in the upload API, mirroring public.commitments in 0012. anon gets nothing.
GRANT SELECT ON public.documents TO authenticated;

-- READ is scoped by VISIBILITY, not merely provisioning. This is the fix for the audit
-- finding: "Hidden from reps" (active=false) and a promotion's start/end window are things
-- the client relies on to keep embargoed/withdrawn material away from ~100 external reps, so
-- they MUST live in the policy predicate, not only in the app's read helpers. The anon key
-- ships to every browser and each rep holds a valid JWT, so anything the app-layer filter
-- alone hides is still reachable by a rep calling PostgREST/storage directly.
--   * An ADMIN sees every row (to manage hidden/scheduled/expired ones).
--   * A REP sees only rows that are active AND currently inside any start/end window.
-- An unprovisioned signup or raw anon token still sees nothing (is_provisioned() is false).
DROP POLICY IF EXISTS documents_select_provisioned ON public.documents;
DROP POLICY IF EXISTS documents_select_visible ON public.documents;
CREATE POLICY documents_select_visible ON public.documents
  FOR SELECT TO authenticated
  USING (
    COALESCE(public.is_admin(), false)
    OR (
      public.is_provisioned()
      AND active
      AND (starts_at IS NULL OR starts_at <= now())
      AND (ends_at   IS NULL OR ends_at   >= now())
    )
  );

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

-- Is the object at this storage path backed by a document a REP is allowed to see right now?
-- SECURITY DEFINER so the storage policy can consult public.documents without RLS recursion,
-- and so the visibility rule lives in exactly ONE place used by both the table and the bucket.
CREATE OR REPLACE FUNCTION public.is_document_visible(object_path text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.documents d
    WHERE d.storage_path = object_path
      AND d.active
      AND (d.starts_at IS NULL OR d.starts_at <= now())
      AND (d.ends_at   IS NULL OR d.ends_at   >= now())
  );
$$;

REVOKE EXECUTE ON FUNCTION public.is_document_visible(text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.is_document_visible(text) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 2. The private storage bucket + its own RLS. public=false means there is no
--    unauthenticated URL for these bytes at all; every fetch is a signed URL.
--    file_size_limit + allowed_mime_types make the 25 MiB cap and the type
--    allowlist hold at the storage layer too, not only in the upload API.
-- ----------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'documents', 'documents', false, 26214400,
  ARRAY['application/pdf', 'image/png', 'image/jpeg', 'image/webp']
)
ON CONFLICT (id) DO UPDATE
  SET file_size_limit    = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types,
      public             = EXCLUDED.public;

-- Object READ mirrors the table's VISIBILITY rule, so the two layers cannot drift and the
-- direct-storage-API path (rep with anon key + own JWT) is closed: an admin may read any
-- object; a rep may read an object ONLY if a currently-visible document row points at it.
-- Hidden, scheduled, expired and orphaned files therefore have no reachable object for a rep.
DROP POLICY IF EXISTS documents_obj_read ON storage.objects;
CREATE POLICY documents_obj_read ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'documents'
    AND (
      COALESCE(public.is_admin(), false)
      OR (public.is_provisioned() AND public.is_document_visible(name))
    )
  );

DROP POLICY IF EXISTS documents_obj_admin_write ON storage.objects;
CREATE POLICY documents_obj_admin_write ON storage.objects
  FOR ALL TO authenticated
  USING (bucket_id = 'documents' AND COALESCE(public.is_admin(), false))
  WITH CHECK (bucket_id = 'documents' AND COALESCE(public.is_admin(), false));
