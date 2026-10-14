import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeOperation, restoreEntry } from './operationsApi';

vi.mock('../i18n', () => ({ t: (key: string) => key }));
const request = {
  requestId: '86d6bafb-cae3-4c56-a4c0-c97c178289be',
  action: 'rename',
  paths: ['root/a'],
  name: 'b',
  conflict: 'fail',
};
const receipt = {
  operationId: request.requestId.replace(/-/g, ''),
  action: 'rename',
  complete: true,
  items: [{ sourcePath: 'root/a', path: 'root/b', success: true }],
};
const response = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('file operation acknowledgement', () => {
  it('reconciles a lost POST response through the exact receipt without another mutation', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('connection lost'))
      .mockResolvedValueOnce(response(receipt));
    vi.stubGlobal('fetch', fetch);
    expect(await executeOperation(request, 'owner')).toEqual(receipt);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(fetch.mock.calls[1]?.[0]).toContain(request.requestId);
  });
  it('does not accept an empty success response or replay the request', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response({ ...receipt, items: [] }))
      .mockResolvedValueOnce(response({ code: 'deleted' }, 404));
    vi.stubGlobal('fetch', fetch);
    await expect(executeOperation(request, 'owner')).rejects.toMatchObject({
      code: 'outcome_unknown',
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('rejects a receipt belonging to another command', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockRejectedValueOnce(new TypeError())
        .mockResolvedValueOnce(response({ ...receipt, operationId: 'other' })),
    );
    await expect(executeOperation(request, 'owner')).rejects.toMatchObject({
      code: 'outcome_unknown',
    });
  });
  it('preserves an explicit permission failure without a retry', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(response({ code: 'access_denied', message: 'Denied' }, 403));
    vi.stubGlobal('fetch', fetch);
    await expect(executeOperation(request, 'owner')).rejects.toMatchObject({
      code: 'access_denied',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('retains partial item failure as an authoritative result', async () => {
    const mixed = {
      ...receipt,
      items: [...receipt.items, { sourcePath: 'root/c', success: false, code: 'name_conflict' }],
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(mixed)));
    expect(await executeOperation(request, 'owner')).toEqual(mixed);
  });
  it('does not call a lost restore response successful', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('connection lost')));
    await expect(restoreEntry('recovery', 'owner')).rejects.toMatchObject({
      code: 'outcome_unknown',
    });
  });
});
