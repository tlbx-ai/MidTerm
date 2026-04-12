import { afterEach, describe, expect, it, vi } from 'vitest';

describe('api client lens helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('surfaces Lens attach transport failures as LensHttpError instances', async () => {
    vi.doMock('./lensWebSocket', async () => {
      const { LensHttpError } = await import('./errors');
      return {
        attachLensSession: vi.fn(async () => {
          throw new LensHttpError(
            400,
            'MidTerm could not determine the Codex resume id for this session.',
          );
        }),
        detachLensSession: vi.fn(),
        getLensHistoryWindowWs: vi.fn(),
        interruptLensTurnWs: vi.fn(),
        openLensHistorySocket: vi.fn(),
        updateLensHistorySocketWindow: vi.fn(),
        approveLensRequestWs: vi.fn(),
        declineLensRequestWs: vi.fn(),
        resolveLensUserInputWs: vi.fn(),
        submitLensTurnWs: vi.fn(),
      };
    });

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
  });

  it('passes index-window arguments through to the Lens history transport and returns the payload', async () => {
    const getLensHistoryWindowWs = vi.fn(async (_sessionId: string, _start?: number, _count?: number) => ({
      sessionId: 'session-1',
      latestSequence: 7,
      historyCount: 11,
      historyWindowStart: 7,
      historyWindowEnd: 9,
      hasOlderHistory: true,
      hasNewerHistory: true,
      provider: 'codex',
      generatedAt: new Date().toISOString(),
      session: { state: 'ready', stateLabel: 'Ready' },
      thread: { threadId: 't1', state: 'active', stateLabel: 'Active' },
      currentTurn: { state: 'idle', stateLabel: 'Idle' },
      quickSettings: { planMode: 'off', permissionMode: 'manual' },
      streams: {
        assistantText: '',
        reasoningText: '',
        reasoningSummaryText: '',
        planText: '',
        commandOutput: '',
        fileChangeOutput: '',
        unifiedDiff: '',
      },
      history: [],
      items: [],
      requests: [],
      notices: [],
    }));
    vi.doMock('./lensWebSocket', () => ({
      attachLensSession: vi.fn(),
      detachLensSession: vi.fn(),
      getLensHistoryWindowWs,
      interruptLensTurnWs: vi.fn(),
      openLensHistorySocket: vi.fn(),
      updateLensHistorySocketWindow: vi.fn(),
      approveLensRequestWs: vi.fn(),
      declineLensRequestWs: vi.fn(),
      resolveLensUserInputWs: vi.fn(),
      submitLensTurnWs: vi.fn(),
    }));

    const { getLensHistoryWindow } = await import('./client');
    const result = await getLensHistoryWindow('session-1', 7, 2);

    expect(getLensHistoryWindowWs).toHaveBeenCalledWith('session-1', 7, 2);
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

  it('surfaces structured session launch problem details', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        async text() {
          return JSON.stringify({
            title: 'Session launch failed',
            detail: 'Windows blocked the mthost process launch.',
            errorDetails: 'CreateProcess failed with Win32 error 5: Access is denied.',
            errorStage: 'spawn',
            exceptionType: 'Win32Exception',
            nativeErrorCode: 5,
          });
        },
      })),
    );

    const { createSession, ApiProblemError } = await import('./client');

    let thrown: unknown;
    try {
      await createSession({ cols: 120, rows: 30, shell: 'Pwsh', workingDirectory: null });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ApiProblemError);
    expect((thrown as ApiProblemError).detail).toBe('Windows blocked the mthost process launch.');
    expect((thrown as ApiProblemError).errorDetails).toBe(
      'CreateProcess failed with Win32 error 5: Access is denied.',
    );
    expect((thrown as ApiProblemError).nativeErrorCode).toBe(5);
  });

  it('parses successful session launch responses via fetch fallback', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      async text() {
        return JSON.stringify({
          id: 'session-1',
          pid: 42,
          createdAt: '2026-03-30T10:00:00Z',
          isRunning: true,
          exitCode: null,
          name: '',
          terminalTitle: '',
          currentDirectory: 'Q:/repos/MidTermWorkspace4',
          foregroundPid: null,
          foregroundName: null,
          foregroundCommandLine: null,
          foregroundDisplayName: null,
          foregroundProcessIdentity: null,
          shellType: 'Pwsh',
          cols: 120,
          rows: 30,
          manuallyNamed: false,
          supervisor: null,
          order: 1,
          parentSessionId: null,
          bookmarkId: null,
          agentControlled: false,
        });
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const { createSession } = await import('./client');
    const { data } = await createSession({ cols: 120, rows: 30, shell: 'Pwsh' });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/sessions',
      expect.objectContaining({
        method: 'POST',
      }),
    );
    expect(data?.id).toBe('session-1');
  });
});
