-- Store Google account display name in gmail_tokens (fetched via People API at OAuth connect)
-- Run in Supabase SQL Editor

ALTER TABLE public.gmail_tokens
  ADD COLUMN IF NOT EXISTS display_name TEXT;

COMMENT ON COLUMN public.gmail_tokens.display_name IS 'Google account display name from People API (set at OAuth connect, backfilled on token refresh).';
