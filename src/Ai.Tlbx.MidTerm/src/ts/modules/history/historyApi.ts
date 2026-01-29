/**
 * History API Module
 *
 * API client for backend-persisted launch history.
 */

import {
  getHistory,
  createHistoryEntry as apiCreateHistoryEntry,
  toggleHistoryStar,
  deleteHistoryEntry,
  type LaunchEntry,
  type CreateHistoryRequest,
} from '../../api/client';

// Re-export types for consumers
export type { LaunchEntry, CreateHistoryRequest };

export async function fetchHistory(): Promise<LaunchEntry[]> {
  const { data, response } = await getHistory();
  if (!response.ok || !data) {
    throw new Error(`Failed to fetch history: ${response.status}`);
  }
  return data;
}

export async function toggleStar(id: string): Promise<boolean> {
  const { response } = await toggleHistoryStar(id);
  return response.ok;
}

export async function removeHistoryEntry(id: string): Promise<boolean> {
  const { response } = await deleteHistoryEntry(id);
  return response.ok;
}

export async function createHistoryEntry(request: CreateHistoryRequest): Promise<string | null> {
  const { data, response } = await apiCreateHistoryEntry(request);
  if (!response.ok || !data) return null;
  return data.id ?? null;
}
