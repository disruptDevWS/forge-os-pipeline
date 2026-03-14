-- QA Agent: audit_qa_results table
-- Run this migration against the Supabase project to enable QA tracking.

CREATE TABLE IF NOT EXISTS audit_qa_results (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  audit_id UUID REFERENCES audits(id) ON DELETE CASCADE,
  phase TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('pass', 'enhance', 'fail')),
  checks JSONB DEFAULT '[]',
  feedback TEXT DEFAULT '',
  attempt_number INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Index for fast lookups by audit
CREATE INDEX IF NOT EXISTS idx_audit_qa_results_audit_id ON audit_qa_results(audit_id);
CREATE INDEX IF NOT EXISTS idx_audit_qa_results_phase ON audit_qa_results(audit_id, phase);

-- RLS: service role only (pipeline writes, dashboard reads)
ALTER TABLE audit_qa_results ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access" ON audit_qa_results
  FOR ALL USING (true) WITH CHECK (true);
