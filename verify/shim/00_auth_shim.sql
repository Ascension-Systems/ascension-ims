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
