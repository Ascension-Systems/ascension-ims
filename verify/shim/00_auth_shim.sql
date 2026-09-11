-- LOCAL VERIFICATION ONLY. This file lives in verify/shim/ and NOT in supabase/migrations/.
-- It must never be pasted into the hosted SQL editor -- Supabase already provides all of it.
--
-- Without the Supabase stack there is no auth schema, no auth.users, no auth.uid(), and none
-- of the three database roles. Every migration would fail on the first foreign key to
-- auth.users(id). This supplies the minimum, and is applied BEFORE the migrations.

CREATE SCHEMA IF NOT EXISTS auth;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')          THEN CREATE ROLE anon          NOLOGIN NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role')  THEN CREATE ROLE service_role  NOLOGIN NOINHERIT BYPASSRLS; END IF;
END $$;

CREATE TABLE IF NOT EXISTS auth.users (
  id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL
);

-- Mirrors Supabase's real implementation: read the claim the request set, not a session var
-- the application chose. Same signature, same STABLE volatility, same NULL-when-absent
-- behaviour.
--
-- The NULLIF around current_setting (not just around the extracted claim) is load-bearing and
-- matches Supabase's own definition: the GUC can legitimately be the empty string once it has
-- been set and cleared in a session, and ''::jsonb raises 22P02 rather than yielding NULL.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid;
$$;

CREATE OR REPLACE FUNCTION auth.role() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
$$;

CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
$$;

GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT SELECT ON auth.users TO service_role;

-- ============================================================================
-- STORAGE. Same LOCAL-VERIFICATION-ONLY banner as the auth surface above: this
-- must never be pasted into the hosted SQL editor, where Supabase Storage owns
-- these objects.
--
-- WHY THIS IS HERE. 0015_documents.sql:134 and 0023_product_images_and_import.sql:48
-- INSERT INTO storage.buckets, and both then CREATE POLICY ... ON storage.objects.
-- bootstrap() applies each migration file as a single multi-statement query, so a
-- missing storage schema failed those two files WHOLE -- which silently took
-- 0024_inventory_admin_insert.sql's effects out of every local run's premise and,
-- because the failure aborted bootstrap, meant the four attacks under verify/
-- had not executed at all.
--
-- MINIMUM SURFACE, NOT A REIMPLEMENTATION. This supplies only what the migrations
-- reference. It deliberately does NOT model Supabase Storage's behaviour: no object
-- lifecycle, no signed URLs, no HTTP layer. A local pass here is a statement about
-- POLICY LOGIC, exactly as PATH_CAVEAT says, and never about Storage itself.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS storage;

-- `id text PRIMARY KEY` is load-bearing: 0015:139 and 0023:53 both use
-- ON CONFLICT (id), which requires a unique index on that column to infer.
CREATE TABLE IF NOT EXISTS storage.buckets (
  id                 text PRIMARY KEY,
  name               text NOT NULL,
  public             boolean NOT NULL DEFAULT false,
  file_size_limit    bigint,
  allowed_mime_types text[],
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS storage.objects (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id  text REFERENCES storage.buckets (id),
  name       text,
  owner      uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  metadata   jsonb
);

-- Supabase ships both tables with RLS ENABLED. Without this the policies in 0015 and
-- 0023 would be created and then not enforced, which is the worst of both worlds: a
-- policy assertion could pass for the wrong reason.
ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;
GRANT SELECT ON storage.buckets TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO authenticated, service_role;
GRANT SELECT ON storage.objects TO anon;
