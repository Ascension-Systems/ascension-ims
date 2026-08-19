-- --------------------------------------------------------------------------
-- verify/00-setup.sql — deterministic verification fixtures.
--
-- LOCAL VERIFICATION ONLY. Never pasted into the hosted SQL editor.
--
-- Fixed UUIDs so every assertion can name a row and a re-run is reproducible.
--
-- Two identities. NO PASSWORDS ANYWHERE: this system uses magic links and has none.
-- example.invalid is a reserved, non-routable TLD — these addresses cannot receive mail and
-- cannot be mistaken for a real person's.
-- --------------------------------------------------------------------------

INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-4000-8000-000000000001', 'rep.verify@example.invalid'),
  ('00000000-0000-4000-8000-000000000002', 'admin.verify@example.invalid')
ON CONFLICT (id) DO NOTHING;

-- Under Path A the on_auth_user_created trigger has already made these profiles; under
-- Path B it has too (the shim provides auth.users). Belt and braces for either path:
INSERT INTO public.profiles (id, email, role)
SELECT u.id, u.email, 'rep'
  FROM auth.users u
 WHERE u.id IN ('00000000-0000-4000-8000-000000000001',
                '00000000-0000-4000-8000-000000000002')
ON CONFLICT (id) DO NOTHING;

-- Promote the second one. There is no self-service path to admin anywhere in the
-- application; this is the same UPDATE the Human runs in the SQL editor.
UPDATE public.profiles SET role = 'admin'
 WHERE id = '00000000-0000-4000-8000-000000000002';

-- The last-unit test SKU is SEA-9006, pinned by the seed generator with
-- qty_on_hand = 1, qty_committed = 0, qty_incoming = 0 — availability of exactly 1.
