-- Operation log: granular audit trail for HubSpot API calls and LLM operations.
-- Provides per-operation visibility into contacts, companies, tasks, and AI calls.
-- Run in Supabase SQL Editor after 007_sync_log.sql.

CREATE TABLE IF NOT EXISTS public.operation_log (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Discriminator: what kind of thing was being operated on
  -- 'contact' | 'company' | 'task' | 'llm_call'
  entity_type   TEXT NOT NULL,

  -- What action was taken:
  --   contact/company/task: 'create' | 'update' | 'delete'
  --   llm_call: 'generate_summary' | 'extract_date' | 'recommend_touch' |
  --             'extract_metadata' | 'generate_drafts' | 'generate_email_drafts' |
  --             'extract_contact_from_email' | 'generate_activity_note'
  operation     TEXT NOT NULL,

  entity_id     TEXT,            -- HubSpot ID or internal ID (nullable)
  entity_name   TEXT,            -- Display name, e.g. "John Doe" or "Acme Corp" (nullable)

  status        TEXT NOT NULL CHECK (status IN ('success', 'error')),

  http_status_code  INTEGER,     -- HTTP response code from external API, if applicable
  error_code        TEXT,        -- API error code string, e.g. "CONFLICT", "RATE_LIMIT"
  error_message     TEXT,        -- Full human-readable error message

  response_summary  TEXT,        -- Brief success description, e.g. "Created contact John Doe (ID: 123)"

  metadata      JSONB NOT NULL DEFAULT '{}',  -- Extra structured data (input sizes, counts, etc.)
  duration_ms   INTEGER NOT NULL DEFAULT 0,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for the common query patterns used by the Integrations page
CREATE INDEX IF NOT EXISTS idx_operation_log_user_id       ON public.operation_log(user_id);
CREATE INDEX IF NOT EXISTS idx_operation_log_entity_type   ON public.operation_log(entity_type);
CREATE INDEX IF NOT EXISTS idx_operation_log_created_at    ON public.operation_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_operation_log_status        ON public.operation_log(status);
CREATE INDEX IF NOT EXISTS idx_operation_log_user_entity   ON public.operation_log(user_id, entity_type);
CREATE INDEX IF NOT EXISTS idx_operation_log_user_created  ON public.operation_log(user_id, created_at DESC);

ALTER TABLE public.operation_log ENABLE ROW LEVEL SECURITY;

-- Users can only read their own logs; backend writes via service role (bypasses RLS)
CREATE POLICY "Users can view own operation_log"
  ON public.operation_log FOR SELECT
  USING (auth.uid() = user_id);

COMMENT ON TABLE public.operation_log IS
  'Granular audit log of HubSpot API operations (contacts, companies, tasks) and LLM/Claude '
  'API calls. Surfaced in the Integrations page beside the sync log.';
