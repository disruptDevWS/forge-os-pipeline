-- Scout Agent (Phase 0) — prospects table for pre-pipeline prospect discovery
CREATE TABLE IF NOT EXISTS public.prospects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  domain text NOT NULL UNIQUE,
  geo_type text NOT NULL DEFAULT 'city',
  target_geos jsonb,
  status text NOT NULL DEFAULT 'discovery',
  scout_run_at timestamptz,
  scout_output_path text,
  converted_to_audit_id uuid REFERENCES public.audits(id),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_prospects_domain ON public.prospects(domain);
CREATE INDEX IF NOT EXISTS idx_prospects_status ON public.prospects(status);
