'use client';

import * as React from 'react';
import { useSearchParams } from 'next/navigation';
import ProtectedRoute from '@/components/ProtectedRoute';
import {
  Building2,
  Mail,
  ChevronDown,
  ChevronUp,
  Loader2,
  Activity,
  RefreshCw,
} from 'lucide-react';
import { Skeleton } from '@/components/shared/skeleton';
import { EmptyState } from '@/components/shared/empty-state';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Toast,
  ToastTitle,
  ToastDescription,
  ToastClose,
} from '@/components/ui/toast';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import {
  disconnectGmail,
  getGmailConnectUrl,
  getGmailStatus,
  getSyncLogs,
  getOperationLogs,
  type SyncLogEntry as ApiSyncLogEntry,
  type SyncLogListResponse,
  type OperationLogEntry as ApiOperationLogEntry,
  type OperationLogListResponse,
} from '@/lib/api/integrations';
import { syncActivities } from '@/lib/api/activities';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type IntegrationId = 'hubspot' | 'email';
type SyncStatus = 'success' | 'error';
type OpLogTab = 'task' | 'contact' | 'company' | 'llm_call';

interface IntegrationTile {
  id: IntegrationId;
  name: string;
  icon: React.ElementType;
  brandBg: string;
  status: 'connected' | 'disconnected';
}

