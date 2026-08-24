-- 0022_drop_auto_provision_trigger.sql — close the self-registration read hole for good.
--
-- THE PROBLEM: 0002 installed `on_auth_user_created`, which fires `handle_new_user()` to insert
-- a role='rep' profile for EVERY auth.users row. 0013 then re-gated products/inventory reads on
-- `is_provisioned()` = "a profiles row with role rep|admin exists", promising a self-registered
-- stranger "sees nothing at all ... rather than depending on a dashboard toggle staying set."
-- That promise was false: because the trigger manufactures the profile at signup, a stranger who
-- hits GoTrue's public /signup (with the anon key, bypassing the app's shouldCreateUser:false)
-- becomes "provisioned" and can read the full catalogue + live inventory over PostgREST.
--
-- THE FIX: drop the trigger. Provisioning then flows ONLY through claim_enrollment (0016), which
-- inserts the profile itself with the role taken from the invite — so a bare signup with no
-- matching invite gets no profile and is_provisioned() is false, exactly as 0013 intended. This
-- no longer depends on the "Enable email signups" dashboard toggle.
--
-- SAFE: existing profiles are untouched; the real onboarding path (admin.createUser -> claim_
-- enrollment) still provisions because claim_enrollment does its own INSERT ... ON CONFLICT.

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

-- handle_new_user() is left in place but now unreferenced. It is intentionally NOT dropped here:
-- removing it is a separate, reversible cleanup, and keeping it avoids touching a SECURITY
-- DEFINER function in the same change that closes the hole. It has no trigger, so it never runs.
