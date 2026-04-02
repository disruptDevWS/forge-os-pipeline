-- Migration 013: Add performance_tracking_enabled to audits
-- Opt-in toggle for monthly cron performance tracking (cost control).
-- Default false = no existing audits are enrolled until explicitly toggled on.

ALTER TABLE public.audits
  ADD COLUMN IF NOT EXISTS performance_tracking_enabled BOOLEAN NOT NULL DEFAULT false;
