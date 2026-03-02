import { create } from 'zustand';
import {
  mockActivities,
  type MockActivity,
  type RelationshipStatus,
  type ProcessingStatusType,
} from '@/lib/mock-data';

export type ActivitySortOption =
  | 'due_date_newest'
  | 'due_date_oldest'
  | 'last_touch_newest'
  | 'last_touch_oldest'
  | 'priority_high_low'
  | 'priority_low_high';

export interface ActivityFilters {
  relationshipStatus: RelationshipStatus[];
  processingStatus: ProcessingStatusType[];
  dateFrom: string;
  dateTo: string;
}

export interface ActivityState {
  activities: MockActivity[];
  selectedActivity: MockActivity | null;
  filters: ActivityFilters;
  sortBy: ActivitySortOption;
  setSelectedActivity: (activity: MockActivity | null) => void;
  addActivity: (activity: MockActivity) => void;
  updateActivity: (id: string, updates: Partial<MockActivity>) => void;
  deleteActivity: (id: string) => void;
  setFilters: (filters: Partial<ActivityFilters>) => void;
  setSortBy: (sortBy: ActivitySortOption) => void;
}

const defaultFilters: ActivityFilters = {
  relationshipStatus: [],
  processingStatus: [],
  dateFrom: '',
  dateTo: '',
};

export const useActivityStore = create<ActivityState>((set) => ({
  activities: [...mockActivities],
  selectedActivity: null,
  filters: defaultFilters,
  sortBy: 'due_date_oldest',

  setSelectedActivity: (selectedActivity) => set({ selectedActivity }),

  addActivity: (activity) =>
    set((state) => ({
      activities: [activity, ...state.activities],
    })),

  updateActivity: (id, updates) =>
    set((state) => {
      const index = state.activities.findIndex((a) => a.id === id);
      if (index === -1) return state;
      const next = [...state.activities];
      next[index] = { ...next[index], ...updates };
      const selectedActivity =
        state.selectedActivity?.id === id
          ? { ...state.selectedActivity, ...updates }
          : state.selectedActivity;
      return { activities: next, selectedActivity };
    }),

  deleteActivity: (id) =>
    set((state) => ({
      activities: state.activities.filter((a) => a.id !== id),
      selectedActivity: state.selectedActivity?.id === id ? null : state.selectedActivity,
    })),

  setFilters: (filters) =>
    set((state) => ({
      filters: { ...state.filters, ...filters },
    })),

  setSortBy: (sortBy) => set({ sortBy }),
}));
