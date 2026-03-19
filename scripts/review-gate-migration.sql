-- Review Gate Migration
-- Adds opt-in review gate flag to audits table.
-- Status column is TEXT (not enum), so 'awaiting_review' needs no schema change.

-- Add review_gate_enabled flag (opt-in, defaults false)
ALTER TABLE public.audits
  ADD COLUMN IF NOT EXISTS review_gate_enabled boolean NOT NULL DEFAULT false;
