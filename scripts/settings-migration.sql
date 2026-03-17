-- settings-migration.sql
-- Adds client_context JSONB column to audits table.
-- The pipeline reads client_context from prospect-config.json on disk,
-- but this column allows the dashboard Settings page to read/write
-- client context directly via Supabase without a pipeline server round-trip.

ALTER TABLE public.audits
  ADD COLUMN IF NOT EXISTS client_context JSONB;

COMMENT ON COLUMN public.audits.client_context IS
  'Business context (services, pricing, out_of_scope, etc). Pipeline reads from prospect-config.json; dashboard reads/writes here. Synced at convert-to-client time.';
