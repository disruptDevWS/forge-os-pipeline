-- 012-rerun-stability.sql
-- Adds 'deprecated' status to execution_pages, backfills source, adds index for re-run lookups.

-- 1. Drop existing CHECK constraint (verified name: execution_pages_status_check)
ALTER TABLE public.execution_pages
  DROP CONSTRAINT execution_pages_status_check;

-- 2. Add new CHECK with 'deprecated' status
ALTER TABLE public.execution_pages
  ADD CONSTRAINT execution_pages_status_check
  CHECK (status IN ('not_started','brief_ready','in_progress','review','published','deprecated'));

-- 3. Backfill source: NULL rows are from syncMichael
UPDATE public.execution_pages SET source = 'michael' WHERE source IS NULL;

-- 4. Index for re-run committed page lookups
CREATE INDEX IF NOT EXISTS idx_execution_pages_audit_status
  ON public.execution_pages(audit_id, status);
