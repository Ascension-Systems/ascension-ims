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

-- ----------------------------------------------------------------------------
-- storage — the minimum Supabase Storage surface migrations 0015 and 0023 reference:
-- the buckets table they INSERT into, and the objects table they attach RLS policies to.
-- Column names match Supabase's storage schema for the columns the migrations use. This is
-- enough to APPLY the policies and assert them with SQL; it does not emulate the Storage API.
-- ----------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS storage;

CREATE TABLE IF NOT EXISTS storage.buckets (
  id                 text PRIMARY KEY,
  name               text NOT NULL,
  public             boolean DEFAULT false,
  file_size_limit    bigint,
  allowed_mime_types text[]
);

CREATE TABLE IF NOT EXISTS storage.objects (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id  text REFERENCES storage.buckets (id),
  name       text,
  owner      uuid,
  metadata   jsonb,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO authenticated, service_role;
GRANT SELECT ON storage.buckets TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- cron — pg_cron is not available in the embedded server. Migration 0018 runs
-- `CREATE EXTENSION IF NOT EXISTS pg_cron`, which the harness removes on the local path
-- only (reported in the run header), then calls cron.schedule / cron.unschedule. These stubs
-- record the calls so a test can assert what WOULD be scheduled. Nothing ever runs.
-- ----------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS cron;

CREATE TABLE IF NOT EXISTS cron.job (
  jobid    bigserial PRIMARY KEY,
  jobname  text UNIQUE,
  schedule text,
  command  text
);

CREATE OR REPLACE FUNCTION cron.schedule(p_jobname text, p_schedule text, p_command text)
RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO cron.job (jobname, schedule, command) VALUES (p_jobname, p_schedule, p_command)
  ON CONFLICT (jobname) DO UPDATE SET schedule = EXCLUDED.schedule, command = EXCLUDED.command
  RETURNING jobid;
$$;

CREATE OR REPLACE FUNCTION cron.unschedule(p_jobname text)
RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM cron.job WHERE jobname = p_jobname;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'could not find valid entry for job ''%''', p_jobname;
  END IF;
  RETURN true;
END;
$$;
