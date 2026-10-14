/**
 * Git API
 *
 * REST wrappers for git read operations.
 */

import type {
  GitCommitDetailsResponse,
  GitDiffViewResponse,
  GitLogEntry,
  GitRepoListResponse,
  GitStatusResponse,
  GitStatusReadResult,
} from './types';

function appendRepoRoot(params: URLSearchParams, repoRoot?: string): void {
  if (repoRoot) {
    params.set('repoRoot', repoRoot);
  }
}

export async function fetchGitRepos(sessionId: string): Promise<GitRepoListResponse | null> {
  try {
    const res = await fetch(`/api/git/repos?sessionId=${encodeURIComponent(sessionId)}`);
    if (!res.ok) return null;
    return (await res.json()) as GitRepoListResponse;
  } catch {
    return null;
  }
}

export async function addGitRepo(
  sessionId: string,
  path: string,
  role = 'target',
  label?: string,
): Promise<GitRepoListResponse | null> {
  try {
    const res = await fetch('/api/git/repos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, path, role, label }),
    });
    if (!res.ok) return null;
    return (await res.json()) as GitRepoListResponse;
  } catch {
    return null;
  }
}

export async function removeGitRepo(
  sessionId: string,
  repoRoot: string,
): Promise<GitRepoListResponse | null> {
  try {
    const params = new URLSearchParams({ sessionId, repoRoot });
    const res = await fetch(`/api/git/repos?${params}`, { method: 'DELETE' });
    if (!res.ok) return null;
    return (await res.json()) as GitRepoListResponse;
  } catch {
    return null;
  }
}

export async function refreshGitRepo(
  sessionId: string,
  repoRoot?: string,
): Promise<GitRepoListResponse | null> {
  try {
    const res = await fetch('/api/git/repos/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, repoRoot }),
    });
    if (!res.ok) return null;
    return (await res.json()) as GitRepoListResponse;
  } catch {
    return null;
  }
}

export async function fetchGitStatus(
  sessionId: string,
  repoRoot?: string,
): Promise<GitStatusResponse | null> {
  const result = await fetchGitStatusResult(sessionId, repoRoot);
  return result.ok ? result.status : null;
}

export async function fetchGitStatusResult(
  sessionId: string,
  repoRoot?: string,
): Promise<GitStatusReadResult> {
  try {
    const params = new URLSearchParams({ sessionId });
    appendRepoRoot(params, repoRoot);
    const res = await fetch(`/api/git/status?${params}`);
    if (!res.ok)
      return { ok: false, httpStatus: res.status, detail: (await res.text()).slice(0, 2000) };
    return { ok: true, status: (await res.json()) as GitStatusResponse };
  } catch {
    return { ok: false, httpStatus: 0, detail: '' };
  }
}

export async function fetchDiff(
  sessionId: string,
  repoRoot: string | undefined,
  path: string,
  staged: boolean,
): Promise<string | null> {
  try {
    const params = new URLSearchParams({ sessionId, path, staged: String(staged) });
    appendRepoRoot(params, repoRoot);
    const res = await fetch(`/api/git/diff?${params}`);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

export async function fetchGitHistoryPage(
  sessionId: string,
  repoRoot: string,
  head: string,
  skip: number,
  count: number,
): Promise<GitLogEntry[] | null> {
  try {
    const params = new URLSearchParams({
      sessionId,
      repoRoot,
      head,
      skip: String(skip),
      count: String(count),
    });
    const response = await fetch(`/api/git/log?${params}`);
    return response.ok ? ((await response.json()) as GitLogEntry[]) : null;
  } catch {
    return null;
  }
}

export async function fetchDiffView(
  sessionId: string,
  repoRootOrPath: string | undefined,
  pathOrScope: string,
  scopeOrUndefined?: 'worktree' | 'staged',
): Promise<GitDiffViewResponse | null> {
  try {
    const repoRoot = scopeOrUndefined ? repoRootOrPath : undefined;
    const path = scopeOrUndefined ? pathOrScope : (repoRootOrPath ?? '');
    const scope = scopeOrUndefined ?? (pathOrScope as 'worktree' | 'staged');
    const params = new URLSearchParams({ sessionId, path, scope });
    appendRepoRoot(params, repoRoot);
    const res = await fetch(`/api/git/diff-view?${params}`);
    if (!res.ok) return null;
    return (await res.json()) as GitDiffViewResponse;
  } catch {
    return null;
  }
}

export async function fetchCommitDetails(
  sessionId: string,
  repoRootOrHash: string | undefined,
  hashOrUndefined?: string,
  parentIndex = 0,
): Promise<GitCommitDetailsResponse | null> {
  try {
    const repoRoot = hashOrUndefined ? repoRootOrHash : undefined;
    const hash = hashOrUndefined ?? repoRootOrHash ?? '';
    const params = new URLSearchParams({ sessionId, hash });
    if (parentIndex !== 0) params.set('parentIndex', String(parentIndex));
    appendRepoRoot(params, repoRoot);
    const res = await fetch(`/api/git/commit?${params}`);
    if (!res.ok) return null;
    return (await res.json()) as GitCommitDetailsResponse;
  } catch {
    return null;
  }
}
