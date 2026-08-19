-- --------------------------------------------------------------------------
-- 0003_seed_demo_delta.sql -- HAND-WRITTEN, not generated.
--
-- Apply LAST, and only AFTER at least one user has signed in.
--
-- Commitments reference profiles(id), which does not exist until the Human creates users in
-- the Supabase dashboard. This file degrades gracefully if applied too early: it raises a
-- NOTICE and does nothing, so it is safe to paste at any point and re-paste later.
--
-- It is deliberately NOT listed in supabase/config.toml's seed paths: the verification
-- harness needs SEA-9007 to start from a known 40/10 baseline with no pre-existing
-- commitment, and this file would move that baseline.
--
-- What it produces is the brief's own worked example on SEA-9007:
--   40 on hand - 10 committed in QuickBooks
--   6 more committed by reps, not yet in QuickBooks -> 24 available
-- which makes the show-both-numbers presentation demoable without any step-2 UI.
--
-- Contains no credentials of any kind.
-- --------------------------------------------------------------------------

DO $$
DECLARE v_rep uuid; v_admin uuid;
BEGIN
  SELECT id INTO v_rep   FROM public.profiles WHERE role = 'rep'   ORDER BY created_at LIMIT 1;
  SELECT id INTO v_admin FROM public.profiles WHERE role = 'admin' ORDER BY created_at LIMIT 1;

  -- Backfill the override author on the SEA-9003 fixture. The seed file could not set it:
  -- no admin profile existed at the time it was written.
  IF v_admin IS NOT NULL THEN
    UPDATE public.inventory SET override_by = v_admin
     WHERE sku = 'SEA-9003' AND override_by IS NULL;
  END IF;

  IF v_rep IS NULL THEN
    RAISE NOTICE 'No rep profile yet; skipping demo delta. Re-run after a rep signs in.';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM public.commitments) THEN
    RAISE NOTICE 'Commitments already exist; skipping demo delta.';
    RETURN;
  END IF;

  INSERT INTO public.commitments (sku, location, qty, rep_id, state, note)
  VALUES ('SEA-9007', 'default', 6, v_rep, 'pending', 'Demo delta: recorded in portal, not yet in QuickBooks');
END $$;
