'use client';

import * as React from 'react';
import Link from 'next/link';
import ProtectedRoute from '@/components/ProtectedRoute';
import { useRouter } from 'next/navigation';
import {
  Filter,
  FilterX,
  Plus,
  ArrowUpDown,
  ClipboardList,
  Search,
  SearchX,
  User,
  RefreshCw,
  Clock,
  WifiOff,
  AlertTriangle,
  FileText,
  CalendarIcon,
  Loader2,
  CalendarDays,
  AlertCircle,
  ChevronDown,
  ListTodo,
  CalendarRange,
} from 'lucide-react';
import { format, startOfWeek, endOfWeek, subDays, addDays } from 'date-fns';
import { Calendar } from '@/components/ui/calendar';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Toast,
  ToastTitle,
  ToastDescription,
  ToastClose,
} from '@/components/ui/toast';
import { ActivityCard, type ActivityCardActivity } from '@/components/shared/activity-card';
import {
  ContactPreview,
  type ContactPreviewContact,
} from '@/components/shared/contact-preview';
import { EmptyState } from '@/components/shared/empty-state';
import { cn, stripHtml } from '@/lib/utils';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getActivities,
  completeActivity,
  syncActivities,
  type DashboardActivity,
  type ActivitySortOption,
} from '@/lib/api';
import {
  getDashboardState,
  updateDashboardState,
  debouncedUpdateDashboardState,
  cancelDebouncedDashboardState,
  DebounceCancelledError,
} from '@/lib/api/dashboard';
import type { DashboardState } from '@/lib/api/types';
import { useAuth } from '@/contexts/AuthContext';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CommunicationSummary {
  totalEmails: number;
  totalCalls: number;
  totalTexts: number;
  lastContact: string;
  averageResponseTime: string;
  keyPoints: string[];
}

export interface DashboardActivityItem {
  activity: ActivityCardActivity;
  communicationSummary: CommunicationSummary;
  contact: ContactPreviewContact;
  /** First contact id (for Activity page pre-fill) */
  contactId?: string;
  /** First company id (for Activity page pre-fill) */
  companyId?: string;
}

export type SortOption =
  | 'date_newest'
  | 'date_oldest'
  | 'priority_high_low'
  | 'priority_low_high';

export type PriorityFilterOption = 'none' | 'low' | 'medium' | 'high';

export type TaskStatusFilterOption = 'completed' | 'not_completed';

export interface FilterState {
  priority: PriorityFilterOption[];
  taskStatus: TaskStatusFilterOption[];
  dateFrom: string;
  dateTo: string;
}

