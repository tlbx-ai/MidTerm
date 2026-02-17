/**
 * Git API
 *
 * REST wrappers for git read operations.
 */

import type { GitStatusResponse, GitLogEntry } from './types';

export async function fetchGitStatus(sessionId: string): Promise<GitStatusResponse | null> {
  try {
    const res = await fetch(`/api/git/status?sessionId=${encodeURIComponent(sessionId)}`);
    if (!res.ok) return null;
    return (await res.json()) as GitStatusResponse;
  } catch {
    return null;
  }
}

export async function fetchDiff(
  sessionId: string,
  path: string,
  staged: boolean,
): Promise<string | null> {
  try {
    const params = new URLSearchParams({ sessionId, path, staged: String(staged) });
    const res = await fetch(`/api/git/diff?${params}`);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

export async function fetchGitLog(sessionId: string, count = 20): Promise<GitLogEntry[]> {
  try {
    const res = await fetch(
      `/api/git/log?sessionId=${encodeURIComponent(sessionId)}&count=${count}`,
    );
    if (!res.ok) return [];
    return (await res.json()) as GitLogEntry[];
  } catch {
    return [];
  }
}
