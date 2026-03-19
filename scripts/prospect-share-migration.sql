-- Prospect Share Token migration
-- Adds share_token + scout data columns to prospects table

ALTER TABLE public.prospects
  ADD COLUMN IF NOT EXISTS share_token UUID DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS share_token_created_at TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS brand_favicon_url TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS scout_markdown TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS scout_scope_json JSONB DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS prospect_narrative TEXT DEFAULT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS prospects_share_token_idx
  ON public.prospects (share_token)
  WHERE share_token IS NOT NULL;
