import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchTree } from './treeApi';

describe('treeApi', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('includes sessionId when loading tree data', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      json: async () => ({ path: 'Q:/repo', entries: [], isGitRepo: true }),
    } as Response);
    globalThis.fetch = fetchMock;

    await fetchTree('Q:/repo', 'session-1');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/files/tree?path=Q%3A%2Frepo&depth=1&sessionId=session-1',
    );
  });
});
