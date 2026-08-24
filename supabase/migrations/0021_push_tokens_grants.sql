-- 0021_push_tokens_grants.sql — the GRANT that 0020 omitted, plus a format CHECK.
--
-- 0012 did `ALTER DEFAULT PRIVILEGES ... REVOKE ALL ON TABLES FROM anon, authenticated`, so
-- EVERY table created after it needs an explicit grant (0014/0015/0019 all do). 0020 created
-- push_tokens with RLS policies but NO grant, so the `authenticated` role held zero table
-- privileges — PostgREST hid the table entirely (PGRST205) and every device registration
-- failed. The RLS policies were never even reached. This restores the intended behaviour:
-- the policies (user_id = auth.uid()) are the gate, and the grant lets the role reach them.

GRANT SELECT, INSERT, UPDATE, DELETE ON public.push_tokens TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.push_tokens TO service_role;

-- Scope the policies to `authenticated` explicitly (they defaulted to PUBLIC, which is harmless
-- only while anon holds no grant — make it not depend on that).
DROP POLICY IF EXISTS push_tokens_select_own ON public.push_tokens;
DROP POLICY IF EXISTS push_tokens_insert_own ON public.push_tokens;
DROP POLICY IF EXISTS push_tokens_update_own ON public.push_tokens;
DROP POLICY IF EXISTS push_tokens_delete_own ON public.push_tokens;

CREATE POLICY push_tokens_select_own ON public.push_tokens
  FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY push_tokens_insert_own ON public.push_tokens
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY push_tokens_update_own ON public.push_tokens
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY push_tokens_delete_own ON public.push_tokens
  FOR DELETE TO authenticated USING (user_id = auth.uid());

-- Defence in depth against a hostile client banking junk device tokens: the shape is enforced
-- in the DB, not only in the route handler. Generous bounds (real APNs tokens are ~64–200 hex)
-- so a legitimate device is never rejected — the per-user row cap in /api/push/register is what
-- bounds volume; this only rejects non-token garbage.
ALTER TABLE public.push_tokens
  ADD CONSTRAINT push_tokens_token_format CHECK (token ~ '^[0-9a-fA-F]{16,512}$');
