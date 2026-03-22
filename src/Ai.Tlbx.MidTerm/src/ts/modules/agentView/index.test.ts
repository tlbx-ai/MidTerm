import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const onTabActivated = vi.fn();
const onTabDeactivated = vi.fn();
const switchTab = vi.fn();
const getSessionState = vi.fn();
const getSessionBufferTail = vi.fn();
const attachSessionLens = vi.fn();
const detachSessionLens = vi.fn(() => Promise.resolve());
const getLensSnapshot = vi.fn();
const getLensEvents = vi.fn();
const openLensEventStream = vi.fn(() => vi.fn());
const interruptLensTurn = vi.fn();
const approveLensRequest = vi.fn();
const declineLensRequest = vi.fn();
const resolveLensUserInput = vi.fn();
const showDevErrorDialog = vi.fn();

vi.mock('../sessionTabs', () => ({
  onTabActivated,
  onTabDeactivated,
  switchTab,
}));

vi.mock('../../api/client', () => ({
  LensHttpError: class LensHttpError extends Error {
    detail: string;
    status: number;

    constructor(status: number, detail: string) {
      super(`HTTP ${status}: ${detail}`);
      this.name = 'LensHttpError';
      this.status = status;
      this.detail = detail;
    }
  },
  getSessionState,
  getSessionBufferTail,
  attachSessionLens,
  detachSessionLens,
  getLensSnapshot,
  getLensEvents,
  openLensEventStream,
  interruptLensTurn,
  approveLensRequest,
  declineLensRequest,
  resolveLensUserInput,
}));

vi.mock('../../utils/devErrorDialog', () => ({
  showDevErrorDialog,
}));

vi.mock('../i18n', () => ({
  t: (key: string) => key,
}));

