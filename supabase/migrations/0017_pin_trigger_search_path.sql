-- ============================================================================
-- 0017_pin_trigger_search_path.sql — hardening from the pen test
--
-- Two trigger functions were SECURITY INVOKER with no pinned search_path. Not
-- exploitable (INVOKER functions run with the caller's own privileges, so there is
-- no definer-rights escalation), but every other function in the schema pins its
-- search_path and a clean audit wants no exceptions. Bodies are unchanged.
-- Written, NOT applied — paste into the Supabase SQL editor.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_commitment_invariants()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  -- A commitment's identity is immutable. Without this, "retirement" could be faked by
  -- rewriting qty to 0, or the row repointed at a different SKU.
  IF NEW.sku <> OLD.sku
     OR NEW.location   <> OLD.location
     OR NEW.qty        <> OLD.qty
     OR NEW.rep_id     <> OLD.rep_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'commitment % is immutable in sku/location/qty/rep_id/created_at', OLD.id
      USING ERRCODE = 'KY006';
  END IF;

  IF NEW.state = OLD.state THEN
    RETURN NEW;
  END IF;

  IF OLD.state = 'pending' AND NEW.state = 'confirmed_in_source' THEN
    NEW.confirmed_at := COALESCE(NEW.confirmed_at, now());
    RETURN NEW;
  END IF;

  IF OLD.state = 'confirmed_in_source' AND NEW.state = 'retired' THEN
    NEW.retired_at := COALESCE(NEW.retired_at, now());
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'illegal commitment state transition % -> % on commitment %',
                  OLD.state, NEW.state, OLD.id
    USING ERRCODE = 'KY006',
          HINT = 'pending -> confirmed_in_source -> retired only; retirement is by explicit match, never by elapsed time';
END;
$$;
