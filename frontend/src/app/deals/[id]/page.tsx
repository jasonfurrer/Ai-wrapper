'use client';

import * as React from 'react';
import ProtectedRoute from '@/components/ProtectedRoute';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, Loader2, Handshake, Users, Building2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { useQuery } from '@tanstack/react-query';
import { getDeal } from '@/lib/api';
import { cn } from '@/lib/utils';

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

export default function DealDetailPage() {
  const params = useParams();
  const dealId = typeof params?.id === 'string' ? params.id : '';

  const dealQuery = useQuery({
    queryKey: ['deal', dealId],
    queryFn: () => getDeal(dealId),
    enabled: !!dealId,
  });

  const deal = dealQuery.data;
  const isLoading = dealQuery.isFetching;
  const error = dealQuery.isError;

  if (!dealId) {
    return (
      <ProtectedRoute>
        <div className="space-y-4">
          <Link href="/deals" className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-4 w-4 mr-1" /> Back to Deals
          </Link>
          <p className="text-destructive">Invalid deal ID.</p>
        </div>
      </ProtectedRoute>
    );
  }

  return (
    <ProtectedRoute>
      <div className="flex flex-col h-full min-h-0">
        <header className="shrink-0 mb-4">
          <Link
            href="/deals"
            className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground mb-3"
          >
            <ArrowLeft className="h-4 w-4 mr-1" /> Back to Deals
          </Link>
          {isLoading && !deal ? (
            <div className="flex items-center gap-2 text-muted-foreground" aria-busy="true">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span>Loading deal…</span>
            </div>
          ) : error || !deal ? (
            <div className="space-y-2">
              <h1 className="text-2xl font-bold tracking-tight">Deal not found</h1>
              <p className="text-sm text-muted-foreground">
                This deal may have been deleted or you don’t have access.
              </p>
            </div>
          ) : (
            <h1 className="text-2xl font-bold tracking-tight">
              {deal.dealname?.trim() || 'Unnamed deal'}
            </h1>
          )}
        </header>

        {deal && (
          <div className="flex-1 min-h-0 overflow-auto space-y-4">
            <Card>
              <CardHeader className="pb-2">
                <p className="text-sm font-medium text-muted-foreground">Details</p>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <span className="text-muted-foreground block">Amount</span>
                    <p className="font-medium">{formatCurrency(deal.amount)}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground block">Close date</span>
                    <p className="font-medium">{formatDate(deal.closedate)}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground block">Pipeline</span>
                    <p className="font-medium">{deal.pipeline ?? '—'}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground block">Stage</span>
                    <p className="font-medium">{deal.dealstage ?? '—'}</p>
                  </div>
                </div>
                {deal.description?.trim() && (
                  <div>
                    <span className="text-muted-foreground block">Description</span>
                    <p className="font-medium whitespace-pre-wrap mt-1">{deal.description}</p>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <p className="text-sm font-medium text-muted-foreground">Associated records</p>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="flex items-center gap-2">
                  <Users className="h-4 w-4 text-muted-foreground" />
                  <span>
                    {deal.contact_ids.length} contact{deal.contact_ids.length !== 1 ? 's' : ''} linked
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Building2 className="h-4 w-4 text-muted-foreground" />
                  <span>
                    {deal.company_ids.length} compan{deal.company_ids.length === 1 ? 'y' : 'ies'} linked
                  </span>
                </div>
                <p className="text-muted-foreground text-xs">
                  Contacts and companies can be managed in HubSpot. A contact can be linked to multiple deals.
                </p>
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </ProtectedRoute>
  );
}
