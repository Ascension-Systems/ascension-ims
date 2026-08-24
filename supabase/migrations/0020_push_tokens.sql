-- 0020_push_tokens.sql — device tokens for APNs push notifications.
--
-- One row per (user, device). The token is Apple's opaque device token; it rotates whenever
-- Apple decides, so rows are upserted on every app start and deleted when APNs reports the
-- token dead (410 / Unregistered). Nothing in this table is secret — a token is only usable
-- with the team's APNs auth key, which lives server-side only — but the table still tells you
-- who has the app installed, so reads are locked to the owner and service_role.

CREATE TABLE public.push_tokens (
  token      text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  platform   text NOT NULL DEFAULT 'ios' CHECK (platform IN ('ios', 'android', 'web')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX push_tokens_user_idx ON public.push_tokens (user_id);

ALTER TABLE public.push_tokens ENABLE ROW LEVEL SECURITY;

-- The owner manages their own device rows; the server (service_role) reads for fan-out and
-- deletes dead tokens. No cross-user visibility of any kind.
CREATE POLICY push_tokens_select_own ON public.push_tokens
  FOR SELECT USING (user_id = auth.uid());
CREATE POLICY push_tokens_insert_own ON public.push_tokens
  FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY push_tokens_update_own ON public.push_tokens
  FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY push_tokens_delete_own ON public.push_tokens
  FOR DELETE USING (user_id = auth.uid());