const INTEGRATIONS: IntegrationTile[] = [
  {
    id: 'hubspot',
    name: 'HubSpot CRM',
    icon: Building2,
    brandBg: 'bg-orange-500/15',
    status: 'connected',
  },
  {
    id: 'email',
    name: 'Email Inbox',
    icon: Mail,
    brandBg: 'bg-blue-500/15',
    status: 'connected',
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function opLabel(operation: string): string {
  const map: Record<string, string> = {
    generate_summary: 'Generate Summary',
    extract_date: 'Extract Date',
    recommend_touch: 'Recommend Touch Date',
    extract_metadata: 'Extract Metadata',
    generate_drafts: 'Generate Drafts',
    generate_email_drafts: 'Generate Email Drafts',
    generate_activity_note: 'Generate Activity Note',
    extract_contact_from_email: 'Extract Contact from Email',
    create: 'Create',
    update: 'Update',
    delete: 'Delete',
  };
  return map[operation] ?? operation;
}

// ---------------------------------------------------------------------------
// Page (cache loaded state across navigation)
// ---------------------------------------------------------------------------

let integrationsLoadedOnce = false;

function IntegrationTileSkeleton() {
  return (
    <Card className="overflow-hidden shadow-card">
      <div className="p-6 flex items-center justify-center bg-muted/30">
        <Skeleton variant="circle" className="h-12 w-12" />
      </div>
      <CardContent className="p-4 space-y-3">
        <Skeleton variant="text" className="h-5 w-32" />
        <div className="flex items-center justify-between gap-2">
          <Skeleton variant="text" className="h-5 w-24 rounded-full" />
          <Skeleton variant="rectangle" className="h-9 w-20" />
        </div>
        <Skeleton variant="text" className="h-3 w-28" />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Reusable operation log table panel (Tasks / Contacts / Companies / LLM)
// ---------------------------------------------------------------------------

function OperationLogPanel({
  entityType,
}: {
  entityType: OpLogTab;
}) {
  const PAGE_SIZE = 10;
  const [statusFilter, setStatusFilter] = React.useState<'all' | SyncStatus>('all');
  const [page, setPage] = React.useState(1);
  const [data, setData] = React.useState<OperationLogListResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<ApiOperationLogEntry | null>(null);

  const fetch = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getOperationLogs({
        entity_type: entityType,
        status: statusFilter,
        page,
        page_size: PAGE_SIZE,
      });
      setData(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load logs');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [entityType, statusFilter, page]);

  React.useEffect(() => {
    fetch();
  }, [fetch]);

  // Reset to page 1 when filter changes
  const handleStatusChange = (v: string) => {
    setStatusFilter(v as 'all' | SyncStatus);
    setPage(1);
  };

  const entries = data?.entries ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / PAGE_SIZE) || 1;
  const showEntity = entityType !== 'llm_call';

  return (
    <Card>
      <CardContent className="p-0">
        <div className="flex flex-wrap items-center gap-4 p-4 border-b">
          <Label className="text-sm">Status</Label>
          <Select value={statusFilter} onValueChange={handleStatusChange}>
            <SelectTrigger className="w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="success">Success</SelectItem>
              <SelectItem value="error">Error</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="ghost" size="sm" className="ml-auto gap-1.5" onClick={() => fetch()}>
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </Button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span className="text-sm">Loading…</span>
          </div>
        ) : error ? (
          <div className="py-10 px-4 text-center">
            <p className="text-sm text-status-at-risk">{error}</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => fetch()}>
              Retry
            </Button>
          </div>
        ) : !entries.length ? (
          <EmptyState
            icon={Activity}
            title="No logs yet."
            description="Operations will be logged here as you use the app."
            className="py-10"
          />
        ) : (
          <>
            {/* Mobile: card list */}
            <div className="md:hidden space-y-3 p-4">
              {entries.map((entry) => (
                <div
                  key={entry.id}
                  className="rounded-lg border border-border bg-card p-4 space-y-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-sm">{opLabel(entry.operation)}</span>
                    <span
                      className={cn(
                        'text-xs font-medium px-2 py-0.5 rounded-full shrink-0',
                        entry.status === 'success'
                          ? 'bg-status-warm/15 text-status-warm'
                          : 'bg-status-at-risk/15 text-status-at-risk'
                      )}
                    >
                      {entry.status === 'success' ? 'Success' : 'Error'}
                    </span>
                  </div>
                  {showEntity && entry.entity_name && (
                    <p className="text-xs text-muted-foreground truncate">{entry.entity_name}</p>
                  )}
                  {entry.error_message && (
                    <p className="text-xs text-status-at-risk truncate" title={entry.error_message}>
                      {entry.error_message}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {formatTimestamp(entry.created_at)} · {formatDuration(entry.duration_ms)}
                  </p>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 mt-1"
                    onClick={() => setSelected(entry)}
                  >
                    View Details
                  </Button>
                </div>
              ))}
            </div>
            {/* Desktop: table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="text-left p-3 font-medium">Operation</th>
                    {showEntity && <th className="text-left p-3 font-medium">Entity</th>}
                    <th className="text-left p-3 font-medium">Status</th>
                    {!showEntity && <th className="text-left p-3 font-medium">Error</th>}
                    <th className="text-left p-3 font-medium">Timestamp</th>
                    <th className="text-left p-3 font-medium">Duration</th>
                    <th className="text-left p-3 font-medium w-24" />
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => (
                    <tr key={entry.id} className="border-b last:border-0">
                      <td className="p-3 font-medium">{opLabel(entry.operation)}</td>
                      {showEntity && (
                        <td className="p-3 text-muted-foreground max-w-[160px] truncate">
                          {entry.entity_name || entry.entity_id || '—'}
                        </td>
                      )}
                      <td className="p-3">
                        <span
                          className={cn(
                            'text-xs font-medium px-2 py-0.5 rounded-full',
                            entry.status === 'success'
                              ? 'bg-status-warm/15 text-status-warm'
                              : 'bg-status-at-risk/15 text-status-at-risk'
                          )}
                        >
                          {entry.status === 'success' ? 'Success' : 'Error'}
                        </span>
                      </td>
                      {!showEntity && (
                        <td className="p-3 max-w-[220px]">
                          {entry.error_message ? (
                            <span
                              className="text-xs text-status-at-risk truncate block"
                              title={entry.error_message}
                            >
                              {entry.error_message}
                            </span>
                          ) : entry.response_summary ? (
                            <span className="text-xs text-muted-foreground truncate block" title={entry.response_summary}>
                              {entry.response_summary}
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </td>
                      )}
                      <td className="p-3 text-muted-foreground whitespace-nowrap">
                        {formatTimestamp(entry.created_at)}
                      </td>
                      <td className="p-3 whitespace-nowrap">{formatDuration(entry.duration_ms)}</td>
                      <td className="p-3">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8"
                          onClick={() => setSelected(entry)}
                        >
                          View Details
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 p-4 border-t">
              <p className="text-xs text-muted-foreground">
                Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total}
              </p>
              <div className="flex gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                >
                  Next
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>

      {/* Detail dialog */}
      <Dialog open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent className="max-w-md" showClose>
          {selected && (
            <>
              <DialogHeader>
                <DialogTitle>Operation details</DialogTitle>
                <DialogDescription>
                  {opLabel(selected.operation)} ·{' '}
                  {selected.status === 'success' ? 'Success' : 'Error'}
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-3 text-sm">
                <div className="grid grid-cols-[130px_1fr] gap-2">
                  <span className="text-muted-foreground">Operation</span>
                  <span>{opLabel(selected.operation)}</span>
                </div>
                <div className="grid grid-cols-[130px_1fr] gap-2">
                  <span className="text-muted-foreground">Type</span>
                  <span className="capitalize">{selected.entity_type.replace('_', ' ')}</span>
                </div>
                {selected.entity_name && (
                  <div className="grid grid-cols-[130px_1fr] gap-2">
                    <span className="text-muted-foreground">Entity</span>
                    <span>{selected.entity_name}</span>
                  </div>
                )}
                {selected.entity_id && (
                  <div className="grid grid-cols-[130px_1fr] gap-2">
                    <span className="text-muted-foreground">Entity ID</span>
                    <span className="font-mono text-xs break-all">{selected.entity_id}</span>
                  </div>
                )}
                <div className="grid grid-cols-[130px_1fr] gap-2">
                  <span className="text-muted-foreground">Status</span>
                  <span
                    className={cn(
                      'font-medium',
                      selected.status === 'success' ? 'text-status-warm' : 'text-status-at-risk'
                    )}
                  >
                    {selected.status === 'success' ? 'Success' : 'Error'}
                  </span>
                </div>
                {selected.http_status_code != null && (
                  <div className="grid grid-cols-[130px_1fr] gap-2">
                    <span className="text-muted-foreground">HTTP Status</span>
                    <span>{selected.http_status_code}</span>
                  </div>
                )}
                {selected.error_code && (
                  <div className="grid grid-cols-[130px_1fr] gap-2">
                    <span className="text-muted-foreground">Error Code</span>
                    <span className="font-mono text-xs">{selected.error_code}</span>
                  </div>
                )}
                {selected.error_message && (
                  <div className="grid grid-cols-[130px_1fr] gap-2">
                    <span className="text-muted-foreground">Error</span>
                    <p className="text-status-at-risk break-words">{selected.error_message}</p>
                  </div>
                )}
                {selected.response_summary && !selected.error_message && (
                  <div className="grid grid-cols-[130px_1fr] gap-2">
                    <span className="text-muted-foreground">Summary</span>
                    <p className="text-muted-foreground break-words">{selected.response_summary}</p>
                  </div>
                )}
                <div className="grid grid-cols-[130px_1fr] gap-2">
                  <span className="text-muted-foreground">Duration</span>
                  <span>{formatDuration(selected.duration_ms)}</span>
                </div>
                <div className="grid grid-cols-[130px_1fr] gap-2">
                  <span className="text-muted-foreground">Timestamp</span>
                  <span>{formatTimestamp(selected.created_at)}</span>
                </div>
                {selected.metadata && Object.keys(selected.metadata).length > 0 && (
                  <div className="grid grid-cols-[130px_1fr] gap-2">
                    <span className="text-muted-foreground">Metadata</span>
                    <pre className="text-xs bg-muted/50 rounded p-2 overflow-x-auto">
                      {JSON.stringify(selected.metadata, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Inner page component
// ---------------------------------------------------------------------------

function IntegrationsPageInner(): React.ReactElement {
  const searchParams = useSearchParams();
  const [tilesLoading, setTilesLoading] = React.useState(!integrationsLoadedOnce);
  React.useEffect(() => {
    if (integrationsLoadedOnce) {
      setTilesLoading(false);
      return;
    }
    const t = setTimeout(() => {
      integrationsLoadedOnce = true;
      setTilesLoading(false);
    }, 600);
    return () => clearTimeout(t);
  }, []);
  const [expandedSettings, setExpandedSettings] = React.useState<IntegrationId | null>(null);

  const connectionSettingsRef = React.useRef<HTMLDivElement>(null);

  // Deep-link: open Email Inbox connection settings when ?expand=email, then scroll to it
  React.useEffect(() => {
    if (searchParams.get('expand') === 'email') {
      setExpandedSettings('email');
    }
  }, [searchParams]);

  // After expanding email via ?expand=email, scroll Connection Settings into view
  React.useEffect(() => {
    if (searchParams.get('expand') !== 'email' || expandedSettings !== 'email') return;
    const el = connectionSettingsRef.current;
    if (!el) return;
    const t = requestAnimationFrame(() => {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    return () => cancelAnimationFrame(t);
  }, [searchParams, expandedSettings]);
  const [testLoading, setTestLoading] = React.useState<IntegrationId | null>(null);

  // Sync log state
  const [syncLogFilter, setSyncLogFilter] = React.useState<'all' | SyncStatus>('all');
  const [syncLogSource, setSyncLogSource] = React.useState<'all' | 'hubspot' | 'email'>('all');
  const [syncLogPage, setSyncLogPage] = React.useState(1);
  const [syncLogData, setSyncLogData] = React.useState<SyncLogListResponse | null>(null);
  const [syncLogLoading, setSyncLogLoading] = React.useState(true);
  const [syncLogError, setSyncLogError] = React.useState<string | null>(null);
  const [selectedLogEntry, setSelectedLogEntry] = React.useState<ApiSyncLogEntry | null>(null);
  const [hubspotSyncLoading, setHubspotSyncLoading] = React.useState(false);
  const [hubspotLastSync, setHubspotLastSync] = React.useState<string | null>(null);
  const [hubspotLastSyncLoading, setHubspotLastSyncLoading] = React.useState(true);
  const SYNC_PAGE_SIZE = 10;

  const [toast, setToast] = React.useState<{
    open: boolean;
    variant: 'success' | 'error' | 'default';
    title: string;
    description?: string;
  }>({ open: false, variant: 'default', title: '' });
  const [gmailStatus, setGmailStatus] = React.useState<{
    connected: boolean | null;
    email: string | null;
    last_connected_at: string | null;
  }>({ connected: null, email: null, last_connected_at: null });
  const gmailConnected = gmailStatus.connected;
  const [gmailActionLoading, setGmailActionLoading] = React.useState(false);

  const showToast = (variant: 'success' | 'error', title: string, description?: string) => {
    setToast({ open: true, variant, title, description });
  };

  const handleTestConnection = async (id: IntegrationId) => {
    setTestLoading(id);
    try {
      await new Promise((r) => setTimeout(r, 1500));
      showToast('success', 'Connection successful', `${INTEGRATIONS.find((i) => i.id === id)?.name} is connected.`);
    } catch {
      showToast('error', 'Connection failed', 'Check your API key and try again.');
    }
    setTestLoading(null);
  };

  // Fetch Gmail status on mount so the Email Inbox tile shows correct status
  React.useEffect(() => {
    let cancelled = false;
    getGmailStatus()
      .then((data) => {
        if (!cancelled) {
          setGmailStatus({
            connected: data.connected,
            email: data.connected && data.email ? data.email : null,
            last_connected_at: data.connected && data.last_connected_at ? data.last_connected_at : null,
          });
        }
      })
      .catch(() => {
        if (!cancelled) setGmailStatus({ connected: false, email: null, last_connected_at: null });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Re-fetch Gmail status when user expands the Email Inbox section
  React.useEffect(() => {
    if (expandedSettings !== 'email') return;
    let cancelled = false;
    getGmailStatus()
      .then((data) => {
        if (!cancelled) {
          setGmailStatus({
            connected: data.connected,
            email: data.connected && data.email ? data.email : null,
            last_connected_at: data.connected && data.last_connected_at ? data.last_connected_at : null,
          });
        }
      })
      .catch(() => {
        if (!cancelled) setGmailStatus({ connected: false, email: null, last_connected_at: null });
      });
    return () => {
      cancelled = true;
    };
  }, [expandedSettings]);

  const handleConnectGmail = async () => {
    setGmailActionLoading(true);
    try {
      const { url } = await getGmailConnectUrl();
      window.location.href = url;
    } catch {
      showToast('error', 'Failed to start Gmail connection');
      setGmailActionLoading(false);
    }
  };

  const handleDisconnectGmail = async () => {
    setGmailActionLoading(true);
    try {
      await disconnectGmail();
      setGmailStatus({ connected: false, email: null, last_connected_at: null });
      showToast('success', 'Gmail disconnected');
    } catch {
      showToast('error', 'Failed to disconnect Gmail');
    } finally {
      setGmailActionLoading(false);
    }
  };

  const fetchSyncLog = React.useCallback(async () => {
    setSyncLogLoading(true);
    setSyncLogError(null);
    try {
      const data = await getSyncLogs({
        status: syncLogFilter,
        source: syncLogSource,
        page: syncLogPage,
        page_size: SYNC_PAGE_SIZE,
      });
      setSyncLogData(data);
    } catch (e) {
      setSyncLogError(e instanceof Error ? e.message : 'Failed to load sync log');
      setSyncLogData(null);
    } finally {
      setSyncLogLoading(false);
    }
  }, [syncLogFilter, syncLogSource, syncLogPage]);

  React.useEffect(() => {
    fetchSyncLog();
  }, [fetchSyncLog]);

  const fetchHubspotLastSync = React.useCallback(async () => {
    setHubspotLastSyncLoading(true);
    try {
      const data = await getSyncLogs({ source: 'hubspot', page: 1, page_size: 1 });
      setHubspotLastSync(data.entries[0]?.finished_at ?? null);
    } catch {
      setHubspotLastSync(null);
    } finally {
      setHubspotLastSyncLoading(false);
    }
  }, []);

  React.useEffect(() => {
    fetchHubspotLastSync();
  }, [fetchHubspotLastSync]);

  const handleSyncNowHubSpot = async () => {
    setHubspotSyncLoading(true);
    try {
      const result = await syncActivities();
      if (result.synced) {
        showToast(
          'success',
          'Sync completed',
          result.tasks_count != null
            ? `Synced ${result.tasks_count} task${result.tasks_count === 1 ? '' : 's'} from HubSpot.`
            : undefined
        );
      } else {
        showToast('error', 'Sync failed', result.message ?? undefined);
      }
      await Promise.all([fetchSyncLog(), fetchHubspotLastSync()]);
    } catch {
      showToast('error', 'Sync failed', 'Could not run HubSpot activities sync.');
      await Promise.all([fetchSyncLog(), fetchHubspotLastSync()]);
    } finally {
      setHubspotSyncLoading(false);
    }
  };

  const syncTotalPages = syncLogData ? Math.ceil(syncLogData.total / SYNC_PAGE_SIZE) || 1 : 1;
  const paginatedLog = syncLogData?.entries ?? [];

  return (
    <ProtectedRoute>
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">Integrations</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage connected services and view sync status
        </p>
      </header>

      {/* Integration Tiles */}
      <section className="rounded-xl bg-section border border-border p-5">
        <h2 className="text-lg font-semibold mb-4">Services</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {tilesLoading ? (
            <>
              {[1, 2, 3].map((i) => (
                <IntegrationTileSkeleton key={i} />
              ))}
            </>
          ) : (
            INTEGRATIONS.map((int) => {
              const Icon = int.icon;
              const isEmail = int.id === 'email';
              const tileStatus =
                isEmail && gmailConnected !== null
                  ? gmailConnected
                    ? 'connected'
                    : 'disconnected'
                  : int.status;
              return (
                <Card key={int.id} className="overflow-hidden shadow-card">
                  <div className={cn('p-6 flex items-center justify-center', int.brandBg)}>
                    <Icon className="h-12 w-12 text-foreground/80" />
                  </div>
                  <CardContent className="p-4 space-y-3">
                    <p className="font-semibold">{int.name}</p>
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={cn(
                          'text-xs font-medium px-2 py-0.5 rounded-full',
                          tileStatus === 'connected'
                            ? 'bg-status-warm/15 text-status-warm'
                            : 'bg-muted text-muted-foreground'
                        )}
                      >
                        {isEmail && gmailConnected === null
                          ? 'Checking…'
                          : tileStatus === 'connected'
                            ? 'Connected'
                            : 'Disconnected'}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {isEmail
                        ? gmailStatus.last_connected_at
                          ? `Last connected: ${formatTimestamp(gmailStatus.last_connected_at)}`
                          : 'Last connected: —'
                        : hubspotLastSyncLoading
                          ? 'Last sync: —'
                          : hubspotLastSync
                            ? `Last sync: ${formatTimestamp(hubspotLastSync)}`
                            : 'Last sync: —'}
                    </p>
                  </CardContent>
                </Card>
              );
            })
          )}
        </div>
      </section>

      {/* Connection Settings (collapsible per integration) */}
      <section ref={connectionSettingsRef} className="rounded-xl bg-section border border-border p-5">
        <h2 className="text-lg font-semibold mb-4">Connection Settings</h2>
        <div className="space-y-2">
          {INTEGRATIONS.map((int) => {
            const isExpanded = expandedSettings === int.id;
            return (
              <Card key={int.id}>
                <button
                  type="button"
                  className="w-full flex items-center justify-between p-4 text-left hover:bg-muted/50 transition-colors"
                  onClick={() => setExpandedSettings(isExpanded ? null : int.id)}
                >
                  <CardTitle className="text-base font-medium">{int.name}</CardTitle>
                  {isExpanded ? (
                    <ChevronUp className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                  )}
                </button>
                {isExpanded && (
                  <CardContent className="pt-0 pb-4 border-t">
                    {int.id === 'hubspot' && (
                      <>
                        <Card className="mt-4 rounded-lg border border-border bg-card shadow-card">
                          <CardContent className="p-4">
                            <div className="flex items-center justify-between gap-3">
                              <div className="flex flex-col gap-0.5">
                                <div className="flex items-center gap-2">
                                  <span className="font-medium text-foreground">HubSpot CRM</span>
                                  <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-status-warm/15 text-status-warm">
                                    Connected
                                  </span>
                                </div>
                                <p className="text-sm text-muted-foreground">
                                  Connected via API
                                </p>
                              </div>
                            </div>
                          </CardContent>
                        </Card>
                        <div className="mt-4 flex flex-wrap items-center gap-3">
                          <Button
                            onClick={() => handleTestConnection(int.id)}
                            disabled={testLoading !== null}
                            className="gap-2"
                          >
                            {testLoading === int.id ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : null}
                            Test Connection
                          </Button>
                          <Button
                            variant="outline"
                            onClick={handleSyncNowHubSpot}
                            disabled={hubspotSyncLoading}
                            className="gap-2"
                          >
                            {hubspotSyncLoading ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <RefreshCw className="h-4 w-4" />
                            )}
                            Sync now
                          </Button>
                          {int.status === 'connected' && (
                            <span className="flex items-center gap-1.5 text-sm text-status-warm">
                              <span className="h-2 w-2 rounded-full bg-status-warm" />
                              Active
                            </span>
                          )}
                        </div>
                      </>
                    )}
                    {int.id === 'email' && (
                      <>
                        <Card className="mt-4 rounded-lg border border-border bg-card shadow-card">
                          <CardContent className="p-4">
                            {gmailConnected === null ? (
                              <p className="text-sm text-muted-foreground">Checking Gmail…</p>
                            ) : gmailConnected ? (
                              <>
                                <div className="flex items-start justify-between gap-3">
                                  <div className="flex flex-col gap-0.5 min-w-0">
                                    <div className="flex items-center gap-2 flex-wrap">
                                      <span className="font-medium text-foreground">Gmail</span>
                                      <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-status-warm/15 text-status-warm shrink-0">
                                        Connected
                                      </span>
                                    </div>
                                    {gmailStatus.email && (
                                      <p className="text-sm text-muted-foreground truncate" title={gmailStatus.email}>
                                        {gmailStatus.email}
                                      </p>
                                    )}
                                  </div>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={handleDisconnectGmail}
                                    disabled={gmailActionLoading}
                                    className="shrink-0 gap-1.5 h-8 text-muted-foreground hover:text-foreground"
                                  >
                                    {gmailActionLoading && <Loader2 className="h-4 w-4 animate-spin" />}
                                    Disconnect
                                  </Button>
                                </div>
                              </>
                            ) : (
                              <div className="flex items-center justify-between gap-3">
                                <div className="flex flex-col gap-0.5">
                                  <span className="font-medium text-foreground">Gmail</span>
                                  <p className="text-sm text-muted-foreground">
                                    Connect your Gmail account to sync email
                                  </p>
                                </div>
                                <Button
                                  onClick={handleConnectGmail}
                                  disabled={gmailActionLoading}
                                  size="sm"
                                  className="shrink-0 gap-1.5"
                                >
                                  {gmailActionLoading && <Loader2 className="h-4 w-4 animate-spin" />}
                                  Connect Gmail
                                </Button>
                              </div>
                            )}
                          </CardContent>
                        </Card>
                      </>
                    )}
                  </CardContent>
                )}
              </Card>
            );
          })}
        </div>
      </section>

      {/* Activity Logs — tabbed panel */}
      <section className="rounded-xl bg-section border border-border p-5">
        <h2 className="text-lg font-semibold mb-4">Activity Logs</h2>
        <Tabs defaultValue="sync">
          <TabsList className="mb-4 flex-wrap h-auto gap-1">
            <TabsTrigger value="sync">Sync Logs</TabsTrigger>
            <TabsTrigger value="task">Tasks</TabsTrigger>
            <TabsTrigger value="contact">Contacts</TabsTrigger>
            <TabsTrigger value="company">Companies</TabsTrigger>
            <TabsTrigger value="llm_call">LLM Calls</TabsTrigger>
          </TabsList>

          {/* Sync Logs tab (existing) */}
          <TabsContent value="sync">
            <Card>
              <CardContent className="p-0">
                <div className="flex flex-wrap items-center gap-4 p-4 border-b">
                  <Label className="text-sm">Status</Label>
                  <Select
                    value={syncLogFilter}
                    onValueChange={(v) => {
                      setSyncLogFilter(v as 'all' | SyncStatus);
                      setSyncLogPage(1);
                    }}
                  >
                    <SelectTrigger className="w-[140px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All</SelectItem>
                      <SelectItem value="success">Success</SelectItem>
                      <SelectItem value="error">Error</SelectItem>
                    </SelectContent>
                  </Select>
                  <Label className="text-sm">Source</Label>
                  <Select
                    value={syncLogSource}
                    onValueChange={(v) => {
                      setSyncLogSource(v as 'all' | 'hubspot' | 'email');
                      setSyncLogPage(1);
                    }}
                  >
                    <SelectTrigger className="w-[140px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All</SelectItem>
                      <SelectItem value="hubspot">HubSpot</SelectItem>
                      <SelectItem value="email">Email</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {syncLogLoading ? (
                  <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
                    <Loader2 className="h-5 w-5 animate-spin" />
                    <span className="text-sm">Loading sync log…</span>
                  </div>
                ) : syncLogError ? (
                  <div className="py-10 px-4 text-center">
                    <p className="text-sm text-status-at-risk">{syncLogError}</p>
                    <Button variant="outline" size="sm" className="mt-3" onClick={() => fetchSyncLog()}>
                      Retry
                    </Button>
                  </div>
                ) : !paginatedLog.length ? (
                  <EmptyState
                    icon={Activity}
                    title="No sync activities yet."
                    description={'Run a sync from Connection Settings (e.g. HubSpot "Sync now") or sync events will appear here when integrations run.'}
                    className="py-10"
                  />
                ) : (
                  <>
                    {/* Mobile: card list */}
                    <div className="md:hidden space-y-3 p-4">
                      {paginatedLog.map((entry) => (
                        <div
                          key={entry.id}
                          className="rounded-lg border border-border bg-card p-4 space-y-2"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-medium text-sm">{entry.action}</span>
                            <span
                              className={cn(
                                'text-xs font-medium px-2 py-0.5 rounded-full shrink-0',
                                entry.status === 'success'
                                  ? 'bg-status-warm/15 text-status-warm'
                                  : 'bg-status-at-risk/15 text-status-at-risk'
                              )}
                            >
                              {entry.status === 'success' ? 'Success' : 'Error'}
                            </span>
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {formatTimestamp(entry.started_at)} · {formatDuration(entry.duration_ms)}
                          </p>
                          {entry.details && (
                            <p className="text-xs text-muted-foreground truncate" title={entry.details}>
                              {entry.details}
                            </p>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 mt-1"
                            onClick={() => setSelectedLogEntry(entry)}
                          >
                            View Details
                          </Button>
                        </div>
                      ))}
                    </div>
                    {/* Desktop: table */}
                    <div className="hidden md:block overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b bg-muted/50">
                            <th className="text-left p-3 font-medium">Action</th>
                            <th className="text-left p-3 font-medium">Status</th>
                            <th className="text-left p-3 font-medium">Timestamp</th>
                            <th className="text-left p-3 font-medium">Duration</th>
                            <th className="text-left p-3 font-medium w-24" />
                          </tr>
                        </thead>
                        <tbody>
                          {paginatedLog.map((entry) => (
                            <tr key={entry.id} className="border-b last:border-0">
                              <td className="p-3">{entry.action}</td>
                              <td className="p-3">
                                <span
                                  className={cn(
                                    'text-xs font-medium px-2 py-0.5 rounded-full',
                                    entry.status === 'success'
                                      ? 'bg-status-warm/15 text-status-warm'
                                      : 'bg-status-at-risk/15 text-status-at-risk'
                                  )}
                                >
                                  {entry.status === 'success' ? 'Success' : 'Error'}
                                </span>
                              </td>
                              <td className="p-3 text-muted-foreground">
                                {formatTimestamp(entry.started_at)}
                              </td>
                              <td className="p-3">{formatDuration(entry.duration_ms)}</td>
                              <td className="p-3">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-8"
                                  onClick={() => setSelectedLogEntry(entry)}
                                >
                                  View Details
                                </Button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 p-4 border-t">
                      <p className="text-xs text-muted-foreground">
                        Showing {(syncLogPage - 1) * SYNC_PAGE_SIZE + 1}–
                        {Math.min(syncLogPage * SYNC_PAGE_SIZE, syncLogData?.total ?? 0)} of {syncLogData?.total ?? 0}
                      </p>
                      <div className="flex gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={syncLogPage <= 1}
                          onClick={() => setSyncLogPage((p) => Math.max(1, p - 1))}
                        >
                          Previous
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={syncLogPage >= syncTotalPages}
                          onClick={() => setSyncLogPage((p) => Math.min(syncTotalPages, p + 1))}
                        >
                          Next
                        </Button>
                      </div>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Tasks, Contacts, Companies, LLM Calls — shared OperationLogPanel */}
          <TabsContent value="task">
            <OperationLogPanel entityType="task" />
          </TabsContent>
          <TabsContent value="contact">
            <OperationLogPanel entityType="contact" />
          </TabsContent>
          <TabsContent value="company">
            <OperationLogPanel entityType="company" />
          </TabsContent>
          <TabsContent value="llm_call">
            <OperationLogPanel entityType="llm_call" />
          </TabsContent>
        </Tabs>
      </section>

      {/* Sync log detail dialog */}
      <Dialog open={!!selectedLogEntry} onOpenChange={(open) => !open && setSelectedLogEntry(null)}>
        <DialogContent className="max-w-md" showClose>
          {selectedLogEntry && (
            <>
              <DialogHeader>
                <DialogTitle>Sync log details</DialogTitle>
                <DialogDescription>
                  {selectedLogEntry.action} · {selectedLogEntry.status === 'success' ? 'Success' : 'Error'}
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-3 text-sm">
                <div className="grid grid-cols-[100px_1fr] gap-2">
                  <span className="text-muted-foreground">Action</span>
                  <span>{selectedLogEntry.action}</span>
                </div>
                <div className="grid grid-cols-[100px_1fr] gap-2">
                  <span className="text-muted-foreground">Source</span>
                  <span className="capitalize">{selectedLogEntry.source}</span>
                </div>
                <div className="grid grid-cols-[100px_1fr] gap-2">
                  <span className="text-muted-foreground">Status</span>
                  <span
                    className={cn(
                      'font-medium',
                      selectedLogEntry.status === 'success'
                        ? 'text-status-warm'
                        : 'text-status-at-risk'
                    )}
                  >
                    {selectedLogEntry.status === 'success' ? 'Success' : 'Error'}
                  </span>
                </div>
                <div className="grid grid-cols-[100px_1fr] gap-2">
                  <span className="text-muted-foreground">Started</span>
                  <span>{formatTimestamp(selectedLogEntry.started_at)}</span>
                </div>
                <div className="grid grid-cols-[100px_1fr] gap-2">
                  <span className="text-muted-foreground">Finished</span>
                  <span>{formatTimestamp(selectedLogEntry.finished_at)}</span>
                </div>
                <div className="grid grid-cols-[100px_1fr] gap-2">
                  <span className="text-muted-foreground">Duration</span>
                  <span>{formatDuration(selectedLogEntry.duration_ms)}</span>
                </div>
                {selectedLogEntry.details && (
                  <div className="grid grid-cols-[100px_1fr] gap-2">
                    <span className="text-muted-foreground">Details</span>
                    <p className="text-muted-foreground break-words">{selectedLogEntry.details}</p>
                  </div>
                )}
                {selectedLogEntry.metadata &&
                  Object.keys(selectedLogEntry.metadata).length > 0 && (
                    <div className="grid grid-cols-[100px_1fr] gap-2">
                      <span className="text-muted-foreground">Metadata</span>
                      <pre className="text-xs bg-muted/50 rounded p-2 overflow-x-auto">
                        {JSON.stringify(selectedLogEntry.metadata, null, 2)}
                      </pre>
                    </div>
                  )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Toast
        open={toast.open}
        onOpenChange={(open) => !open && setToast((p) => ({ ...p, open: false }))}
        variant={toast.variant}
      >
        <ToastTitle>{toast.title}</ToastTitle>
        {toast.description && <ToastDescription>{toast.description}</ToastDescription>}
        <ToastClose />
      </Toast>
    </div>
    </ProtectedRoute>
  );
}

export default function IntegrationsPage(): React.ReactElement {
  return (
    <React.Suspense fallback={null}>
      <IntegrationsPageInner />
    </React.Suspense>
  );
}
