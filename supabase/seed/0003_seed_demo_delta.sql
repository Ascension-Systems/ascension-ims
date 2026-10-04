-- --------------------------------------------------------------------------
-- 0003_seed_demo_delta.sql -- HAND-WRITTEN, not generated.
--
-- Apply LAST, and only AFTER the real admin has signed in.
--
-- Since 0025 the portal records no commitments, so this file no longer creates the "demo
-- delta" (a rep commitment on SEA-9007 that QuickBooks had not seen). The filename is kept so
-- existing run instructions still point at it. What remains is attribution: SEA-9003's seeded
-- manual override is credited to the earliest admin profile.
--
-- Degrades gracefully if applied too early: with no admin profile it raises a NOTICE and does
-- nothing, so it is safe to paste at any point and re-paste later.
--
-- It is deliberately NOT listed in supabase/config.toml's seed paths. Run order still matters
-- for one reason: the earliest admin is the one credited, so a verification test admin
-- created first would be credited instead (and SEA-9003 would lose attribution when the test
-- admin is removed — profiles ON DELETE SET NULL). `npm run verify:identities` refuses to run
-- until SEA-9003 is attributed.
--
-- Contains no credentials of any kind.
-- --------------------------------------------------------------------------

DO $$
DECLARE v_admin uuid;
BEGIN
  SELECT id INTO v_admin FROM public.profiles WHERE role = 'admin' ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE NOTICE 'No admin profile yet; skipping. Re-run after the admin signs in.';
    RETURN;
  END IF;
  UPDATE public.inventory SET override_by = v_admin
   WHERE sku = 'SEA-9003' AND override_by IS NULL;
END $$;
