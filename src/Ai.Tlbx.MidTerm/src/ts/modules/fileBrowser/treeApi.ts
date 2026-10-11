/**
 * File Browser Tree API
 *
 * Fetches directory tree data from the server.
 */

export interface FileTreeEntry {
  name: string;
  fullPath: string;
  isDirectory: boolean;
  size?: number | null;
  mimeType?: string | null;
  isText?: boolean | null;
  gitStatus?: string | null;
}

export interface FileTreeResponse {
  path: string;
  entries: FileTreeEntry[];
  isGitRepo: boolean;
}

export async function fetchTree(
  path: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<FileTreeResponse | null> {
  try {
    const params = new URLSearchParams({ path, depth: '1', sessionId });
    const res = await fetch(`/api/files/tree?${params}`, { signal: signal ?? null });
    if (!res.ok) return null;
    return (await res.json()) as FileTreeResponse;
  } catch {
    return null;
  }
}
