/**
 * Activities API client.
 * Uses NEXT_PUBLIC_API_URL and Supabase session (Bearer) for auth.
 */

import { supabase } from '@/lib/supabase.js';
import { ApiClientError, buildApiUrl } from './client';
import type {
  ActivityListResponse,
  ActivityQueryParams,
  ActivitySubmitRequest,
  CommunicationSummaryResponse,
  CreateActivityData,
  DashboardActivity,
  GenerateEmailDraftsRequest,
  GenerateEmailDraftsResponse,
  ProcessDraftRequest,
  ProcessNotesRequest,
  ProcessNotesResponse,
  RegenerateDraftRequest,
  SyncResponse,
  UpdateActivityData,
} from './types';

/**
 * Fetches current Supabase session and returns headers with Bearer token.
 * Use for authenticated API requests.
 */
export async function getAuthHeaders(): Promise<HeadersInit> {
  const {
    data: { session },
    error,
  } = await supabase.auth.getSession();
  if (error) {
    throw new Error(`Failed to get session: ${error.message}`);
  }
  if (!session?.access_token) {
    throw new Error('Not authenticated. Please sign in.');
  }
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${session.access_token}`,
  };
}

function buildActivitiesQueryString(params: ActivityQueryParams): string {
  const search = new URLSearchParams();
  if (params.date != null) search.set('date', params.date);
  if (params.date_from != null) search.set('date_from', params.date_from);
  if (params.date_to != null) search.set('date_to', params.date_to);
  if (params.sort != null) search.set('sort', params.sort);
  if (params.search != null && params.search.trim()) search.set('search', params.search.trim());
  if (params.relationship_status?.length) {
    params.relationship_status.forEach((v) =>
      search.append('relationship_status', v)
    );
  }
  if (params.processing_status?.length) {
    params.processing_status.forEach((v) =>
      search.append('processing_status', v)
    );
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

async function fetchApi<T>(
  path: string,
  init: RequestInit & { params?: Record<string, string | string[] | undefined> } = {}
): Promise<T> {
  const { params, ...requestInit } = init;
  const url = buildApiUrl(path, params);
  const headers = await getAuthHeaders();
  const res = await fetch(url, {
    ...requestInit,
    headers: { ...headers, ...requestInit.headers },
  });
  const text = await res.text();
  let data: T | null = null;
  if (text) {
    try {
      data = JSON.parse(text) as T;
    } catch {
      // non-JSON
    }
  }
  if (!res.ok) {
    const detail =
      data && typeof data === 'object' && 'detail' in data
        ? (data as { detail: string | Record<string, unknown> }).detail
        : text;
    throw new ApiClientError(
      res.statusText || 'Request failed',
      res.status,
      typeof detail === 'string' ? detail : (detail as Record<string, unknown>)
    );
  }
  return (data ?? {}) as T;
}

/**
 * GET /api/v1/activities
 * List activities with optional filters and sort.
 */
export async function getActivities(
  params: ActivityQueryParams = {}
): Promise<ActivityListResponse> {
  try {
    const qs = buildActivitiesQueryString(params);
    return fetchApi<ActivityListResponse>(`/api/v1/activities${qs}`);
  } catch (err) {
    if (err instanceof ApiClientError) throw err;
    throw new Error(
      err instanceof Error ? err.message : 'Failed to fetch activities'
    );
  }
}

/**
 * GET /api/v1/activities/{activityId}
 * Fetch a single activity.
 */
export async function getActivity(
  activityId: string
): Promise<DashboardActivity> {
  try {
    return fetchApi<DashboardActivity>(`/api/v1/activities/${encodeURIComponent(activityId)}`);
  } catch (err) {
    if (err instanceof ApiClientError) throw err;
    throw new Error(
      err instanceof Error ? err.message : 'Failed to fetch activity'
    );
  }
}

/**
 * POST /api/v1/activities
 * Create a new activity.
 */
export async function createActivity(
  data: CreateActivityData
): Promise<DashboardActivity> {
  try {
    return fetchApi<DashboardActivity>('/api/v1/activities', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  } catch (err) {
    if (err instanceof ApiClientError) throw err;
    throw new Error(
      err instanceof Error ? err.message : 'Failed to create activity'
    );
  }
}

/**
 * PUT /api/v1/activities/{activityId}
 * Update an existing activity.
 */
export async function updateActivity(
  activityId: string,
  data: UpdateActivityData
): Promise<DashboardActivity> {
  try {
    return fetchApi<DashboardActivity>(
      `/api/v1/activities/${encodeURIComponent(activityId)}`,
      {
        method: 'PUT',
        body: JSON.stringify(data),
      }
    );
  } catch (err) {
    if (err instanceof ApiClientError) throw err;
    throw new Error(
      err instanceof Error ? err.message : 'Failed to update activity'
    );
  }
}

/**
 * DELETE /api/v1/activities/{activityId}
 * Delete an activity.
 */
export async function deleteActivity(activityId: string): Promise<void> {
  try {
    await fetchApi<unknown>(
      `/api/v1/activities/${encodeURIComponent(activityId)}`,
      { method: 'DELETE' }
    );
  } catch (err) {
    if (err instanceof ApiClientError) throw err;
    throw new Error(
      err instanceof Error ? err.message : 'Failed to delete activity'
    );
  }
}

/**
 * POST /api/v1/activities/{activityId}/complete
 * Mark an activity as complete.
 */
export async function completeActivity(activityId: string): Promise<void> {
  try {
    await fetchApi<unknown>(
      `/api/v1/activities/${encodeURIComponent(activityId)}/complete`,
      { method: 'POST' }
    );
  } catch (err) {
    if (err instanceof ApiClientError) throw err;
    throw new Error(
      err instanceof Error ? err.message : 'Failed to complete activity'
    );
  }
}

/**
 * POST /api/v1/activities/sync
 * Force sync activities from HubSpot.
 */
export async function syncActivities(): Promise<SyncResponse> {
  try {
    return fetchApi<SyncResponse>('/api/v1/activities/sync', {
      method: 'POST',
    });
  } catch (err) {
    if (err instanceof ApiClientError) throw err;
    throw new Error(
      err instanceof Error ? err.message : 'Failed to sync activities'
    );
  }
}

/**
 * GET /api/v1/activities/{activityId}/communication-summary
 * Get or generate communication summary (summary, times_contacted, relationship_status) from client notes; stored per task.
 */
export async function getCommunicationSummary(
  activityId: string
): Promise<CommunicationSummaryResponse> {
  try {
    return fetchApi<CommunicationSummaryResponse>(
      `/api/v1/activities/${encodeURIComponent(activityId)}/communication-summary`
    );
  } catch (err) {
    if (err instanceof ApiClientError) throw err;
    throw new Error(
      err instanceof Error ? err.message : 'Failed to fetch communication summary'
    );
  }
}

/**
 * POST /api/v1/activities/process-draft
 * Run LLM processing on draft notes when there is no activity id (e.g. new activity).
 * Same response shape as process-notes.
 */
export async function processDraft(
  data: ProcessDraftRequest
): Promise<ProcessNotesResponse> {
  try {
    return fetchApi<ProcessNotesResponse>(
      '/api/v1/activities/process-draft',
      {
        method: 'POST',
        body: JSON.stringify({
          note_text: data.note_text,
          previous_notes: data.previous_notes ?? '',
        }),
      }
    );
  } catch (err) {
    if (err instanceof ApiClientError) throw err;
    throw new Error(
      err instanceof Error ? err.message : 'Failed to process draft'
    );
  }
}

/**
 * POST /api/v1/activities/{activityId}/process-notes
 * Run LLM processing on notes; returns summary, recognised date, recommended date, metadata, drafts.
 */
export async function processActivityNotes(
  activityId: string,
  data: ProcessNotesRequest
): Promise<ProcessNotesResponse> {
  try {
    return fetchApi<ProcessNotesResponse>(
      `/api/v1/activities/${encodeURIComponent(activityId)}/process-notes`,
      {
        method: 'POST',
        body: JSON.stringify(data),
      }
    );
  } catch (err) {
    if (err instanceof ApiClientError) throw err;
    throw new Error(
      err instanceof Error ? err.message : 'Failed to process notes'
    );
  }
}

/**
 * POST /api/v1/activities/generate-email-drafts
 * Generate Smart compose email drafts (warm, concise, formal) from instructions, client notes, task title, last touch date.
 */
export async function generateEmailDrafts(
  data: GenerateEmailDraftsRequest
): Promise<GenerateEmailDraftsResponse> {
  try {
    return fetchApi<GenerateEmailDraftsResponse>(
      '/api/v1/activities/generate-email-drafts',
      {
        method: 'POST',
        body: JSON.stringify({
          email_instructions: data.email_instructions ?? '',
          client_notes: data.client_notes ?? '',
          task_title: data.task_title ?? '',
          last_touch_date: data.last_touch_date ?? null,
          sender_name: data.sender_name ?? null,
        }),
      }
    );
  } catch (err) {
    if (err instanceof ApiClientError) throw err;
    throw new Error(
      err instanceof Error ? err.message : 'Failed to generate email drafts'
    );
  }
}

/**
 * POST /api/v1/activities/create-and-submit
 * Create a new task in HubSpot with meeting notes, subject, contact, and account.
 */
export async function createAndSubmitActivity(
  data: Omit<ActivitySubmitRequest, 'mark_complete'>
): Promise<{ message: string; id: string }> {
  try {
    return fetchApi<{ message: string; id: string }>(
      '/api/v1/activities/create-and-submit',
      {
        method: 'POST',
        body: JSON.stringify(data),
      }
    );
  } catch (err) {
    if (err instanceof ApiClientError) throw err;
    throw new Error(
      err instanceof Error ? err.message : 'Failed to create activity'
    );
  }
}

/**
 * POST /api/v1/activities/{activityId}/submit
 * Mark activity complete or update with meeting notes, due date, subject.
 */
export async function submitActivity(
  activityId: string,
  data: ActivitySubmitRequest
): Promise<{ message: string }> {
  try {
    return fetchApi<{ message: string }>(
      `/api/v1/activities/${encodeURIComponent(activityId)}/submit`,
      {
        method: 'POST',
        body: JSON.stringify(data),
      }
    );
  } catch (err) {
    if (err instanceof ApiClientError) throw err;
    throw new Error(
      err instanceof Error ? err.message : 'Failed to submit activity'
    );
  }
}

/**
 * POST /api/v1/activities/{activityId}/regenerate-draft
 * Regenerate a single draft tone (e.g. formal, concise).
 */
export async function regenerateActivityDraft(
  activityId: string,
  data: RegenerateDraftRequest
): Promise<{ text: string; confidence: number }> {
  try {
    return fetchApi<{ text: string; confidence: number }>(
      `/api/v1/activities/${encodeURIComponent(activityId)}/regenerate-draft`,
      {
        method: 'POST',
        body: JSON.stringify(data),
      }
    );
  } catch (err) {
    if (err instanceof ApiClientError) throw err;
    throw new Error(
      err instanceof Error ? err.message : 'Failed to regenerate draft'
    );
  }
}
