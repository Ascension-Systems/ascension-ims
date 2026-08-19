-- 0002_profiles_and_role_helpers.sql
-- APPLY BY HAND, in numeric order, in the Supabase SQL editor.

CREATE TABLE public.profiles (
  id         uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  email      text NOT NULL,
  role       public.app_role NOT NULL DEFAULT 'rep',
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE INDEX profiles_role_idx ON public.profiles (role);

-- Role lives in public.profiles.role, in the database. It is NEVER read from anything the
-- client sends: not a request body, not a header, not localStorage, not a query parameter,
-- and not a custom JWT claim. The only trusted input is auth.uid(), which PostgREST derives
-- from the Supabase-signed JWT and which the client cannot forge.

-- SECURITY DEFINER is REQUIRED here. This function is called from inside the RLS policies
-- on public.profiles itself. A SECURITY INVOKER function would re-enter those policies and
-- recurse (error 42P17: infinite recursion detected in policy). This is the single most
-- common Supabase RLS footgun and the reason this function exists at all.
CREATE OR REPLACE FUNCTION public.app_role()
RETURNS public.app_role
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p.role FROM public.profiles p WHERE p.id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(public.app_role() = 'admin', false);
$$;

-- auth.uid() works correctly inside a SECURITY DEFINER function: it reads the
-- request.jwt.claims GUC that PostgREST sets per request, and SECURITY DEFINER changes the
-- executing role, not the GUC.

------------------------------------------------------------------------------
-- Profile provisioning
------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, role)
  VALUES (NEW.id, NEW.email, 'rep')
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Belt and braces. Some Supabase projects refuse a trigger on auth.users depending on
-- project age and grants. If the CREATE TRIGGER above fails when the Human applies it, this
-- is the fallback: app/auth/callback/route.ts calls it once after a successful verify.
--
-- It is idempotent and CANNOT downgrade an existing admin, because it is ON CONFLICT DO
-- NOTHING and never DO UPDATE. Writing "ON CONFLICT (id) DO UPDATE SET role = 'rep'" here
-- would be a privilege-downgrade bug and a trivial denial-of-service against admins.
-- Do not write one.
CREATE OR REPLACE FUNCTION public.ensure_profile()
RETURNS public.profiles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.profiles;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = 'KY002';
  END IF;

  INSERT INTO public.profiles (id, email, role)
  SELECT u.id, u.email, 'rep' FROM auth.users u WHERE u.id = v_uid
  ON CONFLICT (id) DO NOTHING;

  SELECT * INTO v_row FROM public.profiles WHERE id = v_uid;
  RETURN v_row;
END;
$$;

-- Role assignment. Everyone provisions as 'rep'. Admins are promoted by the Human running
--   UPDATE public.profiles SET role = 'admin' WHERE email = '…';
-- in the SQL editor. There is no self-service path to 'admin' anywhere in the application,
-- and no role value is ever accepted from a request. README.md documents this.
