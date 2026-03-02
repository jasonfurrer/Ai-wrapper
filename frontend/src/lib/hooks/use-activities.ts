'use client';

import { useMemo } from 'react';
import {
  useActivityStore,
  type ActivitySortOption,
  type ActivityFilters,
} from '@/lib/store/activity-store';
import type { MockActivity } from '@/lib/mock-data';

function isDateInRange(iso: string, from: string, to: string): boolean {
  const t = new Date(iso).getTime();
  if (from && t < new Date(from + 'T00:00:00').getTime()) return false;
  if (to && t > new Date(to + 'T23:59:59').getTime()) return false;
  return true;
}

function sortActivities(
  items: MockActivity[],
  sortBy: ActivitySortOption
): MockActivity[] {
  const copy = [...items];
  const dueTs = (a: MockActivity) =>
    a.dueDate ? new Date(a.dueDate + (a.dueDate.length === 10 ? 'T00:00:00' : '')).getTime() : 0;
  const touchTs = (a: MockActivity) => new Date(a.lastTouchDate).getTime();
  switch (sortBy) {
    case 'due_date_oldest':
      copy.sort((a, b) => dueTs(a) - dueTs(b) || touchTs(a) - touchTs(b));
      break;
    case 'due_date_newest':
      copy.sort((a, b) => dueTs(b) - dueTs(a) || touchTs(b) - touchTs(a));
      break;
    case 'last_touch_oldest':
      copy.sort((a, b) => touchTs(a) - touchTs(b) || dueTs(a) - dueTs(b));
      break;
    case 'last_touch_newest':
      copy.sort((a, b) => touchTs(b) - touchTs(a) || dueTs(b) - dueTs(a));
      break;
    case 'priority_high_low':
      copy.sort(
        (a, b) => b.opportunityPercentage - a.opportunityPercentage
      );
      break;
    case 'priority_low_high':
      copy.sort(
        (a, b) => a.opportunityPercentage - b.opportunityPercentage
      );
      break;
    default:
      break;
  }
  return copy;
}

/** Returns filtered and sorted activities from the activity store. */
export function useActivities(): MockActivity[] {
  const activities = useActivityStore((s) => s.activities);
  const filters = useActivityStore((s) => s.filters);
  const sortBy = useActivityStore((s) => s.sortBy);

  return useMemo(() => {
    const filtered = activities.filter((a) => {
      if (
        filters.relationshipStatus.length > 0 &&
        !filters.relationshipStatus.includes(a.relationshipStatus)
      )
        return false;
      if (
        filters.processingStatus.length > 0 &&
        !filters.processingStatus.includes(a.processingStatus)
      )
        return false;
      if (!isDateInRange(a.lastTouchDate, filters.dateFrom, filters.dateTo))
        return false;
      return true;
    });
    return sortActivities(filtered, sortBy);
  }, [activities, filters, sortBy]);
}

/** Returns a single activity by id, or undefined. */
export function useActivityById(id: string | null): MockActivity | undefined {
  const activities = useActivityStore((s) => s.activities);
  return useMemo(
    () => (id ? activities.find((a) => a.id === id) : undefined),
    [activities, id]
  );
}

/** Returns a function to create (add) an activity. */
export function useCreateActivity(): (activity: MockActivity) => void {
  return useActivityStore((s) => s.addActivity);
}

/** Returns a function to update an activity by id. */
export function useUpdateActivity(): (
  id: string,
  updates: Partial<MockActivity>
) => void {
  return useActivityStore((s) => s.updateActivity);
}
