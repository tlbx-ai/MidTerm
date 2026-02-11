/**
 * Git API
 *
 * REST wrappers for git operations.
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

export async function stageFiles(sessionId: string, paths: string[]): Promise<boolean> {
  try {
    const res = await fetch('/api/git/stage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, paths }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function unstageFiles(sessionId: string, paths: string[]): Promise<boolean> {
  try {
    const res = await fetch('/api/git/unstage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, paths }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function commitChanges(sessionId: string, message: string): Promise<boolean> {
  try {
    const res = await fetch('/api/git/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function pushChanges(sessionId: string): Promise<boolean> {
  try {
    const res = await fetch('/api/git/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function pullChanges(sessionId: string): Promise<boolean> {
  try {
    const res = await fetch('/api/git/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function stashChanges(
  sessionId: string,
  action: string,
  message?: string,
): Promise<boolean> {
  try {
    const res = await fetch('/api/git/stash', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, action, message }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function discardChanges(sessionId: string, paths: string[]): Promise<boolean> {
  try {
    const res = await fetch('/api/git/discard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, paths }),
    });
    return res.ok;
  } catch {
    return false;
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