vi.mock('../logging', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

describe('agentView dev errors', () => {
  beforeEach(() => {
    vi.stubGlobal('document', {
      createElement: () => ({
        dataset: {} as DOMStringMap,
        style: {} as CSSStyleDeclaration,
        className: '',
        textContent: '',
        innerHTML: '',
        append: vi.fn(),
        appendChild: vi.fn(),
        replaceChildren: vi.fn(),
        addEventListener: vi.fn(),
        setAttribute: vi.fn(),
        classList: {
          add: vi.fn(),
          remove: vi.fn(),
          toggle: vi.fn(),
        },
      }),
      createDocumentFragment: () => ({
        appendChild: vi.fn(),
        childNodes: [],
      }),
    });
    vi.stubGlobal('window', {
      clearTimeout: vi.fn(),
      setTimeout: vi.fn(() => 1),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
      requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      }),
    });
    onTabActivated.mockReset();
    onTabDeactivated.mockReset();
    switchTab.mockReset();
    getSessionState.mockReset();
    getSessionState.mockResolvedValue(null);
    getSessionBufferTail.mockReset();
    getSessionBufferTail.mockResolvedValue('');
    attachSessionLens.mockReset();
    detachSessionLens.mockReset();
    detachSessionLens.mockResolvedValue(undefined);
    getLensSnapshot.mockReset();
    getLensEvents.mockReset();
    openLensEventStream.mockReset();
    openLensEventStream.mockReturnValue(vi.fn());
    interruptLensTurn.mockReset();
    approveLensRequest.mockReset();
    declineLensRequest.mockReset();
    resolveLensUserInput.mockReset();
    showDevErrorDialog.mockReset();
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function createPanel(): HTMLDivElement {
    const elements = new Map<string, any>();

    const getElement = (selector: string) => {
      if (!elements.has(selector)) {
        elements.set(selector, {
          dataset: {} as DOMStringMap,
          hidden: false,
          disabled: false,
          textContent: '',
          value: '',
          className: '',
          innerHTML: '',
          scrollTop: 0,
          scrollHeight: 0,
          clientHeight: 0,
          append: vi.fn(),
          appendChild: vi.fn(),
          replaceChildren: vi.fn(),
          setAttribute: vi.fn(),
          addEventListener: vi.fn(),
          classList: {
            add: vi.fn(),
            remove: vi.fn(),
            toggle: vi.fn(),
          },
        });
      }

      return elements.get(selector);
    };

    return {
      dataset: {} as DOMStringMap,
      innerHTML: '',
      classList: {
        add: vi.fn(),
        remove: vi.fn(),
      },
      querySelector: vi.fn((selector: string) => getElement(selector)),
    } as unknown as HTMLDivElement;
  }

  it('shows a dev error modal when Lens activation fails', async () => {
    attachSessionLens.mockRejectedValue(new Error('Lens attach failed'));
    getLensSnapshot.mockRejectedValue(new Error('Lens snapshot unavailable'));
    getLensEvents.mockRejectedValue(new Error('Lens events unavailable'));

    const { initAgentView } = await import('./index');
    initAgentView();

    const activate = onTabActivated.mock.calls[0]?.[1] as
      | ((sessionId: string, panel: HTMLDivElement) => void)
      | undefined;
    expect(activate).toBeTypeOf('function');

    const panel = createPanel();
    activate?.('s1', panel);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await vi.waitFor(() => {
      expect(showDevErrorDialog).toHaveBeenCalledTimes(1);
    });
    expect(showDevErrorDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Lens failed to open',
        context: 'Lens activation failed for session s1',
        error: expect.any(Error),
      }),
    );
  });

  it('restores canonical Lens history when attach fails but a snapshot already exists', async () => {
    attachSessionLens.mockRejectedValue(new Error('Lens attach failed'));
    getLensSnapshot.mockResolvedValue({
      sessionId: 's1',
      provider: 'codex',
      generatedAt: '2026-03-22T01:45:00Z',
      latestSequence: 1,
      session: {
        state: 'ready',
        stateLabel: 'Ready',
        reason: 'Codex turn completed.',
        lastError: null,
        lastEventAt: '2026-03-22T01:45:00Z',
      },
      thread: {
        threadId: 'thread-1',
        state: 'active',
        stateLabel: 'Active',
      },
      currentTurn: {
        turnId: 'turn-1',
        state: 'completed',
        stateLabel: 'Completed',
        model: null,
        effort: null,
        startedAt: '2026-03-22T01:44:55Z',
        completedAt: '2026-03-22T01:45:00Z',
      },
      streams: {
        assistantText: 'Lens snapshot still exists.',
        reasoningText: '',
        reasoningSummaryText: '',
        planText: '',
        commandOutput: '',
        fileChangeOutput: '',
        unifiedDiff: '',
      },
      items: [
        {
          itemId: 'assistant-1',
          turnId: 'turn-1',
          itemType: 'assistant_message',
          status: 'completed',
          title: 'Assistant message',
          detail: 'Lens snapshot still exists.',
          attachments: [],
          updatedAt: '2026-03-22T01:45:00Z',
        },
      ],
      requests: [],
      notices: [],
    });
    getLensEvents.mockResolvedValue({
      sessionId: 's1',
      latestSequence: 1,
      events: [],
    });

    const { initAgentView } = await import('./index');
    initAgentView();

    const activate = onTabActivated.mock.calls[0]?.[1] as
      | ((sessionId: string, panel: HTMLDivElement) => void)
      | undefined;
    expect(activate).toBeTypeOf('function');

    const panel = createPanel();
    activate?.('s1', panel);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(getLensSnapshot).toHaveBeenCalledWith('s1');
    expect(getLensEvents).toHaveBeenCalledWith('s1');
    expect(showDevErrorDialog).not.toHaveBeenCalled();
  });

  it('retries live Lens resume automatically after restoring canonical history', async () => {
    attachSessionLens.mockRejectedValueOnce(new Error('Lens attach failed'));
    attachSessionLens.mockResolvedValue(undefined);
    getLensSnapshot
      .mockRejectedValueOnce(new Error('Lens snapshot unavailable'))
      .mockResolvedValue({
        sessionId: 's1',
        provider: 'codex',
        generatedAt: '2026-03-22T01:45:00Z',
        latestSequence: 1,
        session: {
          state: 'ready',
          stateLabel: 'Ready',
          reason: 'Codex turn completed.',
          lastError: null,
          lastEventAt: '2026-03-22T01:45:00Z',
        },
        thread: {
          threadId: 'thread-1',
          state: 'active',
          stateLabel: 'Active',
        },
        currentTurn: {
          turnId: 'turn-1',
          state: 'completed',
          stateLabel: 'Completed',
          model: null,
          effort: null,
          startedAt: '2026-03-22T01:44:55Z',
          completedAt: '2026-03-22T01:45:00Z',
        },
        streams: {
          assistantText: 'Lens snapshot still exists.',
          reasoningText: '',
          reasoningSummaryText: '',
          planText: '',
          commandOutput: '',
          fileChangeOutput: '',
          unifiedDiff: '',
        },
        items: [
          {
            itemId: 'assistant-1',
            turnId: 'turn-1',
            itemType: 'assistant_message',
            status: 'completed',
            title: 'Assistant message',
            detail: 'Lens snapshot still exists.',
            attachments: [],
            updatedAt: '2026-03-22T01:45:00Z',
          },
        ],
        requests: [],
        notices: [],
      });
    getLensEvents
      .mockResolvedValueOnce({
        sessionId: 's1',
        latestSequence: 1,
        events: [],
      })
      .mockResolvedValueOnce({
        sessionId: 's1',
        latestSequence: 1,
        events: [],
      });

    const { initAgentView } = await import('./index');
    initAgentView();

    const activate = onTabActivated.mock.calls[0]?.[1] as
      | ((sessionId: string, panel: HTMLDivElement) => void)
      | undefined;
    expect(activate).toBeTypeOf('function');

    const panel = createPanel();
    activate?.('s1', panel);

    await vi.waitFor(() => {
      expect(attachSessionLens).toHaveBeenCalledTimes(2);
      expect(openLensEventStream).toHaveBeenCalledWith('s1', 1, expect.any(Object));
    });
    expect(showDevErrorDialog).not.toHaveBeenCalled();
  });

  it('does not show a dev error modal for expected Lens handoff blocks', async () => {
    attachSessionLens.mockRejectedValue(
      new Error('HTTP 400: Finish or interrupt the terminal Codex turn before opening Lens.'),
    );
    getLensSnapshot.mockRejectedValue(new Error('Lens snapshot unavailable'));
    getLensEvents.mockRejectedValue(new Error('Lens events unavailable'));
    getSessionState.mockResolvedValue({
      session: {
        id: 's1',
        shellType: 'Pwsh',
        supervisor: { profile: 'codex' },
        foregroundDisplayName: 'codex --yolo',
      },
      previews: [],
      bufferByteLength: 20,
      bufferEncoding: 'utf-8',
      bufferText: 'PS> codex --yolo',
      bufferBase64: null,
    });
    getSessionBufferTail.mockResolvedValue('PS> codex --yolo');

    const { initAgentView } = await import('./index');
    initAgentView();

    const activate = onTabActivated.mock.calls[0]?.[1] as
      | ((sessionId: string, panel: HTMLDivElement) => void)
      | undefined;
    expect(activate).toBeTypeOf('function');

    const panel = createPanel();
    activate?.('s1', panel);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(showDevErrorDialog).not.toHaveBeenCalled();
  });

  it('keeps Lens attached when the agent tab is deactivated', async () => {
    const { initAgentView } = await import('./index');
    initAgentView();

    const deactivate = onTabDeactivated.mock.calls[0]?.[1] as
      | ((sessionId: string) => void)
      | undefined;
    expect(deactivate).toBeTypeOf('function');

    deactivate?.('s1');
    await Promise.resolve();

    expect(detachSessionLens).not.toHaveBeenCalled();
  });

  it('detaches Lens when the agent view is destroyed', async () => {
    const { destroyAgentView } = await import('./index');

    destroyAgentView('s1');
    await Promise.resolve();

    expect(detachSessionLens).toHaveBeenCalledWith('s1');
  });

  it('classifies a busy terminal attach failure into a readonly handoff issue', async () => {
    const { classifyLensActivationIssue } = await import('./index');

    const issue = classifyLensActivationIssue(
      new Error('HTTP 400: Finish or interrupt the terminal Codex turn before opening Lens.'),
      true,
    );

    expect(issue.kind).toBe('busy-terminal-turn');
    expect(issue.meta).toBe('Read-only history');
    expect(issue.title).toContain('Terminal owns');
    expect(issue.actions.map((action) => action.id)).toEqual(['open-terminal', 'retry-lens']);
  });

  it('classifies shell recovery failure as an expected handoff issue', async () => {
    const { classifyLensActivationIssue } = await import('./index');

    const issue = classifyLensActivationIssue(
      new Error('HTTP 400: Terminal shell did not recover after stopping Codex.'),
      false,
    );

    expect(issue.kind).toBe('shell-recovery-failed');
    expect(issue.meta).toBe('Terminal recovery failed');
    expect(issue.actions.map((action) => action.id)).toEqual(['open-terminal', 'retry-lens']);
  });

  it('classifies native runtime unavailability as an expected Lens issue', async () => {
    const { classifyLensActivationIssue } = await import('./index');

    const issue = classifyLensActivationIssue(
      new Error('HTTP 400: Lens native runtime is not available for this session.'),
      false,
    );

    expect(issue.kind).toBe('native-runtime-unavailable');
    expect(issue.meta).toBe('Native runtime unavailable');
    expect(issue.actions.map((action) => action.id)).toEqual(['open-terminal', 'retry-lens']);
  });

  it('prepends a readable Lens issue row ahead of the transcript', async () => {
    const { withActivationIssueNotice } = await import('./index');

    const entries = withActivationIssueNotice(
      [
        {
          id: 'assistant:1',
          order: 1,
          kind: 'assistant',
          tone: 'info',
          label: 'Assistant',
          title: '',
          body: 'Transcript still visible.',
          meta: '02:00',
        },
      ],
      {
        kind: 'missing-resume-id',
        tone: 'warning',
        meta: 'Read-only history',
        title: 'No resumable Codex thread is known yet',
        body: 'Lens can still show canonical history.',
        actions: [
          { id: 'open-terminal', label: 'Open Terminal', style: 'secondary' },
          { id: 'retry-lens', label: 'Retry Lens', style: 'primary', busyLabel: 'Retrying...' },
        ],
      },
    );

    expect(entries).toHaveLength(2);
    expect(entries[0]?.kind).toBe('system');
    expect(entries[0]?.title).toBe('No resumable Codex thread is known yet');
    expect(entries[0]?.actions?.map((action) => action.id)).toEqual([
      'open-terminal',
      'retry-lens',
    ]);
    expect(entries[1]?.body).toBe('Transcript still visible.');
  });

  it('compacts duplicate activation failure rows when an expected handoff issue is active', async () => {
    const { buildActivationTranscriptEntries } = await import('./index');

    const entries = buildActivationTranscriptEntries({
      panel: createPanel(),
      snapshot: null,
      events: [],
      transcriptViewport: null,
      transcriptEntries: [],
      disconnectStream: null,
      streamConnected: false,
      refreshScheduled: null,
      refreshInFlight: false,
      requestBusyIds: new Set<string>(),
      transcriptAutoScrollPinned: true,
      transcriptRenderScheduled: null,
      terminalFallback: null,
      activationState: 'failed',
      activationDetail: 'Lens startup failed.',
      activationError: 'HTTP 400: Finish or interrupt the terminal Codex turn before opening Lens.',
      activationActionBusy: false,
      activationIssue: {
        kind: 'busy-terminal-turn',
        tone: 'warning',
        meta: 'Terminal busy',
        title: 'Terminal owns the live Codex turn',
        body: 'Use Terminal, then retry.',
        actions: [],
      },
      activationTrace: [
        {
          tone: 'info',
          meta: 'Opening • 03:16',
          summary: 'Lens pane opened.',
          detail: 'MidTerm is switching from the terminal surface to the Lens transcript for this session.',
        },
        {
          tone: 'info',
          meta: 'Attaching • 03:16',
          summary: 'Attaching Lens runtime.',
          detail: 'Starting or reconnecting the backend-owned Lens runtime for this session.',
        },
        {
          tone: 'attention',
          meta: 'Failed • 03:16',
          summary: 'Lens startup failed.',
          detail: 'HTTP 400: Finish or interrupt the terminal Codex turn before opening Lens.',
        },
      ],
    });

    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.meta)).toEqual(['Opening • 03:16', 'Attaching • 03:16']);
  });

  it('prepends a read-only terminal snapshot when Lens has no canonical history yet', async () => {
    const { buildActivationTranscriptEntries } = await import('./index');

    const entries = buildActivationTranscriptEntries({
      panel: createPanel(),
      snapshot: null,
      events: [],
      transcriptViewport: null,
      transcriptEntries: [],
      disconnectStream: null,
      streamConnected: false,
      refreshScheduled: null,
      refreshInFlight: false,
      requestBusyIds: new Set<string>(),
      transcriptAutoScrollPinned: true,
      transcriptRenderScheduled: null,
      terminalFallback: {
        session: {
          id: 's1',
          shellType: 'Pwsh',
          supervisor: { profile: 'codex' },
          foregroundDisplayName: 'codex --yolo',
        },
        previews: [],
        bufferByteLength: 39,
        bufferEncoding: 'utf-8',
        bufferText: 'PS> codex --yolo\r\nthinking...\r\nready',
        bufferBase64: null,
      } as any,
      activationState: 'failed',
      activationDetail: 'Lens startup failed.',
      activationError: 'HTTP 400: MidTerm could not determine the Codex resume id for this session.',
      activationActionBusy: false,
      activationIssue: {
        kind: 'missing-resume-id',
        tone: 'warning',
        meta: 'Live attach unavailable',
        title: 'No resumable Codex thread is known yet',
        body: 'Use Terminal for the live lane, or retry later.',
        actions: [],
      },
      activationTrace: [
        {
          tone: 'info',
          meta: 'Opening • 03:16',
          summary: 'Lens pane opened.',
          detail: 'MidTerm is switching from the terminal surface to the Lens transcript for this session.',
        },
      ],
    });

    expect(entries[0]?.label).toBe('Terminal');
    expect(entries[0]?.title).toBe('codex --yolo');
    expect(entries[0]?.meta).toBe('Read-only fallback • Pwsh • codex');
    expect(entries[0]?.body).toContain('thinking...');
    expect(entries[1]?.meta).toBe('Opening • 03:16');
  });

  it('adds optimistic user and assistant rows until canonical Lens entries arrive', async () => {
    const { applyOptimisticLensTurns } = await import('./index');

    const result = applyOptimisticLensTurns(
      {
        sessionId: 's1',
        provider: 'codex',
        generatedAt: '2026-03-22T09:00:00Z',
        latestSequence: 10,
        session: {
          state: 'running',
          stateLabel: 'Running',
          reason: null,
          lastError: null,
          lastEventAt: '2026-03-22T09:00:00Z',
        },
        thread: {
          threadId: 'thread-1',
          state: 'active',
          stateLabel: 'Active',
        },
        currentTurn: {
          turnId: '',
          state: 'running',
          stateLabel: 'Running',
          model: null,
          effort: null,
          startedAt: '2026-03-22T09:00:00Z',
          completedAt: null,
        },
        streams: {
          assistantText: '',
          reasoningText: '',
          reasoningSummaryText: '',
          planText: '',
          commandOutput: '',
          fileChangeOutput: '',
          unifiedDiff: '',
        },
        items: [],
        requests: [],
        notices: [],
      },
      [],
      [
        {
          optimisticId: 'opt-1',
          turnId: 'turn-1',
          text: 'Summarize the repo state.',
          attachments: [],
          submittedAt: '2026-03-22T09:00:00Z',
          status: 'accepted',
        } as any,
      ],
    );

    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]?.kind).toBe('user');
    expect(result.entries[0]?.label).toBe('You');
    expect(result.entries[1]?.kind).toBe('assistant');
    expect(result.entries[1]?.live).toBe(true);
    expect(result.entries[1]?.pending).toBe(false);
    expect(result.optimisticTurns).toHaveLength(1);
  });

  it('drops optimistic placeholders once canonical transcript entries exist for the turn', async () => {
    const { applyOptimisticLensTurns } = await import('./index');

    const result = applyOptimisticLensTurns(
      {
        sessionId: 's1',
        provider: 'codex',
        generatedAt: '2026-03-22T09:00:00Z',
        latestSequence: 12,
        session: {
          state: 'running',
          stateLabel: 'Running',
          reason: null,
          lastError: null,
          lastEventAt: '2026-03-22T09:00:00Z',
        },
        thread: {
          threadId: 'thread-1',
          state: 'active',
          stateLabel: 'Active',
        },
        currentTurn: {
          turnId: 'turn-1',
          state: 'running',
          stateLabel: 'Running',
          model: null,
          effort: null,
          startedAt: '2026-03-22T09:00:00Z',
          completedAt: null,
        },
        streams: {
          assistantText: 'Working on it',
          reasoningText: '',
          reasoningSummaryText: '',
          planText: '',
          commandOutput: '',
          fileChangeOutput: '',
          unifiedDiff: '',
        },
        items: [],
        requests: [],
        notices: [],
      },
      [
        {
          id: 'user:turn-1',
          order: 1,
          kind: 'user',
          tone: 'info',
          label: 'User',
          title: '',
          body: 'Summarize the repo state.',
          meta: '09:00',
        },
        {
          id: 'assistant:turn-1',
          order: 2,
          kind: 'assistant',
          tone: 'info',
          label: 'Assistant',
          title: '',
          body: 'Working on it',
          meta: '09:00',
        },
      ],
      [
        {
          optimisticId: 'opt-1',
          turnId: 'turn-1',
          text: 'Summarize the repo state.',
          attachments: [],
          submittedAt: '2026-03-22T09:00:00Z',
          status: 'accepted',
        } as any,
      ],
    );

    expect(result.entries).toHaveLength(2);
    expect(result.optimisticTurns).toHaveLength(0);
  });

  it('trims oversized terminal snapshots to the recent tail', async () => {
    const { summarizeTerminalFallbackBuffer } = await import('./index');

    const lines = Array.from({ length: 130 }, (_, index) => `line-${index + 1}`).join('\n');
    const summarized = summarizeTerminalFallbackBuffer(lines);

    expect(summarized.startsWith('... earlier terminal output omitted ...')).toBe(true);
    expect(summarized).toContain('line-130');
    expect(summarized).not.toContain('line-1\n');
  });

  it('compacts duplicated repaint lines inside the terminal fallback tail', async () => {
    const { summarizeTerminalFallbackBuffer } = await import('./index');

    const summarized = summarizeTerminalFallbackBuffer(
      'PS Q:\\repos\\MidtermJpa>PS Q:\\repos\\MidtermJpa>\n' +
        'codex --yolocodex --yolo\n' +
        'unchanged line',
    );

    expect(summarized).toContain('PS Q:\\repos\\MidtermJpa>');
    expect(summarized).not.toContain('PS Q:\\repos\\MidtermJpa>PS Q:\\repos\\MidtermJpa>');
    expect(summarized).toContain('codex --yolo');
    expect(summarized).not.toContain('codex --yolocodex --yolo');
    expect(summarized).toContain('unchanged line');
  });

  it('builds transcript-first rows from canonical Lens events', async () => {
    const { buildLensTranscriptEntries } = await import('./index');

    const snapshot = {
      sessionId: 's1',
      provider: 'codex',
      generatedAt: '2026-03-20T10:00:00Z',
      latestSequence: 8,
      session: {
        state: 'ready',
        stateLabel: 'Ready',
        reason: null,
        lastError: null,
        lastEventAt: '2026-03-20T10:00:00Z',
      },
      thread: {
        threadId: 'thread-1',
        state: 'active',
        stateLabel: 'Active',
      },
      currentTurn: {
        turnId: 'turn-1',
        state: 'running',
        stateLabel: 'Running',
        model: 'gpt-5',
        effort: 'medium',
        startedAt: '2026-03-20T09:59:00Z',
        completedAt: null,
      },
      streams: {
        assistantText: '',
        reasoningText: '',
        reasoningSummaryText: '',
        planText: '',
        commandOutput: '',
        fileChangeOutput: '',
        unifiedDiff: '',
      },
      items: [],
      requests: [
        {
          requestId: 'req-1',
          turnId: 'turn-1',
          kind: 'tool_approval',
          kindLabel: 'Approval',
          state: 'open',
          detail: 'Approve command execution',
          decision: null,
          questions: [],
          answers: [],
          updatedAt: '2026-03-20T10:00:00Z',
        },
      ],
      notices: [],
    } as any;

    const events = [
      {
        sequence: 1,
        eventId: 'e1',
        sessionId: 's1',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'user-1',
        requestId: null,
        createdAt: '2026-03-20T09:59:00Z',
        type: 'item.completed',
        raw: null,
        sessionState: null,
        threadState: null,
        turnStarted: null,
        turnCompleted: null,
        contentDelta: null,
        planDelta: null,
        planCompleted: null,
        diffUpdated: null,
        item: {
          itemType: 'user_message',
          status: 'completed',
          title: 'You',
          detail: 'Implement the transcript UI.',
        },
        requestOpened: null,
        requestResolved: null,
        userInputRequested: null,
        userInputResolved: null,
        runtimeMessage: null,
      },
      {
        sequence: 2,
        eventId: 'e2',
        sessionId: 's1',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'assistant-1',
        requestId: null,
        createdAt: '2026-03-20T09:59:10Z',
        type: 'content.delta',
        raw: null,
        sessionState: null,
        threadState: null,
        turnStarted: null,
        turnCompleted: null,
        contentDelta: {
          streamKind: 'assistant_text',
          delta: 'Working on it.',
        },
        planDelta: null,
        planCompleted: null,
        diffUpdated: null,
        item: null,
        requestOpened: null,
        requestResolved: null,
        userInputRequested: null,
        userInputResolved: null,
        runtimeMessage: null,
      },
      {
        sequence: 3,
        eventId: 'e3',
        sessionId: 's1',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'tool-1',
        requestId: null,
        createdAt: '2026-03-20T09:59:20Z',
        type: 'item.started',
        raw: null,
        sessionState: null,
        threadState: null,
        turnStarted: null,
        turnCompleted: null,
        contentDelta: null,
        planDelta: null,
        planCompleted: null,
        diffUpdated: null,
        item: {
          itemType: 'command',
          status: 'in_progress',
          title: 'Run tests',
          detail: 'npm run typecheck',
        },
        requestOpened: null,
        requestResolved: null,
        userInputRequested: null,
        userInputResolved: null,
        runtimeMessage: null,
      },
      {
        sequence: 4,
        eventId: 'e4',
        sessionId: 's1',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: null,
        requestId: 'req-1',
        createdAt: '2026-03-20T09:59:30Z',
        type: 'request.opened',
        raw: null,
        sessionState: null,
        threadState: null,
        turnStarted: null,
        turnCompleted: null,
        contentDelta: null,
        planDelta: null,
        planCompleted: null,
        diffUpdated: null,
        item: null,
        requestOpened: {
          requestType: 'tool_approval',
          requestTypeLabel: 'Approval',
          detail: 'Approve command execution',
        },
        requestResolved: null,
        userInputRequested: null,
        userInputResolved: null,
        runtimeMessage: null,
      },
    ] as any;

    const transcript = buildLensTranscriptEntries(snapshot, events);

    expect(transcript.map((entry) => entry.kind)).toContain('user');
    expect(transcript.map((entry) => entry.kind)).toContain('assistant');
    expect(transcript.map((entry) => entry.kind)).toContain('tool');
    expect(transcript.map((entry) => entry.kind)).toContain('request');
    expect(transcript.find((entry) => entry.kind === 'assistant')?.body).toContain(
      'Working on it.',
    );
    expect(transcript.find((entry) => entry.kind === 'request')?.requestId).toBe('req-1');
  });

  it('backs current-turn transcript rows from snapshot items when event history is incomplete', async () => {
    const { buildLensTranscriptEntries, withLiveAssistantState } = await import('./index');

    const snapshot = {
      sessionId: 's1',
      provider: 'codex',
      generatedAt: '2026-03-22T02:15:00Z',
      latestSequence: 900,
      session: {
        state: 'running',
        stateLabel: 'Running',
        reason: 'Codex turn started.',
        lastError: null,
        lastEventAt: '2026-03-22T02:15:00Z',
      },
      thread: {
        threadId: 'thread-1',
        state: 'active',
        stateLabel: 'Active',
      },
      currentTurn: {
        turnId: 'turn-2',
        state: 'running',
        stateLabel: 'Running',
        model: null,
        effort: null,
        startedAt: '2026-03-22T02:14:58Z',
        completedAt: null,
      },
      streams: {
        assistantText: 'Streaming answer in progress.',
        reasoningText: '',
        reasoningSummaryText: '',
        planText: '',
        commandOutput: '',
        fileChangeOutput: '',
        unifiedDiff: '',
      },
      items: [
        {
          itemId: 'local-user:turn-2',
          turnId: 'turn-2',
          itemType: 'user_message',
          status: 'completed',
          title: 'User message',
          detail: 'Describe the logo in detail.',
          attachments: [],
          updatedAt: '2026-03-22T02:14:58Z',
        },
        {
          itemId: 'assistant-old',
          turnId: 'turn-1',
          itemType: 'assistant_message',
          status: 'completed',
          title: 'Assistant message',
          detail: 'Earlier completed answer.',
          attachments: [],
          updatedAt: '2026-03-22T02:13:00Z',
        },
      ],
      requests: [],
      notices: [],
    } as any;

    const transcript = buildLensTranscriptEntries(snapshot, []);
    const marked = withLiveAssistantState(snapshot, transcript);

    expect(marked.some((entry) => entry.kind === 'user' && entry.body.includes('Describe the logo'))).toBe(true);
    expect(marked.some((entry) => entry.kind === 'assistant' && entry.body.includes('Streaming answer in progress.'))).toBe(true);
    expect(marked.some((entry) => entry.kind === 'assistant' && entry.live)).toBe(true);
  });

  it('hides normal state-management events and merges tool updates', async () => {
    const { buildLensTranscriptEntries } = await import('./index');

    const snapshot = {
      sessionId: 's1',
      provider: 'codex',
      generatedAt: '2026-03-20T10:00:00Z',
      latestSequence: 6,
      session: {
        state: 'ready',
        stateLabel: 'Ready',
        reason: null,
        lastError: null,
        lastEventAt: '2026-03-20T10:00:00Z',
      },
      thread: {
        threadId: 'thread-1',
        state: 'active',
        stateLabel: 'Active',
      },
      currentTurn: {
        turnId: 'turn-1',
        state: 'running',
        stateLabel: 'Running',
        model: 'gpt-5',
        effort: 'medium',
        startedAt: '2026-03-20T09:59:00Z',
        completedAt: null,
      },
      streams: {
        assistantText: '',
        reasoningText: '',
        reasoningSummaryText: '',
        planText: '',
        commandOutput: '',
        fileChangeOutput: '',
        unifiedDiff: '',
      },
      items: [],
      requests: [],
      notices: [],
    } as any;

    const events = [
      {
        sequence: 1,
        eventId: 'e-state',
        sessionId: 's1',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: null,
        itemId: null,
        requestId: null,
        createdAt: '2026-03-20T09:59:00Z',
        type: 'session.state.changed',
        raw: null,
        sessionState: {
          state: 'ready',
          stateLabel: 'Ready',
          reason: null,
        },
        threadState: null,
        turnStarted: null,
        turnCompleted: null,
        contentDelta: null,
        planDelta: null,
        planCompleted: null,
        diffUpdated: null,
        item: null,
        requestOpened: null,
        requestResolved: null,
        userInputRequested: null,
        userInputResolved: null,
        runtimeMessage: null,
      },
      {
        sequence: 2,
        eventId: 'e-tool-start',
        sessionId: 's1',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'tool-1',
        requestId: null,
        createdAt: '2026-03-20T09:59:10Z',
        type: 'item.started',
        raw: null,
        sessionState: null,
        threadState: null,
        turnStarted: null,
        turnCompleted: null,
        contentDelta: null,
        planDelta: null,
        planCompleted: null,
        diffUpdated: null,
        item: {
          itemType: 'command',
          status: 'in_progress',
          title: 'Run tests completed',
          detail: 'npm run typecheck',
        },
        requestOpened: null,
        requestResolved: null,
        userInputRequested: null,
        userInputResolved: null,
        runtimeMessage: null,
      },
      {
        sequence: 3,
        eventId: 'e-tool-out',
        sessionId: 's1',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'tool-1',
        requestId: null,
        createdAt: '2026-03-20T09:59:11Z',
        type: 'content.delta',
        raw: null,
        sessionState: null,
        threadState: null,
        turnStarted: null,
        turnCompleted: null,
        contentDelta: {
          streamKind: 'command_output',
          delta: 'All green',
        },
        planDelta: null,
        planCompleted: null,
        diffUpdated: null,
        item: null,
        requestOpened: null,
        requestResolved: null,
        userInputRequested: null,
        userInputResolved: null,
        runtimeMessage: null,
      },
      {
        sequence: 4,
        eventId: 'e-reasoning',
        sessionId: 's1',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'assistant-1',
        requestId: null,
        createdAt: '2026-03-20T09:59:12Z',
        type: 'content.delta',
        raw: null,
        sessionState: null,
        threadState: null,
        turnStarted: null,
        turnCompleted: null,
        contentDelta: {
          streamKind: 'reasoning_text',
          delta: 'Thinking...',
        },
        planDelta: null,
        planCompleted: null,
        diffUpdated: null,
        item: null,
        requestOpened: null,
        requestResolved: null,
        userInputRequested: null,
        userInputResolved: null,
        runtimeMessage: null,
      },
    ] as any;

    const transcript = buildLensTranscriptEntries(snapshot, events);

    expect(transcript).toHaveLength(1);
    expect(transcript[0]).toMatchObject({
      kind: 'tool',
      title: 'Run tests',
    });
    expect(transcript[0]?.body).toContain('npm run typecheck');
    expect(transcript[0]?.body).toContain('All green');
  });

  it('keeps Codex user rows visible and avoids duplicate assistant rows for camelCase item types', async () => {
    const { buildLensTranscriptEntries } = await import('./index');

    const snapshot = {
      sessionId: 's1',
      provider: 'codex',
      generatedAt: '2026-03-21T11:59:24Z',
      latestSequence: 12,
      session: {
        state: 'ready',
        stateLabel: 'Ready',
        reason: 'Codex turn completed.',
        lastError: null,
        lastEventAt: '2026-03-21T11:59:24Z',
      },
      thread: {
        threadId: 'thread-1',
        state: 'active',
        stateLabel: 'Active',
      },
      currentTurn: {
        turnId: 'turn-1',
        state: 'completed',
        stateLabel: 'Completed',
        model: null,
        effort: null,
        startedAt: '2026-03-21T11:59:14Z',
        completedAt: '2026-03-21T11:59:18Z',
      },
      streams: {
        assistantText: 'HELLO_FROM_CODEX',
        reasoningText: '',
        reasoningSummaryText: '',
        planText: '',
        commandOutput: '',
        fileChangeOutput: '',
        unifiedDiff: '',
      },
      items: [],
      requests: [],
      notices: [],
    } as any;

    const events = [
      {
        sequence: 1,
        eventId: 'e-user-start',
        sessionId: 's1',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'user-1',
        requestId: null,
        createdAt: '2026-03-21T11:59:14Z',
        type: 'item.started',
        raw: null,
        item: {
          itemType: 'usermessage',
          status: 'in_progress',
          title: 'Tool started',
          detail: 'Reply with exactly HELLO_FROM_CODEX',
        },
      },
      {
        sequence: 2,
        eventId: 'e-user-done',
        sessionId: 's1',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'user-1',
        requestId: null,
        createdAt: '2026-03-21T11:59:14Z',
        type: 'item.completed',
        raw: null,
        item: {
          itemType: 'usermessage',
          status: 'completed',
          title: 'Tool completed',
          detail: 'Reply with exactly HELLO_FROM_CODEX',
        },
      },
      {
        sequence: 3,
        eventId: 'e-assistant-delta',
        sessionId: 's1',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'assistant-1',
        requestId: null,
        createdAt: '2026-03-21T11:59:18Z',
        type: 'content.delta',
        raw: null,
        contentDelta: {
          streamKind: 'assistant_text',
          delta: 'HELLO_FROM_CODEX',
        },
      },
      {
        sequence: 4,
        eventId: 'e-assistant-done',
        sessionId: 's1',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'assistant-1',
        requestId: null,
        createdAt: '2026-03-21T11:59:18Z',
        type: 'item.completed',
        raw: null,
        item: {
          itemType: 'assistant_message',
          status: 'completed',
          title: 'Assistant message',
          detail: 'HELLO_FROM_CODEX',
        },
      },
      {
        sequence: 5,
        eventId: 'e-command-done',
        sessionId: 's1',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'cmd-1',
        requestId: null,
        createdAt: '2026-03-21T11:59:17Z',
        type: 'item.completed',
        raw: null,
        item: {
          itemType: 'commandexecution',
          status: 'completed',
          title: 'Tool completed',
          detail: '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command pwd',
        },
      },
    ] as any;

    const transcript = buildLensTranscriptEntries(snapshot, events);
    const userEntries = transcript.filter((entry) => entry.kind === 'user');
    const assistantEntries = transcript.filter((entry) => entry.kind === 'assistant');
    const toolEntries = transcript.filter((entry) => entry.kind === 'tool');

    expect(userEntries).toHaveLength(1);
    expect(userEntries[0]?.body).toContain('Reply with exactly HELLO_FROM_CODEX');
    expect(userEntries[0]?.title).toBe('You');

    expect(assistantEntries).toHaveLength(1);
    expect(assistantEntries[0]?.body).toBe('HELLO_FROM_CODEX');

    expect(toolEntries).toHaveLength(1);
    expect(toolEntries[0]?.title).toContain('pwsh.exe');
    expect(toolEntries[0]?.body).toContain('pwsh.exe');
  });

  it('concatenates assistant stream chunks without paragraph separators or duplicate final text', async () => {
    const { buildLensTranscriptEntries } = await import('./index');

    const snapshot = {
      sessionId: 's1',
      provider: 'codex',
      generatedAt: '2026-03-21T12:39:16Z',
      latestSequence: 8,
      session: {
        state: 'ready',
        stateLabel: 'Ready',
        reason: 'Codex turn completed.',
        lastError: null,
        lastEventAt: '2026-03-21T12:39:07Z',
      },
      thread: {
        threadId: 'thread-1',
        state: 'active',
        stateLabel: 'Active',
      },
      currentTurn: {
        turnId: 'turn-1',
        state: 'completed',
        stateLabel: 'Completed',
        model: null,
        effort: null,
        startedAt: '2026-03-21T12:39:01Z',
        completedAt: '2026-03-21T12:39:07Z',
      },
      streams: {
        assistantText: 'HELLO_FROM_CODEX',
        reasoningText: '',
        reasoningSummaryText: '',
        planText: '',
        commandOutput: '',
        fileChangeOutput: '',
        unifiedDiff: '',
      },
      items: [],
      requests: [],
      notices: [],
    } as any;

    const events = [
      {
        sequence: 1,
        eventId: 'e-assistant-start',
        sessionId: 's1',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'assistant-1',
        requestId: null,
        createdAt: '2026-03-21T12:39:07Z',
        type: 'item.started',
        raw: null,
        item: {
          itemType: 'assistant_message',
          status: 'in_progress',
          title: 'Tool started',
          detail: '',
        },
      },
      {
        sequence: 2,
        eventId: 'e-delta-1',
        sessionId: 's1',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'assistant-1',
        requestId: null,
        createdAt: '2026-03-21T12:39:07Z',
        type: 'content.delta',
        raw: null,
        contentDelta: {
          streamKind: 'assistant_text',
          delta: 'HEL',
        },
      },
      {
        sequence: 3,
        eventId: 'e-delta-2',
        sessionId: 's1',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'assistant-1',
        requestId: null,
        createdAt: '2026-03-21T12:39:07Z',
        type: 'content.delta',
        raw: null,
        contentDelta: {
          streamKind: 'assistant_text',
          delta: 'LO',
        },
      },
      {
        sequence: 4,
        eventId: 'e-delta-3',
        sessionId: 's1',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'assistant-1',
        requestId: null,
        createdAt: '2026-03-21T12:39:07Z',
        type: 'content.delta',
        raw: null,
        contentDelta: {
          streamKind: 'assistant_text',
          delta: '_FROM',
        },
      },
      {
        sequence: 5,
        eventId: 'e-delta-4',
        sessionId: 's1',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'assistant-1',
        requestId: null,
        createdAt: '2026-03-21T12:39:07Z',
        type: 'content.delta',
        raw: null,
        contentDelta: {
          streamKind: 'assistant_text',
          delta: '_CODE',
        },
      },
      {
        sequence: 6,
        eventId: 'e-delta-5',
        sessionId: 's1',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'assistant-1',
        requestId: null,
        createdAt: '2026-03-21T12:39:07Z',
        type: 'content.delta',
        raw: null,
        contentDelta: {
          streamKind: 'assistant_text',
          delta: 'X',
        },
      },
      {
        sequence: 7,
        eventId: 'e-assistant-done',
        sessionId: 's1',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'assistant-1',
        requestId: null,
        createdAt: '2026-03-21T12:39:07Z',
        type: 'item.completed',
        raw: null,
        item: {
          itemType: 'assistant_message',
          status: 'completed',
          title: 'Assistant message',
          detail: 'HELLO_FROM_CODEX',
        },
      },
    ] as any;

    const transcript = buildLensTranscriptEntries(snapshot, events);
    const assistantEntries = transcript.filter((entry) => entry.kind === 'assistant');

    expect(assistantEntries).toHaveLength(1);
    expect(assistantEntries[0]?.body).toBe('HELLO_FROM_CODEX');
  });

  it('prefers the final Codex assistant message when it supersedes streamed chunks', async () => {
    const { buildLensTranscriptEntries } = await import('./index');

    const snapshot = {
      sessionId: 's1',
      provider: 'codex',
      generatedAt: '2026-03-21T18:00:00Z',
      latestSequence: 6,
      session: {
        state: 'ready',
        stateLabel: 'Ready',
        reason: 'Codex turn completed.',
        lastError: null,
        lastEventAt: '2026-03-21T18:00:00Z',
      },
      thread: {
        threadId: 'thread-1',
        state: 'active',
        stateLabel: 'Active',
      },
      currentTurn: {
        turnId: 'turn-1',
        state: 'completed',
        stateLabel: 'Completed',
        model: null,
        effort: null,
        startedAt: '2026-03-21T17:59:54Z',
        completedAt: '2026-03-21T18:00:00Z',
      },
      streams: {
        assistantText: 'The answer is 42.',
        reasoningText: '',
        reasoningSummaryText: '',
        planText: '',
        commandOutput: '',
        fileChangeOutput: '',
        unifiedDiff: '',
      },
      items: [],
      requests: [],
      notices: [],
    } as any;

    const events = [
      {
        sequence: 1,
        eventId: 'e-delta-1',
        sessionId: 's1',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'assistant-1',
        requestId: null,
        createdAt: '2026-03-21T17:59:58Z',
        type: 'content.delta',
        raw: null,
        contentDelta: {
          streamKind: 'assistant_text',
          delta: 'The answer',
        },
      },
      {
        sequence: 2,
        eventId: 'e-delta-2',
        sessionId: 's1',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'assistant-1',
        requestId: null,
        createdAt: '2026-03-21T17:59:59Z',
        type: 'content.delta',
        raw: null,
        contentDelta: {
          streamKind: 'assistant_text',
          delta: ' is',
        },
      },
      {
        sequence: 3,
        eventId: 'e-delta-3',
        sessionId: 's1',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'assistant-1',
        requestId: null,
        createdAt: '2026-03-21T17:59:59Z',
        type: 'content.delta',
        raw: null,
        contentDelta: {
          streamKind: 'assistant_text',
          delta: ' 42',
        },
      },
      {
        sequence: 4,
        eventId: 'e-assistant-done',
        sessionId: 's1',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'assistant-1',
        requestId: null,
        createdAt: '2026-03-21T18:00:00Z',
        type: 'item.completed',
        raw: null,
        item: {
          itemType: 'assistant_message',
          status: 'completed',
          title: 'Assistant message',
          detail: 'The answer is 42.',
        },
      },
    ] as any;

    const transcript = buildLensTranscriptEntries(snapshot, events);
    const assistantEntries = transcript.filter((entry) => entry.kind === 'assistant');

    expect(assistantEntries).toHaveLength(1);
    expect(assistantEntries[0]?.body).toBe('The answer is 42.');
  });

  it('keeps one user row when Codex emits repeated started/completed message payloads', async () => {
    const { buildLensTranscriptEntries } = await import('./index');

    const snapshot = {
      sessionId: 's1',
      provider: 'codex',
      generatedAt: '2026-03-21T18:05:00Z',
      latestSequence: 4,
      session: {
        state: 'ready',
        stateLabel: 'Ready',
        reason: null,
        lastError: null,
        lastEventAt: '2026-03-21T18:05:00Z',
      },
      thread: {
        threadId: 'thread-1',
        state: 'active',
        stateLabel: 'Active',
      },
      currentTurn: {
        turnId: 'turn-1',
        state: 'completed',
        stateLabel: 'Completed',
        model: null,
        effort: null,
        startedAt: '2026-03-21T18:04:56Z',
        completedAt: '2026-03-21T18:05:00Z',
      },
      streams: {
        assistantText: '',
        reasoningText: '',
        reasoningSummaryText: '',
        planText: '',
        commandOutput: '',
        fileChangeOutput: '',
        unifiedDiff: '',
      },
      items: [],
      requests: [],
      notices: [],
    } as any;

    const events = [
      {
        sequence: 1,
        eventId: 'e-user-start',
        sessionId: 's1',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'user-1',
        requestId: null,
        createdAt: '2026-03-21T18:04:57Z',
        type: 'item.started',
        raw: null,
        item: {
          itemType: 'user_message',
          status: 'in_progress',
          title: 'Tool started',
          detail: 'Explain the recent Lens transcript bug.',
        },
      },
      {
        sequence: 2,
        eventId: 'e-user-completed',
        sessionId: 's1',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'user-1',
        requestId: null,
        createdAt: '2026-03-21T18:04:58Z',
        type: 'item.completed',
        raw: null,
        item: {
          itemType: 'user_message',
          status: 'completed',
          title: 'Tool completed',
          detail: 'Explain the recent Lens transcript bug.',
        },
      },
    ] as any;

    const transcript = buildLensTranscriptEntries(snapshot, events);
    const userEntries = transcript.filter((entry) => entry.kind === 'user');

    expect(userEntries).toHaveLength(1);
    expect(userEntries[0]?.body).toBe('Explain the recent Lens transcript bug.');
  });

  it('merges a local submitted user row with the later provider user item for the same turn', async () => {
    const { buildLensTranscriptEntries } = await import('./index');

    const snapshot = {
      sessionId: 's1',
      provider: 'codex',
      generatedAt: '2026-03-22T01:30:00Z',
      latestSequence: 3,
      session: {
        state: 'running',
        stateLabel: 'Running',
        reason: null,
        lastError: null,
        lastEventAt: '2026-03-22T01:30:00Z',
      },
      thread: {
        threadId: 'thread-1',
        state: 'active',
        stateLabel: 'Active',
      },
      currentTurn: {
        turnId: 'turn-1',
        state: 'running',
        stateLabel: 'Running',
        model: null,
        effort: null,
        startedAt: '2026-03-22T01:29:58Z',
        completedAt: null,
      },
      streams: {
        assistantText: '',
        reasoningText: '',
        reasoningSummaryText: '',
        planText: '',
        commandOutput: '',
        fileChangeOutput: '',
        unifiedDiff: '',
      },
      items: [],
      requests: [],
      notices: [],
    } as any;

    const events = [
      {
        sequence: 1,
        eventId: 'e-local-user',
        sessionId: 's1',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'local-user:turn-1',
        createdAt: '2026-03-22T01:29:58Z',
        type: 'item.completed',
        raw: null,
        item: {
          itemType: 'user_message',
          status: 'completed',
          title: 'User message',
          detail: 'Please inspect this image.',
          attachments: [
            {
              kind: 'image',
              path: 'Q:/repo/.midterm/uploads/screen.png',
              mimeType: 'image/png',
              displayName: 'screen.png',
            },
          ],
        },
      },
      {
        sequence: 2,
        eventId: 'e-provider-user',
        sessionId: 's1',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'provider-user-1',
        createdAt: '2026-03-22T01:29:59Z',
        type: 'item.completed',
        raw: null,
        item: {
          itemType: 'user_message',
          status: 'completed',
          title: 'User message',
          detail: 'Please inspect this image.',
          attachments: [],
        },
      },
    ] as any;

    const transcript = buildLensTranscriptEntries(snapshot, events);
    const userEntries = transcript.filter((entry) => entry.kind === 'user');

    expect(userEntries).toHaveLength(1);
    expect(userEntries[0]?.body).toBe('Please inspect this image.');
    expect(userEntries[0]?.attachments).toHaveLength(1);
    expect(userEntries[0]?.attachments?.[0]?.displayName).toBe('screen.png');
  });

  it('keeps attachment-only user rows visible in the transcript', async () => {
    const { buildLensTranscriptEntries } = await import('./index');

    const snapshot = {
      sessionId: 's1',
      provider: 'codex',
      generatedAt: '2026-03-22T01:40:00Z',
      latestSequence: 1,
      session: {
        state: 'running',
        stateLabel: 'Running',
        reason: null,
        lastError: null,
        lastEventAt: '2026-03-22T01:40:00Z',
      },
      thread: {
        threadId: 'thread-1',
        state: 'active',
        stateLabel: 'Active',
      },
      currentTurn: {
        turnId: 'turn-2',
        state: 'running',
        stateLabel: 'Running',
        model: null,
        effort: null,
        startedAt: '2026-03-22T01:39:58Z',
        completedAt: null,
      },
      streams: {
        assistantText: '',
        reasoningText: '',
        reasoningSummaryText: '',
        planText: '',
        commandOutput: '',
        fileChangeOutput: '',
        unifiedDiff: '',
      },
      items: [],
      requests: [],
      notices: [],
    } as any;

    const events = [
      {
        sequence: 1,
        eventId: 'e-image-only',
        sessionId: 's1',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-2',
        itemId: 'local-user:turn-2',
        createdAt: '2026-03-22T01:40:00Z',
        type: 'item.completed',
        raw: null,
        item: {
          itemType: 'user_message',
          status: 'completed',
          title: 'User message',
          detail: '',
          attachments: [
            {
              kind: 'image',
              path: 'Q:/repo/.midterm/uploads/photo.png',
              mimeType: 'image/png',
              displayName: 'photo.png',
            },
          ],
        },
      },
    ] as any;

    const transcript = buildLensTranscriptEntries(snapshot, events);
    const userEntries = transcript.filter((entry) => entry.kind === 'user');

    expect(userEntries).toHaveLength(1);
    expect(userEntries[0]?.body).toBe('');
    expect(userEntries[0]?.attachments).toHaveLength(1);
  });

  it('keeps user text from item title and still falls back to snapshot assistant text', async () => {
    const { buildLensTranscriptEntries } = await import('./index');

    const snapshot = {
      sessionId: 's1',
      provider: 'codex',
      generatedAt: '2026-03-20T10:00:00Z',
      latestSequence: 4,
      session: {
        state: 'ready',
        stateLabel: 'Ready',
        reason: null,
        lastError: null,
        lastEventAt: '2026-03-20T10:00:00Z',
      },
      thread: {
        threadId: 'thread-1',
        state: 'active',
        stateLabel: 'Active',
      },
      currentTurn: {
        turnId: 'turn-1',
        state: 'completed',
        stateLabel: 'Completed',
        model: 'gpt-5',
        effort: 'medium',
        startedAt: '2026-03-20T09:59:00Z',
        completedAt: '2026-03-20T10:00:00Z',
      },
      streams: {
        assistantText: 'Final answer from snapshot',
        reasoningText: '',
        reasoningSummaryText: '',
        planText: '',
        commandOutput: '',
        fileChangeOutput: '',
        unifiedDiff: '',
      },
      items: [],
      requests: [],
      notices: [],
    } as any;

    const events = [
      {
        sequence: 1,
        eventId: 'user-title-only',
        sessionId: 's1',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'user-1',
        requestId: null,
        createdAt: '2026-03-20T09:59:00Z',
        type: 'item.completed',
        raw: null,
        sessionState: null,
        threadState: null,
        turnStarted: null,
        turnCompleted: null,
        contentDelta: null,
        planDelta: null,
        planCompleted: null,
        diffUpdated: null,
        item: {
          itemType: 'user_message',
          status: 'completed',
          title: 'Please summarize the failing test run.',
          detail: '',
        },
        requestOpened: null,
        requestResolved: null,
        userInputRequested: null,
        userInputResolved: null,
        runtimeMessage: null,
      },
      {
        sequence: 2,
        eventId: 'assistant-empty-item',
        sessionId: 's1',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'assistant-1',
        requestId: null,
        createdAt: '2026-03-20T09:59:20Z',
        type: 'item.completed',
        raw: null,
        sessionState: null,
        threadState: null,
        turnStarted: null,
        turnCompleted: null,
        contentDelta: null,
        planDelta: null,
        planCompleted: null,
        diffUpdated: null,
        item: {
          itemType: 'assistant_message',
          status: 'completed',
          title: 'Assistant',
          detail: '',
        },
        requestOpened: null,
        requestResolved: null,
        userInputRequested: null,
        userInputResolved: null,
        runtimeMessage: null,
      },
    ] as any;

    const transcript = buildLensTranscriptEntries(snapshot, events);

    expect(transcript.find((entry) => entry.kind === 'user')?.body).toContain(
      'Please summarize the failing test run.',
    );
    expect(
      transcript.find(
        (entry) => entry.kind === 'assistant' && entry.body.includes('Final answer from snapshot'),
      ),
    ).toBeTruthy();
  });

  it('hides completed-status noise in normal chat row metadata', async () => {
    const { buildLensTranscriptEntries, formatTranscriptMeta, shouldHideStatusInMeta } =
      await import('./index');

    expect(shouldHideStatusInMeta('user', 'Completed')).toBe(true);
    expect(shouldHideStatusInMeta('assistant', 'Assistant Text')).toBe(true);
    expect(shouldHideStatusInMeta('request', 'Completed')).toBe(false);
    expect(formatTranscriptMeta('user', 'Completed', '2026-03-21T15:09:20Z')).not.toContain(
      'Completed',
    );

    const snapshot = {
      sessionId: 's1',
      provider: 'codex',
      generatedAt: '2026-03-21T15:09:22Z',
      latestSequence: 4,
      session: {
        state: 'ready',
        stateLabel: 'Ready',
        reason: null,
        lastError: null,
        lastEventAt: '2026-03-21T15:09:22Z',
      },
      thread: {
        threadId: 'thread-1',
        state: 'active',
        stateLabel: 'Active',
      },
      currentTurn: {
        turnId: 'turn-1',
        state: 'completed',
        stateLabel: 'Completed',
        model: null,
        effort: null,
        startedAt: '2026-03-21T15:09:15Z',
        completedAt: '2026-03-21T15:09:22Z',
      },
      streams: {
        assistantText: '',
        reasoningText: '',
        reasoningSummaryText: '',
        planText: '',
        commandOutput: '',
        fileChangeOutput: '',
        unifiedDiff: '',
      },
      items: [],
      requests: [],
      notices: [],
    } as any;

    const events = [
      {
        sequence: 1,
        eventId: 'user-completed',
        sessionId: 's1',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'user-1',
        requestId: null,
        createdAt: '2026-03-21T15:09:20Z',
        type: 'item.completed',
        raw: null,
        item: {
          itemType: 'user_message',
          status: 'completed',
          title: 'Tool completed',
          detail: 'Reply with exactly HELLO_FROM_SOURCE_LENS.',
        },
      },
      {
        sequence: 2,
        eventId: 'assistant-completed',
        sessionId: 's1',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'assistant-1',
        requestId: null,
        createdAt: '2026-03-21T15:09:22Z',
        type: 'item.completed',
        raw: null,
        item: {
          itemType: 'assistant_message',
          status: 'completed',
          title: 'Assistant message',
          detail: 'HELLO_FROM_SOURCE_LENS',
        },
      },
    ] as any;

    const transcript = buildLensTranscriptEntries(snapshot, events);
    const userEntry = transcript.find((entry) => entry.kind === 'user');
    const assistantEntry = transcript.find((entry) => entry.kind === 'assistant');

    expect(userEntry?.meta).not.toContain('Completed');
    expect(assistantEntry?.meta).not.toContain('Completed');
    expect(userEntry?.meta).toMatch(/\d{2}:\d{2}/);
    expect(assistantEntry?.meta).toMatch(/\d{2}:\d{2}/);
  });

  it('virtualizes older transcript rows but keeps a visible window', async () => {
    const { computeTranscriptVirtualWindow } = await import('./index');

    const entries = Array.from({ length: 120 }, (_, index) => ({
      id: `row-${index}`,
      order: index,
      kind: 'assistant',
      tone: 'info',
      label: 'Assistant',
      title: '',
      body: `Row ${index} `.repeat(8),
      meta: 'now',
    })) as any;

    const windowed = computeTranscriptVirtualWindow(entries, 1800, 900);

    expect(windowed.start).toBeGreaterThan(0);
    expect(windowed.end).toBeLessThan(entries.length);
    expect(windowed.topSpacerPx).toBeGreaterThan(0);
    expect(windowed.bottomSpacerPx).toBeGreaterThan(0);
  });

  it('disables transcript virtualization on compact mobile widths', async () => {
    const { computeTranscriptVirtualWindow } = await import('./index');

    const entries = Array.from({ length: 120 }, (_, index) => ({
      id: `row-${index}`,
      order: index,
      kind: 'assistant',
      tone: 'info',
      label: 'Assistant',
      title: '',
      body: `Row ${index} `.repeat(12),
      meta: 'now',
    })) as any;

    const windowed = computeTranscriptVirtualWindow(entries, 1800, 900, 375);

    expect(windowed).toEqual({
      start: 0,
      end: entries.length,
      topSpacerPx: 0,
      bottomSpacerPx: 0,
    });
  });

  it('estimates taller transcript rows for narrow viewports', async () => {
    const { estimateTranscriptEntryHeight } = await import('./index');

    const entry = {
      id: 'assistant-1',
      order: 1,
      kind: 'assistant',
      tone: 'info',
      label: 'Assistant',
      title: '',
      body: 'A long assistant message '.repeat(20),
      meta: 'now',
    } as any;

    const desktopEstimate = estimateTranscriptEntryHeight(entry, 960);
    const mobileEstimate = estimateTranscriptEntryHeight(entry, 420);

    expect(mobileEstimate).toBeGreaterThan(desktopEstimate);
  });

  it('marks the newest assistant row as live while the current turn is still running', async () => {
    const { withLiveAssistantState } = await import('./index');

    const snapshot = {
      currentTurn: {
        state: 'running',
      },
    } as any;

    const entries = [
      {
        id: 'user-1',
        order: 1,
        kind: 'user',
        tone: 'positive',
        label: 'You',
        title: '',
        body: 'Question',
        meta: 'now',
      },
      {
        id: 'assistant-1',
        order: 2,
        kind: 'assistant',
        tone: 'info',
        label: 'Assistant',
        title: '',
        body: 'Partial answer',
        meta: 'now',
      },
    ] as any;

    const marked = withLiveAssistantState(snapshot, entries);
    expect(marked[0]?.live).toBeUndefined();
    expect(marked[1]?.live).toBe(true);
  });
});
