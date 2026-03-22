import { afterEach, describe, expect, it, vi } from 'vitest';

describe('api client lens helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('surfaces the actual Lens attach HTTP detail instead of a body-read error', async () => {
    let reads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        async text() {
          reads += 1;
          if (reads > 1) {
            throw new TypeError('body stream already read');
          }

          return 'MidTerm could not determine the Codex resume id for this session.';
        },
      })),
    );

    const { attachSessionLens, LensHttpError } = await import('./client');

    let thrown: unknown;
    try {
      await attachSessionLens('session-1');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(LensHttpError);
    expect((thrown as Error).message).toBe(
      'HTTP 400: MidTerm could not determine the Codex resume id for this session.',
    );
    expect(reads).toBe(1);
  });

  it('builds the Lens events URL with afterSequence and parses the payload', async () => {
    vi.stubGlobal('window', {
      location: { origin: 'https://127.0.0.1:2100' },
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => ({
      ok: true,
      async text() {
        return JSON.stringify({
          sessionId: 'session-1',
          latestSequence: 7,
          events: [],
        });
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const { getLensEvents } = await import('./client');
    const result = await getLensEvents('session-1', 7);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://127.0.0.1:2100/api/sessions/session-1/lens/events?afterSequence=7',
      undefined,
    );
    expect(result.latestSequence).toBe(7);
  });

  it('fetches session state with the buffer flag and parses the payload', async () => {
    vi.stubGlobal('window', {
      location: { origin: 'https://127.0.0.1:2100' },
    });

    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => ({
      ok: true,
      async text() {
        return JSON.stringify({
          session: { id: 'session-1' },
          previews: [],
          bufferByteLength: 12,
          bufferEncoding: 'utf-8',
          bufferText: 'hello world',
          bufferBase64: null,
          supervisor: null,
        });
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const { getSessionState } = await import('./client');
    const result = await getSessionState('session-1');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://127.0.0.1:2100/api/sessions/session-1/state?includeBuffer=true',
      undefined,
    );
    expect(result.bufferText).toBe('hello world');
  });

  it('fetches a stripped terminal tail for read-only Lens fallback', async () => {
    vi.stubGlobal('window', {
      location: { origin: 'https://127.0.0.1:2100' },
    });

    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => ({
      ok: true,
      async text() {
        return 'PS> codex --yolo\nready';
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const { getSessionBufferTail } = await import('./client');
    const result = await getSessionBufferTail('session-1', 80, true);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://127.0.0.1:2100/api/sessions/session-1/buffer/tail?lines=80&stripAnsi=true',
    );
    expect(result).toBe('PS> codex --yolo\nready');
  });
});
