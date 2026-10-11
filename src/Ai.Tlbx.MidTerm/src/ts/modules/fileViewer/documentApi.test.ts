import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileDocumentError, readFileDocument, writeFileDocument } from './documentApi';

afterEach(() => vi.unstubAllGlobals());

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('file document API', () => {
  it('does not send a blind save when the complete version is unavailable', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(writeFileDocument('Q:\\notes.md', 'owner', 'draft', null)).rejects.toMatchObject({
      status: 428,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves the exact reviewed version in an overwrite request', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        response({ success: true, version: 'saved', size: 5, encoding: 'UTF-8', lineEnding: 'lf' }),
      );
    vi.stubGlobal('fetch', fetch);
    await writeFileDocument('Q:\\notes.md', 'owner', 'draft', 'reviewed');
    expect(fetch).toHaveBeenCalledWith(
      '/api/files/save?sessionId=owner',
      expect.objectContaining({
        body: JSON.stringify({
          path: 'Q:\\notes.md',
          content: 'draft',
          expectedVersion: 'reviewed',
        }),
      }),
    );
  });

  it('carries a server conflict version without treating the response as success', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          response({ code: 'changed', currentVersion: 'newest', recoveryPath: null }, 409),
        ),
    );
    await expect(writeFileDocument('Q:\\notes.md', 'owner', 'draft', 'old')).rejects.toMatchObject({
      code: 'changed',
      currentVersion: 'newest',
      status: 409,
    });
  });

  it('rejects a malformed success acknowledgement', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(response({ success: false, version: 'missing' })),
    );
    await expect(writeFileDocument('Q:\\notes.md', 'owner', 'draft', 'old')).rejects.toBeInstanceOf(
      FileDocumentError,
    );
  });

  it('rejects snapshot content returned for another path', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          response({ path: 'Q:\\other.md', content: 'wrong', size: 5, version: 'wrong' }),
        ),
    );
    await expect(
      readFileDocument('Q:\\notes.md', 'owner', true, new AbortController().signal),
    ).rejects.toMatchObject({ status: 502 });
  });
});
