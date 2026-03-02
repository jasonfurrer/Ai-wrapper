/**
 * Dashboard state API client.
 * Uses NEXT_PUBLIC_API_URL and Supabase session. Includes retry and debounce.
 */

import { getAuthHeaders } from './activities';
import { ApiClientError, buildApiUrl } from './client';
import type { DashboardState } from './types';

const DEFAULT_MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 500;

function isRetryableError(err: unknown): boolean {
  if (err instanceof ApiClientError) {
    return err.status >= 500 || err.status === 408;
  }
  if (err instanceof TypeError && err.message === 'Failed to fetch') {
    return true;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const url = buildApiUrl(path);
  let lastError: unknown;
  for (let attempt = 0; attempt < DEFAULT_MAX_RETRIES; attempt++) {
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(url, {
        ...init,
        headers: { ...headers, ...init.headers },
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
        const apiErr = new ApiClientError(
          res.statusText || 'Request failed',
          res.status,
          typeof detail === 'string' ? detail : (detail as Record<string, unknown>)
        );
        if (isRetryableError(apiErr) && attempt < DEFAULT_MAX_RETRIES - 1) {
          lastError = apiErr;
          await sleep(INITIAL_BACKOFF_MS * Math.pow(2, attempt));
          continue;
        }
        throw apiErr;
      }
      return (data ?? {}) as T;
    } catch (err) {
      lastError = err;
      if (isRetryableError(err) && attempt < DEFAULT_MAX_RETRIES - 1) {
        await sleep(INITIAL_BACKOFF_MS * Math.pow(2, attempt));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

/**
 * GET /api/v1/dashboard/state
 * Fetch current user's dashboard state. Returns defaults if none exists.
 */
export async function getDashboardState(): Promise<DashboardState> {
  try {
    const data = await fetchWithRetry<DashboardState>('/api/v1/dashboard/state', {
      method: 'GET',
    });
    return {
      selected_activity_id: data.selected_activity_id ?? null,
      sort_option: data.sort_option ?? 'due_date_oldest',
      filter_state: data.filter_state ?? {},
      date_picker_value: data.date_picker_value ?? null,
      updated_at: data.updated_at ?? null,
    };
  } catch (err) {
    if (err instanceof ApiClientError) throw err;
    throw new Error(
      err instanceof Error ? err.message : 'Failed to fetch dashboard state'
    );
  }
}

/**
 * DELETE /api/v1/dashboard/state
 * Clear saved dashboard state so next GET returns defaults (today's date). Call before sign out.
 */
export async function clearDashboardState(): Promise<void> {
  try {
    const url = buildApiUrl('/api/v1/dashboard/state');
    const headers = await getAuthHeaders();
    const res = await fetch(url, { method: 'DELETE', headers });
    if (!res.ok) {
      // Don't throw; sign out should proceed even if clear fails (e.g. network)
      return;
    }
  } catch {
    // Ignore so sign out is never blocked
  }
}

/**
 * PUT /api/v1/dashboard/state
 * Update dashboard state (partial). Returns updated state.
 */
export async function updateDashboardState(
  state: Partial<DashboardState>
): Promise<DashboardState> {
  try {
    const payload: Record<string, unknown> = {};
    if (state.selected_activity_id !== undefined)
      payload.selected_activity_id = state.selected_activity_id;
    if (state.sort_option !== undefined) payload.sort_option = state.sort_option;
    if (state.filter_state !== undefined) payload.filter_state = state.filter_state;
    if (state.date_picker_value !== undefined)
      payload.date_picker_value = state.date_picker_value;

    const data = await fetchWithRetry<DashboardState>('/api/v1/dashboard/state', {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    return {
      selected_activity_id: data.selected_activity_id ?? null,
      sort_option: data.sort_option ?? 'due_date_oldest',
      filter_state: data.filter_state ?? {},
      date_picker_value: data.date_picker_value ?? null,
      updated_at: data.updated_at ?? null,
    };
  } catch (err) {
    if (err instanceof ApiClientError) throw err;
    throw new Error(
      err instanceof Error ? err.message : 'Failed to update dashboard state'
    );
  }
}

const DEBOUNCE_MS = 500;

/** Rejected when a debounced call is superseded by a newer call before the delay fires. */
export class DebounceCancelledError extends Error {
  constructor() {
    super('Debounced update was superseded by a newer call');
    this.name = 'DebounceCancelledError';
  }
}

/**
 * Debounced wrapper: calls updateDashboardState after 500ms of no further invocations.
 * Each call resets the timer. Returns a promise that resolves with the update result
 * when the request runs, or rejects with DebounceCancelledError if a newer call reset the timer.
 * cancel() clears any pending debounce (use on unmount to avoid races).
 */
function createDebouncedUpdate(): {
  update: (state: Partial<DashboardState>) => Promise<DashboardState>;
  cancel: () => void;
} {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let resolveLast: ((value: DashboardState) => void) | null = null;
  let rejectLast: ((reason: unknown) => void) | null = null;
  let pendingState: Partial<DashboardState> = {};

  const flush = () => {
    timeoutId = null;
    const state = { ...pendingState };
    pendingState = {};
    const promise = updateDashboardState(state);
    promise
      .then((result) => {
        if (resolveLast) resolveLast(result);
      })
      .catch((err) => {
        if (rejectLast) rejectLast(err);
      });
    resolveLast = null;
    rejectLast = null;
  };

  const cancel = () => {
    if (timeoutId != null) {
      clearTimeout(timeoutId);
      timeoutId = null;
      if (rejectLast) rejectLast(new DebounceCancelledError());
      rejectLast = null;
      resolveLast = null;
      pendingState = {};
    }
  };

  const update = (state: Partial<DashboardState>): Promise<DashboardState> => {
    if (timeoutId != null) {
      clearTimeout(timeoutId);
      if (rejectLast) rejectLast(new DebounceCancelledError());
    }
    pendingState = { ...pendingState, ...state };
    return new Promise((resolve, reject) => {
      resolveLast = resolve;
      rejectLast = reject;
      timeoutId = setTimeout(flush, DEBOUNCE_MS);
    });
  };

  return { update, cancel };
}

const debounced = createDebouncedUpdate();
export const debouncedUpdateDashboardState = debounced.update;
export const cancelDebouncedDashboardState = debounced.cancel;
