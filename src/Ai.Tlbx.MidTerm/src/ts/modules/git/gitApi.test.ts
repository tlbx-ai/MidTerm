import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchCommitDetails, fetchDiffView } from './gitApi';

describe('gitApi', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('requests structured diff views with scope and path', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      json: async () => ({ scope: 'worktree', title: 'Working tree diff', isTruncated: false, files: [] }),
    } as Response);
    globalThis.fetch = fetchMock;

    await fetchDiffView('session-1', 'src/app.ts', 'worktree');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/git/diff-view?sessionId=session-1&path=src%2Fapp.ts&scope=worktree',
    );
  });

  it('requests commit details by hash', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      json: async () => ({ hash: 'abc123', files: [] }),
    } as Response);
    globalThis.fetch = fetchMock;

    await fetchCommitDetails('session-1', 'abc123');

    expect(fetchMock).toHaveBeenCalledWith('/api/git/commit?sessionId=session-1&hash=abc123');
  });
});
