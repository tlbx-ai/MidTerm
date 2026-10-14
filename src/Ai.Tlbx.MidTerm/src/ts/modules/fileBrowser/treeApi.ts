/**
 * File Browser Tree API
 *
 * Fetches directory tree data from the server.
 */
import { getFileVisibility } from '../fileViewer/visibility';
import type { Schemas } from '../../api/types';

export interface FileTreeEntry {
  name: string;
  fullPath: string;
  isDirectory: boolean;
  size?: number | null;
  mimeType?: string | null;
  modified?: string | null;
  isText?: boolean | null;
  gitStatus?: string | null;
  isHidden?: boolean;
  isIgnored?: boolean;
}

export interface FileTreeResponse {
  path: string;
  entries: FileTreeEntry[];
  isGitRepo: boolean;
  visibility: Schemas['FileVisibilitySummary'];
}

export async function fetchTree(
  path: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<FileTreeResponse | null> {
  try {
    const params = new URLSearchParams({ path, depth: '1', sessionId });
    const visibility = getFileVisibility();
    params.set('showHidden', String(visibility.showHidden));
    params.set('showIgnored', String(visibility.showIgnored));
    const res = await fetch(`/api/files/tree?${params}`, { signal: signal ?? null });
    if (!res.ok) return null;
    return (await res.json()) as FileTreeResponse;
  } catch {
    return null;
  }
}
