'use client';

import * as React from 'react';
import { ExternalLink, Check } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { type RelationshipStatus } from '@/components/shared/status-chip';
import { cn } from '@/lib/utils';

export type PriorityLevel = 'none' | 'low' | 'medium' | 'high';

export interface ActivityCardActivity {
  id: string;
  contactName: string;
  accountName: string;
  subject: string;
  noteExcerpt: string;
  lastTouchDate: string;
  relationshipStatus: RelationshipStatus;
  /** Priority from HubSpot; shown on card */
  priority?: PriorityLevel;
  /** Optional; not displayed on card until implemented */
  opportunityPercentage?: number;
  /** Optional; not displayed on card until implemented */
  processingStatus?: string;
}

export interface ActivityCardProps {
  activity: ActivityCardActivity;
  isSelected?: boolean;
  /** When true, card shows green tint and Complete button shows "Completed" (disabled). */
  completed?: boolean;
  onClick?: () => void;
  onOpen?: (activity: ActivityCardActivity) => void;
  onComplete?: (activity: ActivityCardActivity) => void;
  className?: string;
}

const ActivityCard = React.forwardRef<HTMLDivElement, ActivityCardProps>(
  (
    {
      activity,
      isSelected = false,
      completed = false,
      onClick,
      onOpen,
      onComplete,
      className,
    },
    ref
  ) => {
    const handleCardClick = (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest('[data-action-buttons]')) return;
      onClick?.();
    };

    const handleOpen = (e: React.MouseEvent) => {
      e.stopPropagation();
      onOpen?.(activity);
    };

    const handleComplete = (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!completed) onComplete?.(activity);
    };

    return (
      <Card
        ref={ref}
        role="button"
        tabIndex={0}
        onClick={handleCardClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onClick?.();
          }
        }}
        className={cn(
          'cursor-pointer transition-shadow duration-200 border-2 bg-card',
          'hover:shadow-card-hover',
          isSelected && 'border-status-active',
          !isSelected && 'border-border',
          !completed && !isSelected && 'border-status-active/25 dark:border-status-active/30',
          completed && 'bg-status-warm/10 dark:bg-status-warm/12',
          completed && !isSelected && 'border-status-warm/30 dark:border-status-warm/35',
          className
        )}
      >
        <CardContent className="p-4 flex flex-col gap-3">
          {/* Top: Contact name (bold), account name (gray), and priority badge */}
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-foreground truncate min-w-0">
                {activity.contactName}
              </span>
              {activity.priority && activity.priority !== 'none' && (
                <span
                  className={cn(
                    'shrink-0 text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded',
                    activity.priority === 'high' && 'bg-destructive/15 text-destructive',
                    activity.priority === 'medium' && 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
                    activity.priority === 'low' && 'bg-muted text-muted-foreground'
                  )}
                >
                  {activity.priority}
                </span>
              )}
            </div>
            <span className="text-sm text-muted-foreground truncate">
              {activity.accountName}
            </span>
          </div>

          {/* Title (task subject only) */}
          <p className="text-sm font-medium text-foreground line-clamp-2">
            {activity.subject || '—'}
          </p>

          {/* Action buttons row */}
          <div
            data-action-buttons
            className="flex items-center gap-1 pt-1 border-t border-border"
          >
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-xs gap-1"
              onClick={handleOpen}
            >
              <ExternalLink className="h-3.5 w-3" />
              Open
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                'h-8 px-2 text-xs gap-1',
                completed && 'cursor-default font-semibold text-green-900 dark:text-green-200 bg-white/60 dark:bg-black/30 border border-green-600/30 dark:border-green-500/35'
              )}
              onClick={handleComplete}
              disabled={completed}
            >
              <Check className="h-3.5 w-3 shrink-0" />
              {completed ? 'Completed' : 'Complete'}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }
);
ActivityCard.displayName = 'ActivityCard';

export { ActivityCard };
