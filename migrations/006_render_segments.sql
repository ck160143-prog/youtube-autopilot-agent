-- Durable media segment checkpoints. Asset bytes stay in object storage; this table stores references only.
CREATE TABLE IF NOT EXISTS public.baba_automation_segments (
  job_id UUID NOT NULL REFERENCES public.baba_automation_jobs(id) ON DELETE CASCADE,
  segment_id TEXT NOT NULL,
  segment_type TEXT NOT NULL CHECK (segment_type IN ('script','voice','scene','render')),
  sequence_no INTEGER NOT NULL CHECK (sequence_no > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','succeeded','failed')),
  input_ref TEXT,
  output_ref TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  retry_after TIMESTAMPTZ,
  last_error TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (job_id, segment_type, segment_id),
  UNIQUE (job_id, segment_type, sequence_no)
);
CREATE INDEX IF NOT EXISTS baba_automation_segments_resume
  ON public.baba_automation_segments(job_id, segment_type, status, sequence_no);
