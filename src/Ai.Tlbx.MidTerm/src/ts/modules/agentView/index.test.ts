import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const onTabActivated = vi.fn();
const onTabDeactivated = vi.fn();
const switchTab = vi.fn();
const attachSessionLens = vi.fn();
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
  attachSessionLens,
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
        append: vi.fn(),
        appendChild: vi.fn(),
        replaceChildren: vi.fn(),
        addEventListener: vi.fn(),
      }),
      createDocumentFragment: () => ({
        appendChild: vi.fn(),
        childNodes: [],
      }),
    });
    onTabActivated.mockReset();
    onTabDeactivated.mockReset();
    switchTab.mockReset();
    attachSessionLens.mockReset();
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

    expect(showDevErrorDialog).toHaveBeenCalledTimes(1);
    expect(showDevErrorDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Lens failed to open',
        context: 'Lens activation failed for session s1',
        error: expect.any(Error),
      }),
    );
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
});
