/**
 * Integrations API: Gmail connect/disconnect, status, and sync log.
 * Uses authenticated API requests (Bearer from Supabase session).
 */

import { getAuthHeaders } from '@/lib/api/activities';
import { buildApiUrl } from '@/lib/api/client';

export type GmailStatusResponse = {
  connected: boolean;
  email?: string | null;
  last_connected_at?: string | null;
};

// ---------------------------------------------------------------------------
// Sync log (Integrations page)
// ---------------------------------------------------------------------------

export type SyncLogEntry = {
  id: string;
  source: string;
  action: string;
  status: 'success' | 'error';
  started_at: string;
  finished_at: string;
  duration_ms: number;
  details?: string | null;
  metadata?: Record<string, unknown>;
  created_at?: string | null;
};

export type SyncLogListParams = {
  status?: 'all' | 'success' | 'error';
  source?: 'all' | 'hubspot' | 'email';
  page?: number;
  page_size?: number;
};

export type SyncLogListResponse = {
  entries: SyncLogEntry[];
  total: number;
  page: number;
  page_size: number;
};

export async function getSyncLogs(params: SyncLogListParams = {}): Promise<SyncLogListResponse> {
  const url = buildApiUrl('/api/v1/sync-logs', {
    status: params.status ?? 'all',
    source: params.source ?? 'all',
    page: params.page ?? 1,
    page_size: params.page_size ?? 20,
  });
  const headers = await getAuthHeaders();
  const res = await fetch(url, { method: 'GET', headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || res.statusText);
  }
  return res.json() as Promise<SyncLogListResponse>;
}

// ---------------------------------------------------------------------------
// Operation log (granular per-entity and LLM call logs)
// ---------------------------------------------------------------------------

export type OperationLogEntry = {
  id: string;
  entity_type: 'contact' | 'company' | 'task' | 'llm_call';
  operation: string;
  entity_id?: string | null;
  entity_name?: string | null;
  status: 'success' | 'error';
  http_status_code?: number | null;
  error_code?: string | null;
  error_message?: string | null;
  response_summary?: string | null;
  metadata?: Record<string, unknown>;
  duration_ms: number;
  created_at: string;
};

export type OperationLogListParams = {
  entity_type?: 'all' | 'contact' | 'company' | 'task' | 'llm_call';
  status?: 'all' | 'success' | 'error';
  page?: number;
  page_size?: number;
};

export type OperationLogListResponse = {
  entries: OperationLogEntry[];
  total: number;
  page: number;
  page_size: number;
};

export async function getOperationLogs(
  params: OperationLogListParams = {},
): Promise<OperationLogListResponse> {
  const url = buildApiUrl('/api/v1/operation-logs', {
    entity_type: params.entity_type ?? 'all',
    status: params.status ?? 'all',
    page: params.page ?? 1,
    page_size: params.page_size ?? 20,
  });
  const headers = await getAuthHeaders();
  const res = await fetch(url, { method: 'GET', headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || res.statusText);
  }
  return res.json() as Promise<OperationLogListResponse>;
}

export async function getGmailStatus(): Promise<GmailStatusResponse> {
  const url = buildApiUrl('/api/v1/auth/gmail/status');
  const headers = await getAuthHeaders();
  const res = await fetch(url, { method: 'GET', headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || res.statusText);
  }
  return res.json() as Promise<GmailStatusResponse>;
}

/** Returns the Google OAuth URL to redirect the user to. */
export async function getGmailConnectUrl(): Promise<{ url: string }> {
  const url = buildApiUrl('/api/v1/auth/gmail');
  const headers = await getAuthHeaders();
  const res = await fetch(url, { method: 'GET', headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || res.statusText);
  }
  return res.json() as Promise<{ url: string }>;
}

export async function disconnectGmail(): Promise<void> {
  const url = buildApiUrl('/api/v1/auth/gmail');
  const headers = await getAuthHeaders();
  const res = await fetch(url, { method: 'DELETE', headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || res.statusText);
  }
}
