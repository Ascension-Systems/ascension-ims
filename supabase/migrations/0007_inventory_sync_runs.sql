-- 0007_inventory_sync_runs.sql
-- APPLY BY HAND, in numeric order, in the Supabase SQL editor.

CREATE TABLE public.inventory_sync_runs (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at                    timestamptz NOT NULL DEFAULT now(),
  run_by                    uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
  rows_applied              integer NOT NULL DEFAULT 0,
  overrides_preserved       integer NOT NULL DEFAULT 0,
  commitments_confirmed     integer NOT NULL DEFAULT 0,
  commitments_still_pending integer NOT NULL DEFAULT 0,
  report                    jsonb
);

ALTER TABLE public.inventory_sync_runs ENABLE ROW LEVEL SECURITY;

CREATE INDEX inventory_sync_runs_run_at_idx ON public.inventory_sync_runs (run_at DESC);

-- run_by is nullable: a service_role sync has no auth.uid(). This table is admin-readable
-- only, which gives attack 1 a second forbidden-read target beyond commitments.