interface ToastState {
  open: boolean;
  variant: 'default' | 'success' | 'error' | 'warning' | 'info';
  title: string;
  description?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AUTO_SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const STALE_SYNC_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

const PRIORITY_FILTER_OPTIONS: PriorityFilterOption[] = ['none', 'low', 'medium', 'high'];

const ACTIVITY_SEARCH_DEBOUNCE_MS = 400;

function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

function isNetworkError(err: unknown): boolean {
  if (err instanceof TypeError && err.message === 'Failed to fetch') return true;
  if (err instanceof Error && /network|fetch|unreachable/i.test(err.message)) return true;
  return false;
}

function formatLastSynced(ts: number | null): string {
  if (ts == null) return 'Never';
  const diffMs = Date.now() - ts;
  const diffMins = Math.floor(diffMs / (60 * 1000));
  const diffSecs = Math.floor(diffMs / 1000);
  if (diffSecs < 60) return 'Just now';
  if (diffMins === 1) return '1 minute ago';
  if (diffMins < 60) return `${diffMins} minutes ago`;
  const hours = Math.floor(diffMins / 60);
  return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
}

/** Map API DashboardActivity to UI DashboardActivityItem */
function apiActivityToDashboardItem(api: DashboardActivity): DashboardActivityItem {
  const contact = api.contacts?.[0];
  const company = api.companies?.[0];
  const contactName = contact
    ? [contact.first_name, contact.last_name].filter(Boolean).join(' ') || contact.email || 'Unknown'
    : 'Unknown';
  const lastTouch = api.due_date ?? api.updated_at ?? api.created_at ?? new Date().toISOString();
  const rawSubject = api.subject ?? 'Untitled';
  const rawBody = api.body ?? '';
  const priority = (api.priority === 'low' || api.priority === 'medium' || api.priority === 'high' || api.priority === 'none')
    ? api.priority
    : undefined;
  const activity: ActivityCardActivity = {
    id: api.id,
    contactName,
    accountName: contact?.company_name ?? company?.name ?? '',
    subject: stripHtml(rawSubject),
    noteExcerpt: stripHtml(rawBody),
    lastTouchDate: lastTouch,
    relationshipStatus: 'Active',
    priority: priority ?? 'none',
    opportunityPercentage: 0,
    processingStatus: 'ready',
  };
  const communicationSummary: CommunicationSummary = {
    totalEmails: 0,
    totalCalls: 0,
    totalTexts: 0,
    lastContact: lastTouch,
    averageResponseTime: '-',
    keyPoints: rawBody ? [stripHtml(rawBody)] : [],
  };
  const contactPreview: ContactPreviewContact = {
    name: contactName,
    email: contact?.email ?? undefined,
    phone: contact?.phone ?? undefined,
    mobilePhone: contact?.mobile_phone ?? undefined,
    companyName: contact?.company_name ?? undefined,
    recentNotes: [],
  };
  const contactId = api.contact_ids?.[0] ?? contact?.id;
  const companyId = api.company_ids?.[0] ?? company?.id;
  return {
    activity,
    communicationSummary,
    contact: contactPreview,
    contactId: contactId ?? undefined,
    companyId: companyId ?? undefined,
  };
}

const TASK_STATUS_FILTER_OPTIONS: TaskStatusFilterOption[] = ['completed', 'not_completed'];

/** Serialize local FilterState to API filter_state */
function filterStateToApi(filter: FilterState): Record<string, unknown> {
  return {
    priority: filter.priority,
    taskStatus: filter.taskStatus,
    dateFrom: filter.dateFrom || undefined,
    dateTo: filter.dateTo || undefined,
  };
}

/** Parse API filter_state to local FilterState */
function filterStateFromApi(state: Record<string, unknown> | undefined): FilterState {
  if (!state) return DEFAULT_FILTER;
  const priority = Array.isArray(state.priority)
    ? (state.priority as PriorityFilterOption[]).filter((p) =>
        PRIORITY_FILTER_OPTIONS.includes(p)
      )
    : [];
  const taskStatus = Array.isArray(state.taskStatus)
    ? (state.taskStatus as TaskStatusFilterOption[]).filter((s) =>
        TASK_STATUS_FILTER_OPTIONS.includes(s)
      )
    : [];
  return {
    priority,
    taskStatus,
    dateFrom: typeof state.dateFrom === 'string' ? state.dateFrom : '',
    dateTo: typeof state.dateTo === 'string' ? state.dateTo : '',
  };
}

/** Persist dashboard state to sessionStorage so it survives navigation within the session */
function saveDashboardStateToStorage(state: {
  selected_activity_id: string | null;
  sort_option: SortOption;
  filter_state: Record<string, unknown>;
  date_picker_value: string | null;
}): void {
  try {
    sessionStorage.setItem(DASHBOARD_STATE_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore
  }
}

/** Read dashboard state from sessionStorage; returns null if missing or invalid */
function loadDashboardStateFromStorage(): {
  filter: FilterState;
  sort: SortOption;
  datePickerValue: string;
  selectedActivityId: string | null;
} | null {
  try {
    const raw = sessionStorage.getItem(DASHBOARD_STATE_STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as Record<string, unknown>;
    const filter = filterStateFromApi(data.filter_state as Record<string, unknown>);
    const sort = (data.sort_option as SortOption) || 'date_newest';
    const hasDateRange = !!(filter.dateFrom || filter.dateTo);
    const datePickerValue = hasDateRange
      ? ''
      : (typeof data.date_picker_value === 'string' ? data.date_picker_value : getTodayDateString());
    const selectedActivityId =
      typeof data.selected_activity_id === 'string' ? data.selected_activity_id : null;
    return { filter, sort, datePickerValue, selectedActivityId };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatPageDate(date: Date): string {
  return date.toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/** Convert YYYY-MM-DD to DD-MM-YYYY for display in date inputs. */
function toDisplayDate(iso: string): string {
  if (!iso || iso.length < 10) return '';
  const [y, m, d] = iso.split('-');
  return d && m && y ? `${d}-${m}-${y}` : iso;
}

/** Parse DD-MM-YYYY or DD/MM/YYYY to YYYY-MM-DD; return empty string if invalid. */
function parseDisplayDateToIso(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  const parts = trimmed.split(/[-/]/);
  if (parts.length !== 3) return '';
  const [a, b, c] = parts;
  const day = a?.length === 2 ? a : a?.padStart(2, '0');
  const month = b?.length === 2 ? b : b?.padStart(2, '0');
  const year = c?.length === 4 ? c : '';
  if (!year || !month || !day) return '';
  const y = parseInt(year, 10);
  const m = parseInt(month, 10);
  const d = parseInt(day, 10);
  if (m < 1 || m > 12 || d < 1 || d > 31) return '';
  return `${y}-${month}-${day}`;
}

function isSameDay(iso: string, dateStr: string): boolean {
  if (!dateStr) return true;
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}` === dateStr;
}

function isDateInRange(iso: string, from: string, to: string): boolean {
  const t = new Date(iso).getTime();
  if (from && t < new Date(from + 'T00:00:00').getTime()) return false;
  if (to && t > new Date(to + 'T23:59:59').getTime()) return false;
  return true;
}

const SORT_OPTIONS: { value: SortOption; label: string; dateOnly?: boolean }[] = [
  { value: 'date_newest', label: 'Date Newest', dateOnly: true },
  { value: 'date_oldest', label: 'Date Oldest', dateOnly: true },
  { value: 'priority_high_low', label: 'Priority High to Low' },
  { value: 'priority_low_high', label: 'Priority Low to High' },
];

const PRIORITY_ORDER: Record<string, number> = { high: 3, medium: 2, low: 1, none: 0 };

function sortActivities(
  items: DashboardActivityItem[],
  sort: SortOption
): DashboardActivityItem[] {
  const copy = [...items];
  switch (sort) {
    case 'date_newest':
      copy.sort(
        (a, b) =>
          new Date(b.activity.lastTouchDate).getTime() -
          new Date(a.activity.lastTouchDate).getTime()
      );
      break;
    case 'date_oldest':
      copy.sort(
        (a, b) =>
          new Date(a.activity.lastTouchDate).getTime() -
          new Date(b.activity.lastTouchDate).getTime()
      );
      break;
    case 'priority_high_low':
      copy.sort(
        (a, b) =>
          (PRIORITY_ORDER[b.activity.priority ?? 'none'] ?? 0) -
          (PRIORITY_ORDER[a.activity.priority ?? 'none'] ?? 0)
      );
      break;
    case 'priority_low_high':
      copy.sort(
        (a, b) =>
          (PRIORITY_ORDER[a.activity.priority ?? 'none'] ?? 0) -
          (PRIORITY_ORDER[b.activity.priority ?? 'none'] ?? 0)
      );
      break;
    default:
      break;
  }
  return copy;
}

const DEFAULT_FILTER: FilterState = {
  priority: [],
  taskStatus: [],
  dateFrom: '',
  dateTo: '',
};

/** Date range used to fetch all tasks (no date filter). */
const ALL_TASKS_DATE_FROM = '1970-01-01';
const ALL_TASKS_DATE_TO = '2099-12-31';

/** Today as YYYY-MM-DD (local date) for default activity list filter. */
function getTodayDateString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Yesterday as YYYY-MM-DD for Overdue view (due before today). */
function getYesterdayDateString(): string {
  const d = subDays(new Date(), 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** This calendar week (Monday–Sunday) as YYYY-MM-DD range. */
function getThisWeekRange(): { from: string; to: string } {
  const now = new Date();
  const start = startOfWeek(now, { weekStartsOn: 1 });
  const end = endOfWeek(now, { weekStartsOn: 1 });
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { from: fmt(start), to: fmt(end) };
}

/** Quick view presets: Today, Overdue, This Week, All, Upcoming */
const QUICK_VIEW_OVERDUE_DATE_FROM = '1970-01-01';
const UPCOMING_END_FAR = '2099-12-31';

/** Upcoming: next 7 days (today through today + 6). */
function getUpcomingWeekRange(): { from: string; to: string } {
  const start = new Date();
  const end = addDays(start, 6);
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { from: fmt(start), to: fmt(end) };
}

/** Upcoming: next 30 days (today through today + 29). */
function getUpcomingMonthRange(): { from: string; to: string } {
  const start = new Date();
  const end = addDays(start, 29);
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { from: fmt(start), to: fmt(end) };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const ACTIVITIES_QUERY_KEY = 'activities';
const DASHBOARD_STATE_QUERY_KEY = 'dashboardState';
const DASHBOARD_STATE_STORAGE_KEY = 'dashboardState';

const DASHBOARD_STATE_STALE_MS = 5 * 60 * 1000; // 5 min – refetch when returning after a while

/** Build initial UI state from React Query cache or defaults (no sessionStorage). Instant on navigate back. */
function stateFromCacheOrDefaults(cached: DashboardState | undefined): {
  filter: FilterState;
  sort: SortOption;
  datePickerValue: string;
  selectedActivityId: string | null;
} {
  if (!cached) {
    return {
      filter: DEFAULT_FILTER,
      sort: 'date_newest',
      datePickerValue: getTodayDateString(),
      selectedActivityId: null,
    };
  }
  const filter = filterStateFromApi(cached.filter_state as Record<string, unknown>);
  const hasDateRange = !!(filter.dateFrom || filter.dateTo);
  const datePickerValue = hasDateRange ? '' : (cached.date_picker_value ?? getTodayDateString());
  return {
    filter,
    sort: (cached.sort_option as SortOption) || 'date_newest',
    datePickerValue,
    selectedActivityId: typeof cached.selected_activity_id === 'string' ? cached.selected_activity_id : null,
  };
}

export default function DashboardPage(): React.ReactElement {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user, isSigningOutRef } = useAuth() as { user: { email?: string; user_metadata?: { full_name?: string } } | null; isSigningOutRef: React.MutableRefObject<boolean> };
  // Initial state from React Query cache (instant on navigate back) or defaults – no sessionStorage
  const initial = React.useMemo(
    () => stateFromCacheOrDefaults(queryClient.getQueryData([DASHBOARD_STATE_QUERY_KEY])),
    [queryClient]
  );
  const [selectedActivityId, setSelectedActivityId] = React.useState<string | null>(
    () => initial.selectedActivityId
  );
  const [sort, setSort] = React.useState<SortOption>(() => initial.sort);
  const [filterDialogOpen, setFilterDialogOpen] = React.useState(false);
  const [filterDraft, setFilterDraft] = React.useState<FilterState>(() => initial.filter);
  const [filterApplied, setFilterApplied] = React.useState<FilterState>(() => initial.filter);
  const [datePickerValue, setDatePickerValue] = React.useState<string>(() => initial.datePickerValue);
  const [activitySearchQuery, setActivitySearchQuery] = React.useState('');
  const [completingId, setCompletingId] = React.useState<string | null>(null);
  const [completeConfirmActivity, setCompleteConfirmActivity] = React.useState<ActivityCardActivity | null>(null);
  const [isSyncing, setIsSyncing] = React.useState(false);
  const [lastSyncedAt, setLastSyncedAt] = React.useState<number | null>(null);
  const [isOffline, setIsOffline] = React.useState(false);
  const [toast, setToast] = React.useState<ToastState>({
    open: false,
    variant: 'default',
    title: '',
    description: undefined,
  });
  const [upcomingPopoverOpen, setUpcomingPopoverOpen] = React.useState(false);
  const upcomingPopoverCloseTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // Ref holding latest state so we can persist on unmount (flush before navigate away)
  const latestStateRef = React.useRef({
    selectedActivityId,
    sort,
    filterApplied,
    datePickerValue,
  });
  latestStateRef.current = {
    selectedActivityId,
    sort,
    filterApplied,
    datePickerValue,
  };
  const hasUserInteractedRef = React.useRef(false);
  const weJustAppliedServerStateRef = React.useRef(false);
  const isUnmountingRef = React.useRef(false);

  React.useEffect(() => {
    return () => {
      if (upcomingPopoverCloseTimeoutRef.current) {
        clearTimeout(upcomingPopoverCloseTimeoutRef.current);
        upcomingPopoverCloseTimeoutRef.current = null;
      }
    };
  }, []);

  const showToast = React.useCallback(
    (variant: ToastState['variant'], title: string, description?: string) => {
      setToast({ open: true, variant, title, description });
    },
    []
  );

  // Dashboard state from API (cached by React Query – instant when navigating back)
  const dashboardStateQuery = useQuery({
    queryKey: [DASHBOARD_STATE_QUERY_KEY],
    queryFn: getDashboardState,
    enabled: !!user,
    retry: false,
    staleTime: DASHBOARD_STATE_STALE_MS,
  });

  // Sync local UI state from server/cache when available, only if user hasn't interacted yet.
  React.useEffect(() => {
    const state = dashboardStateQuery.data;
    if (!state || hasUserInteractedRef.current) return;
    weJustAppliedServerStateRef.current = true;
    setSort((state.sort_option as SortOption) || 'date_newest');
    const filter = filterStateFromApi(state.filter_state as Record<string, unknown>);
    setFilterApplied(filter);
    setFilterDraft(filter);
    const hasDateRange = !!(filter.dateFrom || filter.dateTo);
    setDatePickerValue(hasDateRange ? '' : (state.date_picker_value ?? getTodayDateString()));
    if (state.selected_activity_id) setSelectedActivityId(state.selected_activity_id);
  }, [dashboardStateQuery.data]);

  // On unmount: cancel debounced save, write latest state to cache immediately (so next mount shows it), then flush to server.
  React.useEffect(() => {
    return () => {
      if (!user || isSigningOutRef.current) return;
      isUnmountingRef.current = true;
      cancelDebouncedDashboardState();
      const s = latestStateRef.current;
      const state = {
        selected_activity_id: s.selectedActivityId ?? null,
        sort_option: s.sort,
        filter_state: filterStateToApi(s.filterApplied),
        date_picker_value: s.datePickerValue || null,
      };
      // Update cache synchronously so when user navigates back they see the latest (e.g. date 11), not stale data.
      queryClient.setQueryData([DASHBOARD_STATE_QUERY_KEY], { ...state, updated_at: null });
      updateDashboardState(state)
        .then((result) => {
          queryClient.setQueryData([DASHBOARD_STATE_QUERY_KEY], result);
        })
        .catch(() => {});
    };
  }, [user, queryClient]);

  // Debounced search query for API (HubSpot keyword search; returns completed + not completed).
  const debouncedSearchQuery = useDebouncedValue(activitySearchQuery.trim(), ACTIVITY_SEARCH_DEBOUNCE_MS);
  const isSearchMode = !!debouncedSearchQuery;

  // Activities from API (cached by React Query – instant when navigating back).
  // When search is set: backend fetches from HubSpot by keyword (all statuses). Otherwise: date/range filters.
  const activitiesParams = React.useMemo(
    () => {
      if (isSearchMode) {
        return { sort: sort as ActivitySortOption, search: debouncedSearchQuery };
      }
      return {
        sort: sort as ActivitySortOption,
        date: datePickerValue || undefined,
        date_from: datePickerValue ? undefined : (filterApplied.dateFrom || undefined),
        date_to: datePickerValue ? undefined : (filterApplied.dateTo || undefined),
      };
    },
    [sort, datePickerValue, filterApplied, isSearchMode, debouncedSearchQuery]
  );

  const activitiesQuery = useQuery({
    queryKey: [ACTIVITIES_QUERY_KEY, activitiesParams],
    queryFn: () => getActivities(activitiesParams),
    enabled: !!user,
  });

  // Derive list and completed set from query data (so UI shows cached data when returning)
  const activities = React.useMemo(
    () => (activitiesQuery.data?.activities ?? []).map(apiActivityToDashboardItem),
    [activitiesQuery.data]
  );
  const completedIds = React.useMemo(
    () => new Set((activitiesQuery.data?.activities ?? []).filter((a) => a.completed).map((a) => a.id)),
    [activitiesQuery.data]
  );

  const isInitialLoad = !dashboardStateQuery.isFetched;
  const isActivitiesLoading = activitiesQuery.isLoading;

  // Set selected activity when activities load and we don't have one
  React.useEffect(() => {
    const list = activitiesQuery.data?.activities ?? [];
    if (list.length === 0) return;
    if (selectedActivityId && list.some((a) => a.id === selectedActivityId)) return;
    setSelectedActivityId((id) => (id && list.some((a) => a.id === id)) ? id : list[0].id);
  }, [activitiesQuery.data, selectedActivityId]);

  // Track last synced and offline from query result
  React.useEffect(() => {
    if (activitiesQuery.isSuccess) {
      setLastSyncedAt(Date.now());
      setIsOffline(false);
    }
  }, [activitiesQuery.isSuccess]);
  React.useEffect(() => {
    if (activitiesQuery.isError && isNetworkError(activitiesQuery.error)) setIsOffline(true);
  }, [activitiesQuery.isError, activitiesQuery.error]);

  // Show error toast when activities query fails
  React.useEffect(() => {
    if (activitiesQuery.isError && activitiesQuery.error && !activitiesQuery.data) {
      showToast('error', 'Failed to load activities', activitiesQuery.error instanceof Error ? activitiesQuery.error.message : 'Try again.');
    }
  }, [activitiesQuery.isError, activitiesQuery.error, activitiesQuery.data, showToast]);
  React.useEffect(() => {
    if (dashboardStateQuery.isError && !dashboardStateQuery.data) {
      showToast('error', 'Failed to load dashboard', dashboardStateQuery.error instanceof Error ? dashboardStateQuery.error.message : 'Please try again.');
    }
  }, [dashboardStateQuery.isError, dashboardStateQuery.error, dashboardStateQuery.data, showToast]);

  // Persist dashboard state: sessionStorage backup, debounced API save. Mark user interacted when persisting (not on initial load or right after server sync).
  React.useEffect(() => {
    if (user && !isInitialLoad && !weJustAppliedServerStateRef.current) hasUserInteractedRef.current = true;
    weJustAppliedServerStateRef.current = false;

    const state = {
      selected_activity_id: selectedActivityId ?? null,
      sort_option: sort,
      filter_state: filterStateToApi(filterApplied),
      date_picker_value: datePickerValue || null,
    };
    saveDashboardStateToStorage(state);
    if (!user || isInitialLoad) return;
    debouncedUpdateDashboardState(state)
      .then((result) => {
        if (!isUnmountingRef.current) queryClient.setQueryData([DASHBOARD_STATE_QUERY_KEY], result);
      })
      .catch((err) => {
        if (err instanceof DebounceCancelledError) return;
        showToast('error', 'Failed to save dashboard state', err instanceof Error ? err.message : undefined);
      });
  }, [user, isInitialLoad, selectedActivityId, sort, filterApplied, datePickerValue, showToast, queryClient]);

  const selectedItem = React.useMemo(
    () => activities.find((item) => item.activity.id === selectedActivityId) ?? null,
    [activities, selectedActivityId]
  );

  const filteredByDate = React.useMemo(() => {
    // When date range filter is active, API already returns tasks in range; don't restrict by single date
    if (filterApplied.dateFrom || filterApplied.dateTo) return activities;
    if (!datePickerValue) return activities;
    return activities.filter((item) =>
      isSameDay(item.activity.lastTouchDate, datePickerValue)
    );
  }, [activities, datePickerValue, filterApplied.dateFrom, filterApplied.dateTo]);

  const filtered = React.useMemo(() => {
    return filteredByDate.filter((item) => {
      const a = item.activity;
      if (filterApplied.priority.length > 0) {
        const taskPriority = a.priority ?? 'none';
        if (!filterApplied.priority.includes(taskPriority)) return false;
      }
      if (filterApplied.taskStatus.length > 0) {
        const isCompleted = completedIds.has(item.activity.id);
        const wantCompleted = filterApplied.taskStatus.includes('completed');
        const wantNotCompleted = filterApplied.taskStatus.includes('not_completed');
        if (isCompleted && !wantCompleted) return false;
        if (!isCompleted && !wantNotCompleted) return false;
      }
      if (!isDateInRange(a.lastTouchDate, filterApplied.dateFrom, filterApplied.dateTo))
        return false;
      return true;
    });
  }, [filteredByDate, filterApplied, completedIds]);

  const sortedItems = React.useMemo(
    () => sortActivities(filtered, sort),
    [filtered, sort]
  );

  /** List to display: when searching, API returns matches from HubSpot (already filtered); otherwise sorted list. */
  const searchFilteredItems = sortedItems;

  // When search filters out the selected activity, select first in results or clear
  React.useEffect(() => {
    if (searchFilteredItems.length === 0) {
      setSelectedActivityId(null);
      return;
    }
    if (selectedActivityId && searchFilteredItems.some((i) => i.activity.id === selectedActivityId)) return;
    setSelectedActivityId(searchFilteredItems[0].activity.id);
  }, [searchFilteredItems, selectedActivityId]);

  const selectedContact: ContactPreviewContact | null = selectedItem
    ? selectedItem.contact
    : null;

  const isShowingAllTasks =
    filterApplied.dateFrom === ALL_TASKS_DATE_FROM &&
    filterApplied.dateTo === ALL_TASKS_DATE_TO &&
    filterApplied.priority.length === 0 &&
    filterApplied.taskStatus.length === 0;

  /** Date Newest / Date Oldest are only available when showing all tasks (no date filter). */
  const dateSortsAllowed = isShowingAllTasks;

  // When a date filter is applied and current sort is a date sort, switch to priority
  React.useEffect(() => {
    if (!dateSortsAllowed && (sort === 'date_newest' || sort === 'date_oldest')) {
      setSort('priority_high_low');
    }
  }, [dateSortsAllowed, sort]);

  const hasActiveFilters =
    !isShowingAllTasks &&
    (filterApplied.priority.length > 0 ||
      filterApplied.taskStatus.length > 0 ||
      !!filterApplied.dateFrom ||
      !!filterApplied.dateTo ||
      !!datePickerValue);

  const filterHintText = React.useMemo(() => {
    const searchPart = activitySearchQuery.trim()
      ? `Results for keyword "${activitySearchQuery.trim()}"`
      : null;
    if (searchPart && !hasActiveFilters && isShowingAllTasks) return searchPart;
    if (isShowingAllTasks && !searchPart) return 'Showing all tasks';
    const parts: string[] = [];
    if (searchPart) parts.push(searchPart);
    if (filterApplied.priority.length > 0) {
      const labels = filterApplied.priority.map((p) => p.charAt(0).toUpperCase() + p.slice(1));
      parts.push(`Priority: ${labels.join(', ')}`);
    }
    if (filterApplied.taskStatus.length > 0) {
      const labels = filterApplied.taskStatus.map((s) =>
        s === 'completed' ? 'Completed' : 'Not completed'
      );
      parts.push(`Task status: ${labels.join(', ')}`);
    }
    if (datePickerValue) {
      parts.push(`Date: ${format(new Date(datePickerValue + 'T00:00:00'), 'dd MMM yyyy')}`);
    } else if (
      filterApplied.dateFrom &&
      filterApplied.dateTo &&
      (filterApplied.dateFrom !== ALL_TASKS_DATE_FROM || filterApplied.dateTo !== ALL_TASKS_DATE_TO)
    ) {
      parts.push(
        `Date range: ${format(new Date(filterApplied.dateFrom + 'T00:00:00'), 'dd MMM yyyy')} – ${format(new Date(filterApplied.dateTo + 'T00:00:00'), 'dd MMM yyyy')}`
      );
    }
    return parts.length > 0 ? parts.join(' · ') : 'No filters applied';
  }, [activitySearchQuery, isShowingAllTasks, hasActiveFilters, filterApplied.priority, filterApplied.taskStatus, filterApplied.dateFrom, filterApplied.dateTo, datePickerValue]);

  const handleApplyFilter = () => {
    setFilterApplied(filterDraft);
    if (filterDraft.dateFrom || filterDraft.dateTo) setDatePickerValue('');
    setFilterDialogOpen(false);
  };

  const handleClearFilter = () => {
    setFilterDraft(DEFAULT_FILTER);
    setFilterApplied(DEFAULT_FILTER);
  };

  const handleClearAllFilters = () => {
    const showAllFilter = {
      ...DEFAULT_FILTER,
      dateFrom: ALL_TASKS_DATE_FROM,
      dateTo: ALL_TASKS_DATE_TO,
    };
    setFilterDraft(showAllFilter);
    setFilterApplied(showAllFilter);
    setDatePickerValue('');
    setFilterDialogOpen(false);
  };

  /** Quick views: set filter + date to standard presets (no conflicts with existing filter architecture). */
  const handleQuickViewToday = () => {
    setFilterApplied(DEFAULT_FILTER);
    setFilterDraft(DEFAULT_FILTER);
    setDatePickerValue(getTodayDateString());
    setFilterDialogOpen(false);
  };
  const handleQuickViewOverdue = () => {
    const yesterday = getYesterdayDateString();
    const filter: FilterState = {
      ...DEFAULT_FILTER,
      dateFrom: QUICK_VIEW_OVERDUE_DATE_FROM,
      dateTo: yesterday,
      taskStatus: ['not_completed'],
    };
    setFilterApplied(filter);
    setFilterDraft(filter);
    setDatePickerValue('');
    setFilterDialogOpen(false);
  };
  const handleQuickViewThisWeek = () => {
    const { from, to } = getThisWeekRange();
    const filter: FilterState = {
      ...DEFAULT_FILTER,
      dateFrom: from,
      dateTo: to,
    };
    setFilterApplied(filter);
    setFilterDraft(filter);
    setDatePickerValue('');
    setFilterDialogOpen(false);
  };

  /** All tasks: no date filter, show everything. */
  const handleQuickViewAll = () => {
    const showAllFilter: FilterState = {
      ...DEFAULT_FILTER,
      dateFrom: ALL_TASKS_DATE_FROM,
      dateTo: ALL_TASKS_DATE_TO,
    };
    setFilterApplied(showAllFilter);
    setFilterDraft(showAllFilter);
    setDatePickerValue('');
    setFilterDialogOpen(false);
  };

  /** Upcoming: tasks from today onward — All (far future), Week (7 days), or Month (30 days). */
  const handleUpcomingAll = () => {
    const today = getTodayDateString();
    const filter: FilterState = {
      ...DEFAULT_FILTER,
      dateFrom: today,
      dateTo: UPCOMING_END_FAR,
    };
    setFilterApplied(filter);
    setFilterDraft(filter);
    setDatePickerValue('');
    setFilterDialogOpen(false);
  };
  const handleUpcomingWeek = () => {
    const { from, to } = getUpcomingWeekRange();
    const filter: FilterState = {
      ...DEFAULT_FILTER,
      dateFrom: from,
      dateTo: to,
    };
    setFilterApplied(filter);
    setFilterDraft(filter);
    setDatePickerValue('');
    setFilterDialogOpen(false);
  };
  const handleUpcomingMonth = () => {
    const { from, to } = getUpcomingMonthRange();
    const filter: FilterState = {
      ...DEFAULT_FILTER,
      dateFrom: from,
      dateTo: to,
    };
    setFilterApplied(filter);
    setFilterDraft(filter);
    setDatePickerValue('');
    setFilterDialogOpen(false);
  };

  /** Which quick view is active (for highlighting). Derived from current filter + date. */
  const activeQuickView = React.useMemo(() => {
    const today = getTodayDateString();
    const yesterday = getYesterdayDateString();
    const week = getThisWeekRange();
    const upcomingWeek = getUpcomingWeekRange();
    const upcomingMonth = getUpcomingMonthRange();
    // All tasks
    if (
      !datePickerValue &&
      filterApplied.dateFrom === ALL_TASKS_DATE_FROM &&
      filterApplied.dateTo === ALL_TASKS_DATE_TO &&
      filterApplied.priority.length === 0 &&
      filterApplied.taskStatus.length === 0
    ) {
      return 'all' as const;
    }
    // Today
    if (
      datePickerValue === today &&
      !filterApplied.dateFrom &&
      !filterApplied.dateTo &&
      filterApplied.priority.length === 0 &&
      filterApplied.taskStatus.length === 0
    ) {
      return 'today' as const;
    }
    // Overdue
    if (
      !datePickerValue &&
      filterApplied.dateFrom === QUICK_VIEW_OVERDUE_DATE_FROM &&
      filterApplied.dateTo === yesterday &&
      filterApplied.taskStatus.length === 1 &&
      filterApplied.taskStatus[0] === 'not_completed' &&
      filterApplied.priority.length === 0
    ) {
      return 'overdue' as const;
    }
    // This week
    if (
      !datePickerValue &&
      filterApplied.dateFrom === week.from &&
      filterApplied.dateTo === week.to &&
      filterApplied.priority.length === 0 &&
      filterApplied.taskStatus.length === 0
    ) {
      return 'this_week' as const;
    }
    // Upcoming: all (today -> far future)
    if (
      !datePickerValue &&
      filterApplied.dateFrom === today &&
      filterApplied.dateTo === UPCOMING_END_FAR &&
      filterApplied.priority.length === 0 &&
      filterApplied.taskStatus.length === 0
    ) {
      return 'upcoming_all' as const;
    }
    // Upcoming: week
    if (
      !datePickerValue &&
      filterApplied.dateFrom === upcomingWeek.from &&
      filterApplied.dateTo === upcomingWeek.to &&
      filterApplied.priority.length === 0 &&
      filterApplied.taskStatus.length === 0
    ) {
      return 'upcoming_week' as const;
    }
    // Upcoming: month
    if (
      !datePickerValue &&
      filterApplied.dateFrom === upcomingMonth.from &&
      filterApplied.dateTo === upcomingMonth.to &&
      filterApplied.priority.length === 0 &&
      filterApplied.taskStatus.length === 0
    ) {
      return 'upcoming_month' as const;
    }
    return null;
  }, [datePickerValue, filterApplied]);

  const handleOpen = React.useCallback(
    (activity: ActivityCardActivity) => {
      const item = activities.find((i) => i.activity.id === activity.id);
      const params = new URLSearchParams();
      params.set('id', activity.id);
      if (item?.contactId) params.set('contact_id', item.contactId);
      if (item?.companyId) params.set('company_id', item.companyId);
      if (item?.activity.contactName) params.set('contact_name', item.activity.contactName);
      if (item?.activity.accountName) params.set('account_name', item.activity.accountName);
      router.push(`/activity?${params.toString()}`);
    },
    [router, activities]
  );

  const handleCompleteClick = React.useCallback(
    (activity: ActivityCardActivity) => {
      if (isOffline) {
        showToast('warning', 'Working offline', 'Create and update are disabled until you\'re back online.');
        return;
      }
      setCompleteConfirmActivity(activity);
    },
    [showToast, isOffline]
  );

  const handleCompleteConfirm = React.useCallback(
    async () => {
      const activity = completeConfirmActivity;
      if (!activity) return;
      setCompletingId(activity.id);
      try {
        await completeActivity(activity.id);
        setCompleteConfirmActivity(null);
        showToast('success', 'Activity completed', `${activity.subject} marked as complete.`);
        // Sync with HubSpot so the app stays up to date with the recently updated database
        try {
          const res = await syncActivities();
          if (res.synced) {
            setLastSyncedAt(Date.now());
            setIsOffline(false);
          } else {
            showToast('warning', 'Sync warning', res.message ?? 'Sync with HubSpot did not complete.');
          }
        } catch (syncErr) {
          if (isNetworkError(syncErr)) setIsOffline(true);
          showToast('warning', 'Sync failed', syncErr instanceof Error ? syncErr.message : 'Could not sync with HubSpot.');
        }
        await queryClient.invalidateQueries({ queryKey: [ACTIVITIES_QUERY_KEY] });
      } catch (err) {
        showToast('error', 'Failed to complete activity', err instanceof Error ? err.message : 'Try again.');
      } finally {
        setCompletingId(null);
      }
    },
    [completeConfirmActivity, showToast, queryClient]
  );

  const handleRefresh = React.useCallback(async () => {
    setIsSyncing(true);
    try {
      const res = await syncActivities();
      if (res.synced) {
        setIsOffline(false);
        setLastSyncedAt(Date.now());
        showToast('success', 'Sync complete', `${res.tasks_count ?? 0} activities synced from HubSpot.`);
        await queryClient.invalidateQueries({ queryKey: [ACTIVITIES_QUERY_KEY] });
      } else {
        showToast('warning', 'Sync failed', res.message);
      }
    } catch (err) {
      if (isNetworkError(err)) setIsOffline(true);
      showToast('error', 'Sync failed', err instanceof Error ? err.message : 'Try again.');
    } finally {
      setIsSyncing(false);
    }
  }, [showToast, queryClient]);

  // Auto-refresh activities every 5 minutes
  React.useEffect(() => {
    if (!user || isOffline) return;
    const interval = setInterval(() => {
      handleRefresh();
    }, AUTO_SYNC_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [user, isOffline, handleRefresh]);

  const isLoading = isInitialLoad || isActivitiesLoading;
  const isStale = lastSyncedAt != null && Date.now() - lastSyncedAt > STALE_SYNC_THRESHOLD_MS;

  return (
    <ProtectedRoute>
    <TooltipProvider>
    <div className="flex flex-col gap-6 h-full min-h-0">
      {/* Offline banner */}
      {isOffline && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-4 py-2 text-sm text-amber-800 dark:text-amber-200"
        >
          <WifiOff className="h-4 w-4 shrink-0" />
          <span className="font-medium">Working offline</span>
          <span className="text-muted-foreground">— Create and update are disabled until the API is reachable.</span>
        </div>
      )}

      {/* Page Header */}
      <header className="shrink-0 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            {(user?.user_metadata?.full_name?.trim().split(/\s+/)[0] || 'My')}&apos;s Day
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {formatPageDate(new Date())}
          </p>
          {/* Sync status */}
          <div className="flex items-center gap-2 mt-1.5 text-xs text-muted-foreground">
            <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>Last synced: {formatLastSynced(lastSyncedAt)}</span>
            {isStale && lastSyncedAt != null && (
              <span className="flex items-center gap-1 text-amber-600 dark:text-amber-500">
                <AlertTriangle className="h-3.5 w-3.5" />
                Data may be stale
              </span>
            )}
          </div>
        </div>
      </header>

      {/* Filter Dialog */}
      <Dialog
        open={filterDialogOpen}
        onOpenChange={(open) => {
          setFilterDialogOpen(open);
          if (open) setFilterDraft(filterApplied);
        }}
      >
        <DialogContent className="max-w-md" showClose>
          <DialogHeader>
            <DialogTitle>Filter activities</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label>Priority</Label>
              <div className="flex flex-wrap gap-3">
                {PRIORITY_FILTER_OPTIONS.map((p) => (
                  <label
                    key={p}
                    className="flex items-center gap-2 text-sm cursor-pointer"
                  >
                    <Checkbox
                      checked={filterDraft.priority.includes(p)}
                      onCheckedChange={(checked) =>
                        setFilterDraft((prev) => ({
                          ...prev,
                          priority: checked
                            ? [...prev.priority, p]
                            : prev.priority.filter((x) => x !== p),
                        }))
                      }
                    />
                    {p.charAt(0).toUpperCase() + p.slice(1)}
                  </label>
                ))}
              </div>
            </div>
            <div className="grid gap-2">
              <Label>Task status</Label>
              <div className="flex flex-wrap gap-3">
                {TASK_STATUS_FILTER_OPTIONS.map((s) => (
                  <label
                    key={s}
                    className="flex items-center gap-2 text-sm cursor-pointer"
                  >
                    <Checkbox
                      checked={filterDraft.taskStatus.includes(s)}
                      onCheckedChange={(checked) =>
                        setFilterDraft((prev) => ({
                          ...prev,
                          taskStatus: checked
                            ? [...prev.taskStatus, s]
                            : prev.taskStatus.filter((x) => x !== s),
                        }))
                      }
                    />
                    {s === 'completed' ? 'Completed' : 'Not completed'}
                  </label>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="date-from">Date from</Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      id="date-from"
                      variant="outline"
                      className="w-full justify-start text-left font-normal"
                    >
                      <CalendarIcon className="mr-2 h-4 w-4 shrink-0" />
                      {filterDraft.dateFrom
                        ? format(new Date(filterDraft.dateFrom + 'T00:00:00'), 'dd MMM yyyy')
                        : 'Pick date'}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={filterDraft.dateFrom ? new Date(filterDraft.dateFrom + 'T00:00:00') : undefined}
                      onSelect={(d) =>
                        setFilterDraft((prev) => ({
                          ...prev,
                          dateFrom: d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : '',
                        }))
                      }
                    />
                  </PopoverContent>
                </Popover>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="date-to">Date to</Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      id="date-to"
                      variant="outline"
                      className="w-full justify-start text-left font-normal"
                    >
                      <CalendarIcon className="mr-2 h-4 w-4 shrink-0" />
                      {filterDraft.dateTo
                        ? format(new Date(filterDraft.dateTo + 'T00:00:00'), 'dd MMM yyyy')
                        : 'Pick date'}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={filterDraft.dateTo ? new Date(filterDraft.dateTo + 'T00:00:00') : undefined}
                      onSelect={(d) =>
                        setFilterDraft((prev) => ({
                          ...prev,
                          dateTo: d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : '',
                        }))
                      }
                    />
                  </PopoverContent>
                </Popover>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={handleClearFilter}>
              Clear
            </Button>
            <Button onClick={handleApplyFilter}>Apply</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Responsive: mobile stack, tablet 2-col, desktop 12-col grid; only activity list scrolls on desktop */}
      <div className="flex-1 min-h-0 grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-12 lg:items-stretch">
        {/* Left panel - Activity cards (6 cols on desktop), only this section scrolls */}
        <section className="flex flex-col min-h-0 lg:col-span-6 lg:flex-1 lg:overflow-hidden rounded-lg bg-section border border-border p-4">
          {/* Quick view presets: All, Today, This Week, Overdue, Upcoming */}
          <div className="flex flex-wrap items-center gap-2 shrink-0 mb-4">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={activeQuickView === 'all' ? 'secondary' : 'outline'}
                  size="sm"
                  className={cn(
                    'h-9 gap-1.5 shrink-0',
                    activeQuickView === 'all' && 'ring-2 ring-primary/50'
                  )}
                  onClick={handleQuickViewAll}
                  aria-pressed={activeQuickView === 'all'}
                  aria-label="Show all tasks"
                >
                  <ListTodo className="h-4 w-4 shrink-0" />
                  All
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                Show all tasks (any date, completed or not)
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={activeQuickView === 'today' ? 'secondary' : 'outline'}
                  size="sm"
                  className={cn(
                    'h-9 gap-1.5 shrink-0',
                    activeQuickView === 'today' && 'ring-2 ring-primary/50'
                  )}
                  onClick={handleQuickViewToday}
                  aria-pressed={activeQuickView === 'today'}
                  aria-label="Show today's tasks"
                >
                  <CalendarIcon className="h-4 w-4 shrink-0" />
                  Today
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                Show tasks due today ({format(new Date(), 'dd MMM yyyy')})
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={activeQuickView === 'this_week' ? 'secondary' : 'outline'}
                  size="sm"
                  className={cn(
                    'h-9 gap-1.5 shrink-0',
                    activeQuickView === 'this_week' && 'ring-2 ring-primary/50'
                  )}
                  onClick={handleQuickViewThisWeek}
                  aria-pressed={activeQuickView === 'this_week'}
                  aria-label="Show this week's tasks"
                >
                  <CalendarDays className="h-4 w-4 shrink-0" />
                  This Week
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                Show tasks for this calendar week (Mon–Sun)
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={activeQuickView === 'overdue' ? 'secondary' : 'outline'}
                  size="sm"
                  className={cn(
                    'h-9 gap-1.5 shrink-0',
                    activeQuickView === 'overdue' && 'ring-2 ring-primary/50'
                  )}
                  onClick={handleQuickViewOverdue}
                  aria-pressed={activeQuickView === 'overdue'}
                  aria-label="Show overdue tasks"
                >
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  Overdue
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                Show incomplete tasks with due dates before today
              </TooltipContent>
            </Tooltip>
            <Popover
              open={upcomingPopoverOpen}
              onOpenChange={(open) => {
                if (!open && upcomingPopoverCloseTimeoutRef.current) {
                  clearTimeout(upcomingPopoverCloseTimeoutRef.current);
                  upcomingPopoverCloseTimeoutRef.current = null;
                }
                setUpcomingPopoverOpen(open);
              }}
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <PopoverTrigger asChild>
                    <Button
                      variant={
                        activeQuickView === 'upcoming_all' ||
                        activeQuickView === 'upcoming_week' ||
                        activeQuickView === 'upcoming_month'
                          ? 'secondary'
                          : 'outline'
                      }
                      size="sm"
                      className={cn(
                        'h-9 gap-1.5 shrink-0',
                        (activeQuickView === 'upcoming_all' ||
                          activeQuickView === 'upcoming_week' ||
                          activeQuickView === 'upcoming_month') &&
                          'ring-2 ring-primary/50'
                      )}
                      aria-pressed={
                        activeQuickView === 'upcoming_all' ||
                        activeQuickView === 'upcoming_week' ||
                        activeQuickView === 'upcoming_month'
                      }
                      aria-label="Show upcoming tasks"
                      aria-haspopup="menu"
                      onMouseEnter={() => {
                        if (upcomingPopoverCloseTimeoutRef.current) {
                          clearTimeout(upcomingPopoverCloseTimeoutRef.current);
                          upcomingPopoverCloseTimeoutRef.current = null;
                        }
                        setUpcomingPopoverOpen(true);
                      }}
                      onMouseLeave={() => {
                        upcomingPopoverCloseTimeoutRef.current = window.setTimeout(
                          () => setUpcomingPopoverOpen(false),
                          150
                        );
                      }}
                    >
                      <CalendarRange className="h-4 w-4 shrink-0" />
                      Upcoming
                      <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />
                    </Button>
                  </PopoverTrigger>
                </TooltipTrigger>
                <TooltipContent>
                  Hover for options: All, Week, or Month
                </TooltipContent>
              </Tooltip>
              <PopoverContent
                className="w-40 p-1"
                align="start"
                onMouseEnter={() => {
                  if (upcomingPopoverCloseTimeoutRef.current) {
                    clearTimeout(upcomingPopoverCloseTimeoutRef.current);
                    upcomingPopoverCloseTimeoutRef.current = null;
                  }
                  setUpcomingPopoverOpen(true);
                }}
                onMouseLeave={() => {
                  upcomingPopoverCloseTimeoutRef.current = window.setTimeout(
                    () => setUpcomingPopoverOpen(false),
                    150
                  );
                }}
              >
                <div className="flex flex-col gap-0.5">
                  <Button
                    variant={activeQuickView === 'upcoming_all' ? 'secondary' : 'ghost'}
                    size="sm"
                    className="h-8 justify-start font-normal"
                    onClick={() => {
                      handleUpcomingAll();
                      setUpcomingPopoverOpen(false);
                    }}
                  >
                    All
                  </Button>
                  <Button
                    variant={activeQuickView === 'upcoming_week' ? 'secondary' : 'ghost'}
                    size="sm"
                    className="h-8 justify-start font-normal"
                    onClick={() => {
                      handleUpcomingWeek();
                      setUpcomingPopoverOpen(false);
                    }}
                  >
                    Week
                  </Button>
                  <Button
                    variant={activeQuickView === 'upcoming_month' ? 'secondary' : 'ghost'}
                    size="sm"
                    className="h-8 justify-start font-normal"
                    onClick={() => {
                      handleUpcomingMonth();
                      setUpcomingPopoverOpen(false);
                    }}
                  >
                    Month
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
          </div>
          {/* Activity search bar - search by title, contact, or company */}
          <div className="relative shrink-0 mb-3 w-full min-w-0">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" aria-hidden />
            <Input
              type="search"
              placeholder="Search by title, contact, or company..."
              value={activitySearchQuery}
              onChange={(e) => setActivitySearchQuery(e.target.value)}
              className="pl-9 h-9 w-full focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:border focus-visible:border-ring"
              aria-label="Search activities"
            />
          </div>
          <div className="flex flex-nowrap items-center gap-2 mb-4 shrink-0 w-full min-w-0">
            <Button
              variant="outline"
              size="sm"
              className={cn('h-9 w-9 min-w-9 p-0 shrink-0', hasActiveFilters && 'border-status-active bg-status-active/10')}
              aria-label="Filter"
              onClick={() => setFilterDialogOpen(true)}
            >
              <Filter className="h-4 w-4" />
            </Button>
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 min-w-[7rem] justify-start text-left font-normal"
                  aria-label="Filter by date"
                >
                  <CalendarIcon className="mr-2 h-4 w-4 shrink-0" />
                  <span className="truncate">
                    {datePickerValue
                      ? format(new Date(datePickerValue + 'T00:00:00'), 'dd MMM yyyy')
                      : 'Pick a date'}
                  </span>
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={datePickerValue ? new Date(datePickerValue + 'T00:00:00') : undefined}
                  onSelect={(d) => setDatePickerValue(d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : '')}
                />
              </PopoverContent>
            </Popover>
            <Select value={sort} onValueChange={(v) => setSort(v as SortOption)}>
              <SelectTrigger className="h-9 min-w-[7rem] focus:ring-0 focus:ring-offset-0">
                <ArrowUpDown className="h-4 w-4 opacity-50 mr-1 shrink-0" aria-hidden />
                <SelectValue placeholder="Sort by" />
              </SelectTrigger>
              <SelectContent>
                {SORT_OPTIONS.map((opt) => (
                  <SelectItem
                    key={opt.value}
                    value={opt.value}
                    disabled={opt.dateOnly ? !dateSortsAllowed : undefined}
                  >
                    {opt.label}
                    {opt.dateOnly && !dateSortsAllowed ? ' (all tasks only)' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex h-9 items-center shrink-0">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-9 gap-1.5 shrink-0"
                    onClick={handleClearAllFilters}
                    aria-label="Clear all filters and show all tasks"
                  >
                    <FilterX className="h-4 w-4" />
                    Clear all filters
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                Clear date and filters, then load all tasks from HubSpot (any date, completed or not).
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className={cn('inline-flex h-9 items-center shrink-0', isOffline && 'cursor-not-allowed')}>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-9 gap-1.5 shrink-0"
                    onClick={handleRefresh}
                    disabled={isSyncing || isLoading || isOffline}
                    aria-label="Sync activities from HubSpot"
                  >
                    <RefreshCw className={cn('h-4 w-4', isSyncing && 'animate-spin')} />
                    {isSyncing ? 'Syncing…' : 'Refresh'}
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {lastSyncedAt != null
                  ? `Last synced ${formatLastSynced(lastSyncedAt)}. Click to sync from HubSpot.`
                  : 'Sync activities from HubSpot.'}
              </TooltipContent>
            </Tooltip>
            <div className="flex-1 min-w-0" aria-hidden />
            {isOffline ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex h-9 items-center shrink-0">
                    <Button variant="default" size="sm" className="h-9 gap-1" disabled aria-hidden>
                      <Plus className="h-4 w-4" />
                      New Activity
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>Create and update are disabled while offline.</TooltipContent>
              </Tooltip>
            ) : (
              <Button asChild variant="default" size="sm" className="h-9 gap-1 shrink-0">
                <Link href="/activity" className="inline-flex h-9 items-center gap-1">
                  <Plus className="h-4 w-4" />
                  New Activity
                </Link>
              </Button>
            )}
          </div>
          <p className="text-sm text-muted-foreground shrink-0 mb-1 px-0.5" aria-live="polite">
            {filterHintText}
          </p>
          <div className="flex-1 min-h-0 overflow-y-auto space-y-3 pr-2">
            {isLoading ? (
              <div className="flex flex-col items-center justify-center py-12 gap-3 text-muted-foreground min-h-[200px]">
                <Loader2 className="h-8 w-8 animate-spin" />
                <span className="text-sm">Loading...</span>
              </div>
            ) : searchFilteredItems.length === 0 ? (
              <Card className="border-dashed">
                <CardContent className="p-0">
                  <EmptyState
                    icon={activitySearchQuery.trim() ? SearchX : hasActiveFilters || datePickerValue ? SearchX : ClipboardList}
                    title={
                      activitySearchQuery.trim()
                        ? `No activities match "${activitySearchQuery.trim()}".`
                        : hasActiveFilters || datePickerValue
                          ? 'No activities match your filters.'
                          : 'No activities yet. Create your first activity!'
                    }
                    description={
                      activitySearchQuery.trim()
                        ? 'Try a different keyword (subject, contact name, or company).'
                        : hasActiveFilters || datePickerValue
                          ? 'Try adjusting or clearing filters to see more results.'
                          : 'Add a note or activity to get started.'
                    }
                    action={
                      activitySearchQuery.trim()
                        ? { label: 'Clear search', onClick: () => setActivitySearchQuery('') }
                        : hasActiveFilters || datePickerValue
                          ? { label: 'Clear all filters', onClick: () => { handleClearAllFilters(); } }
                          : isOffline
                            ? { label: 'New Activity', onClick: () => showToast('warning', 'Working offline', 'Create and update are disabled until you\'re back online.') }
                            : { label: 'New Activity', onClick: () => router.push('/activity') }
                    }
                  />
                </CardContent>
              </Card>
            ) : (
              searchFilteredItems.map((item) => (
                <ActivityCard
                  key={item.activity.id}
                  activity={item.activity}
                  isSelected={selectedActivityId === item.activity.id}
                  completed={completedIds.has(item.activity.id)}
                  onClick={() => setSelectedActivityId(item.activity.id)}
                  onOpen={handleOpen}
                  onComplete={handleCompleteClick}
                />
              ))
            )}
          </div>
        </section>

        {/* Middle panel - Client notes (task notes) */}
        <section className="flex flex-col min-h-0 lg:col-span-3 lg:flex-shrink-0 lg:overflow-hidden rounded-lg bg-section border border-border p-4">
          <Card className="h-full min-h-0 overflow-hidden flex flex-col bg-card">
            <CardHeader className="pb-2 shrink-0">
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <FileText className="h-4 w-4 text-muted-foreground" />
                Client notes
              </h2>
            </CardHeader>
            <CardContent className="flex flex-col gap-4 flex-1 min-h-0 overflow-y-auto">
              {isLoading ? (
                <div className="flex flex-col items-center justify-center flex-1 py-12 gap-3 text-muted-foreground">
                  <Loader2 className="h-8 w-8 animate-spin" />
                  <span className="text-sm">Loading...</span>
                </div>
              ) : selectedItem ? (
                <div className="rounded-md border border-border bg-muted/30 p-3 min-h-0 overflow-y-auto">
                  <p className="text-sm text-foreground whitespace-pre-wrap">
                    {selectedItem.activity.noteExcerpt
                      ? stripHtml(selectedItem.activity.noteExcerpt)
                      : 'No notes saved for this task.'}
                  </p>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Select an activity to see client notes.
                </p>
              )}
            </CardContent>
          </Card>
        </section>

        {/* Right panel - Contact preview (full width on tablet below the 2 cols, 3 cols on desktop), fixed; scrolls internally if needed */}
        <section className="flex flex-col min-h-0 md:col-span-2 lg:col-span-3 lg:flex-shrink-0 lg:overflow-hidden rounded-lg bg-section border border-border p-4">
          <Card className="h-full min-h-0 overflow-hidden flex flex-col bg-card">
            <CardHeader className="pb-3 shrink-0">
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <User className="h-4 w-4 text-muted-foreground" />
                Contact Preview
              </h2>
            </CardHeader>
            {isLoading ? (
              <CardContent className="flex-1 min-h-0 flex flex-col items-center justify-center py-12 gap-3 text-muted-foreground">
                <Loader2 className="h-8 w-8 animate-spin" />
                <span className="text-sm">Loading...</span>
              </CardContent>
            ) : (
              <CardContent className="flex-1 min-h-0 overflow-y-auto">
                <ContactPreview contact={selectedContact} />
              </CardContent>
            )}
          </Card>
        </section>
      </div>

      {/* Complete confirmation dialog */}
      <Dialog open={!!completeConfirmActivity} onOpenChange={(open) => !open && setCompleteConfirmActivity(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Mark activity as complete</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Mark this Activity as complete?
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCompleteConfirmActivity(null)}>
              Cancel
            </Button>
            <Button onClick={handleCompleteConfirm} disabled={!completeConfirmActivity || completingId === completeConfirmActivity?.id}>
              Yes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Toast */}
      <Toast
        open={toast.open}
        onOpenChange={(open) => !open && setToast((p) => ({ ...p, open: false }))}
        variant={toast.variant}
      >
        <ToastTitle>{toast.title}</ToastTitle>
        {toast.description && (
          <ToastDescription>{toast.description}</ToastDescription>
        )}
        <ToastClose />
      </Toast>
    </div>
    </TooltipProvider>
    </ProtectedRoute>
  );
}

