'use client';

import * as React from 'react';
import ProtectedRoute from '@/components/ProtectedRoute';
import Link from 'next/link';
import { Search, Loader2, Handshake, ChevronRight } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { EmptyState } from '@/components/shared/empty-state';
import { useQuery } from '@tanstack/react-query';
import { searchDeals, type DealSearchResult } from '@/lib/api';
import { cn } from '@/lib/utils';

const DEBOUNCE_MS = 300;
const DEALS_QUERY_KEY = 'deals';

function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

function formatCurrency(value: string | null | undefined): string {
  if (value == null || value === '') return '—';
  const n = parseFloat(value);
  if (Number.isNaN(n)) return value;
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(n);
}

function formatDate(value: string | null | undefined): string {
  if (value == null || value === '') return '—';
  try {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return value;
    return d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return value;
  }
}

export default function DealsPage() {
  const [searchInput, setSearchInput] = React.useState('');
  const debouncedSearch = useDebouncedValue(searchInput.trim(), DEBOUNCE_MS);

  const dealsQuery = useQuery({
    queryKey: [DEALS_QUERY_KEY, debouncedSearch],
    queryFn: async () => {
      const res = await searchDeals({
        q: debouncedSearch || undefined,
        limit: 100,
      });
      return res;
    },
  });

  const deals = React.useMemo(
    () => dealsQuery.data?.deals ?? [],
    [dealsQuery.data]
  );
  const total = dealsQuery.data?.total ?? 0;
  const isLoading = dealsQuery.isFetching;
  const error = dealsQuery.isError
    ? dealsQuery.error instanceof Error
      ? dealsQuery.error.message
      : 'Failed to load deals'
    : null;

  return (
    <ProtectedRoute>
      <div className="flex flex-col h-full min-h-0">
        <header className="shrink-0 space-y-1 mb-4">
          <h1 className="text-2xl font-bold tracking-tight">Deals</h1>
          <p className="text-sm text-muted-foreground">
            View and manage your pipeline. Only some contacts are linked to deals; contacts can have multiple deals.
          </p>
        </header>

        <div className="shrink-0 relative mb-4">
          <Search
            className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            placeholder="Search by deal name, pipeline, or stage..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="pl-9"
            aria-label="Search deals"
          />
        </div>

        {error && (
          <p className="text-sm text-destructive mb-4" role="alert">
            {error}
          </p>
        )}

        <div className="flex-1 min-h-0 overflow-hidden flex flex-col rounded-xl border border-border bg-section">
          {isLoading && deals.length === 0 ? (
            <div
              className="flex items-center justify-center flex-1 py-12"
              aria-busy="true"
            >
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : deals.length === 0 ? (
            <Card className="border-0 shadow-none flex-1 flex flex-col">
              <CardContent className="flex-1 flex items-center justify-center p-6">
                <EmptyState
                  icon={Handshake}
                  title="No deals found"
                  description={
                    debouncedSearch
                      ? 'Try a different search term or clear search to see all deals.'
                      : 'Deals from HubSpot will appear here. Create deals in HubSpot or check your connection.'
                  }
                />
              </CardContent>
            </Card>
          ) : (
            <>
              <CardHeader className="py-3 px-4 border-b border-border shrink-0">
                <p className="text-sm text-muted-foreground">
                  {total} deal{total !== 1 ? 's' : ''} — click a row to view details
                </p>
              </CardHeader>
              <CardContent className="p-0 flex-1 min-h-0 overflow-auto">
                <ul className="divide-y divide-border" role="list">
                  {deals.map((deal) => (
                    <DealRow key={deal.id} deal={deal} isLoading={isLoading} />
                  ))}
                </ul>
              </CardContent>
            </>
          )}
        </div>
      </div>
    </ProtectedRoute>
  );
}

function DealRow({
  deal,
  isLoading,
}: {
  deal: DealSearchResult;
  isLoading: boolean;
}) {
  const name = deal.dealname?.trim() || 'Unnamed deal';
  return (
    <li>
      <Link
        href={`/deals/${deal.id}`}
        className={cn(
          'flex items-center gap-4 py-3 px-4 hover:bg-accent/50 transition-colors',
          isLoading && 'opacity-70'
        )}
      >
        <div className="min-w-0 flex-1">
          <p className="font-medium truncate">{name}</p>
          <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-0.5 text-sm text-muted-foreground">
            <span>{formatCurrency(deal.amount)}</span>
            {deal.dealstage && (
              <span className="truncate">Stage: {deal.dealstage}</span>
            )}
            {deal.closedate && (
              <span>Close: {formatDate(deal.closedate)}</span>
            )}
          </div>
        </div>
        <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" />
      </Link>
    </li>
  );
}
