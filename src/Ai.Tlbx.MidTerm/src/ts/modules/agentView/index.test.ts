import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const onTabActivated = vi.fn();
const onTabDeactivated = vi.fn();
const switchTab = vi.fn();
const ensureSessionWrapper = vi.fn();
const getTabPanel = vi.fn();
const setSessionLensAvailability = vi.fn();
const getActiveTab = vi.fn(() => 'agent');
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
let activeSessionId: string | null = null;
const activeSessionSubscribers: Array<(sessionId: string | null) => void> = [];

function createMockDomNode(overrides: Record<string, unknown> = {}): any {
  const node: any = {
    dataset: {} as DOMStringMap,
    style: {} as CSSStyleDeclaration,
    className: '',
    textContent: '',
    innerHTML: '',
    hidden: false,
    disabled: false,
    value: '',
    children: [] as any[],
    childNodes: [] as any[],
    firstChild: null as any,
    lastChild: null as any,
    append: vi.fn(function (this: any, ...items: any[]) {
      items.forEach((item) => this.insertBefore(item, null));
    }),
    appendChild: vi.fn(function (this: any, child: any) {
      return this.insertBefore(child, null);
    }),
    replaceChildren: vi.fn(function (this: any, ...items: any[]) {
      this.childNodes = [];
      this.children = [];
      items.forEach((item) => this.insertBefore(item, null));
    }),
    insertBefore: vi.fn(function (this: any, child: any, anchor: any) {
      const nodes = this.childNodes as any[];
      const existingIndex = nodes.indexOf(child);
      if (existingIndex >= 0) {
        nodes.splice(existingIndex, 1);
      }

      const anchorIndex = anchor ? nodes.indexOf(anchor) : -1;
      if (anchorIndex >= 0) {
        nodes.splice(anchorIndex, 0, child);
      } else {
        nodes.push(child);
      }

      this.childNodes = nodes;
      this.children = nodes;
      this.firstChild = nodes[0] ?? null;
      this.lastChild = nodes[nodes.length - 1] ?? null;
      return child;
    }),
    removeChild: vi.fn(function (this: any, child: any) {
      const nodes = (this.childNodes as any[]).filter((candidate) => candidate !== child);
      this.childNodes = nodes;
      this.children = nodes;
      this.firstChild = nodes[0] ?? null;
      this.lastChild = nodes[nodes.length - 1] ?? null;
      return child;
    }),
    setAttribute: vi.fn(),
    addEventListener: vi.fn(),
    classList: {
      add: vi.fn(),
      remove: vi.fn(),
      toggle: vi.fn(),
      contains: vi.fn(() => false),
    },
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
  };

  return Object.assign(node, overrides);
}

vi.mock('../sessionTabs', () => ({
  ensureSessionWrapper,
  getActiveTab,
  getTabPanel,
  onTabActivated,
  onTabDeactivated,
  setSessionLensAvailability,
  switchTab,
}));

vi.mock('../../stores', () => ({
  $activeSessionId: {
    get: () => activeSessionId,
    subscribe: (callback: (sessionId: string | null) => void) => {
      activeSessionSubscribers.push(callback);
      return () => {};
    },
  },
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
      createElement: () => createMockDomNode(),
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
      location: {
        origin: 'https://midterm.test',
      },
      cancelAnimationFrame: vi.fn(),
      requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
        queueMicrotask(() => callback(0));
        return 1;
      }),
    });
    onTabActivated.mockReset();
    onTabDeactivated.mockReset();
    switchTab.mockReset();
    ensureSessionWrapper.mockReset();
    getTabPanel.mockReset();
    setSessionLensAvailability.mockReset();
    getActiveTab.mockReset();
    getActiveTab.mockReturnValue('agent');
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
    activeSessionId = null;
    activeSessionSubscribers.length = 0;
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function createPanel(): HTMLDivElement {
    const elements = new Map<string, any>();

    const getElement = (selector: string) => {
      if (!elements.has(selector)) {
        elements.set(selector, createMockDomNode());
      }

      return elements.get(selector);
    };

    return {
      ...createMockDomNode(),
      querySelector: vi.fn((selector: string) => getElement(selector)),
    } as unknown as HTMLDivElement;
  }

  function setActiveLensSession(sessionId: string | null): void {
    activeSessionId = sessionId;
    activeSessionSubscribers.forEach((callback) => callback(sessionId));
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

  it('can mount and render a debug scenario without requiring a pre-activated Lens tab', async () => {
    const panel = createPanel();
    getTabPanel.mockReturnValue(panel);

    const { showLensDebugScenario } = await import('./index');

    expect(showLensDebugScenario('s1', 'workflow')).toBe(true);
    expect(ensureSessionWrapper).toHaveBeenCalledWith('s1');
    expect(setSessionLensAvailability).toHaveBeenCalledWith('s1', true);
    expect(switchTab).toHaveBeenCalledWith('s1', 'agent');
    expect(panel.classList.add).toHaveBeenCalledWith('agent-view-panel');
  });

  it('keeps debug scenarios isolated from the live Lens attach path', async () => {
    const panel = createPanel();
    getTabPanel.mockReturnValue(panel);

    const { initAgentView, showLensDebugScenario } = await import('./index');
    initAgentView();

    expect(showLensDebugScenario('s1', 'workflow')).toBe(true);

    const activate = onTabActivated.mock.calls[0]?.[1] as
      | ((sessionId: string, panel: HTMLDivElement) => void)
      | undefined;

    await activate?.('s1', panel);

    expect(attachSessionLens).not.toHaveBeenCalled();
    expect(getLensEvents).not.toHaveBeenCalled();
    expect(getLensSnapshot).not.toHaveBeenCalled();
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

    setActiveLensSession('s1');

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
    expect(getLensEvents.mock.calls.length).toBeLessThanOrEqual(1);
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
      expect(attachSessionLens).toHaveBeenCalled();
    });
    expect(showDevErrorDialog.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('refreshes Lens history and reconnects the stream after an accepted turn from read-only history', async () => {
    attachSessionLens.mockRejectedValue(
      new Error('HTTP 400: MidTerm could not determine the Codex resume id for this session.'),
    );
    getLensSnapshot
      .mockResolvedValueOnce({
        sessionId: 's1',
        provider: 'codex',
        generatedAt: '2026-03-23T21:40:01Z',
        latestSequence: 36,
        session: {
          state: 'ready',
          stateLabel: 'Ready',
          reason: 'Codex turn completed.',
          lastError: null,
          lastEventAt: '2026-03-23T21:40:01Z',
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
          startedAt: '2026-03-23T21:39:55Z',
          completedAt: '2026-03-23T21:40:01Z',
        },
        streams: {
          assistantText: '`C:\\Users\\johan`',
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
      })
      .mockResolvedValueOnce({
        sessionId: 's1',
        provider: 'codex',
        generatedAt: '2026-03-23T21:40:32Z',
        latestSequence: 75,
        session: {
          state: 'ready',
          stateLabel: 'Ready',
          reason: 'Codex turn completed.',
          lastError: null,
          lastEventAt: '2026-03-23T21:40:32Z',
        },
        thread: {
          threadId: 'thread-1',
          state: 'active',
          stateLabel: 'Active',
        },
        currentTurn: {
          turnId: 'turn-2',
          state: 'completed',
          stateLabel: 'Completed',
          model: null,
          effort: null,
          startedAt: '2026-03-23T21:40:24Z',
          completedAt: '2026-03-23T21:40:32Z',
        },
        streams: {
          assistantText: 'Checking the current shell working directory directly.',
          reasoningText: '',
          reasoningSummaryText: '',
          planText: '',
          commandOutput: 'C:\\Users\\johan',
          fileChangeOutput: '',
          unifiedDiff: '',
        },
        items: [],
        requests: [],
        notices: [],
      });
    getLensEvents.mockResolvedValue({
      sessionId: 's1',
      latestSequence: 36,
      events: [],
    });

    const { initAgentView } = await import('./index');
    const { LENS_TURN_ACCEPTED_EVENT } = await import('../lens/input');
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

    const acceptedListener = (window.addEventListener as ReturnType<typeof vi.fn>).mock.calls.find(
      ([name]) => name === LENS_TURN_ACCEPTED_EVENT,
    )?.[1] as ((event: Event) => void) | undefined;
    expect(acceptedListener).toBeTypeOf('function');

    acceptedListener?.({
      detail: {
        optimisticId: 'opt-1',
        sessionId: 's1',
        request: {
          text: 'what working dir are we in now?',
          attachments: [],
        },
        response: {
          sessionId: 's1',
          status: 'accepted',
          provider: 'codex',
          threadId: 'thread-1',
          turnId: 'turn-2',
          requestId: null,
          model: null,
          effort: null,
        },
      },
    } as Event);

    await vi.waitFor(() => {
      expect(openLensEventStream).toHaveBeenCalledWith(
        's1',
        expect.any(Number),
        expect.any(Number),
        expect.any(Number),
        expect.any(Object),
      );
    });
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

  it('renders the composer interruption UI for open user-input requests', async () => {
    attachSessionLens.mockResolvedValue(undefined);
    getLensSnapshot.mockResolvedValue({
      sessionId: 's1',
      provider: 'codex',
      generatedAt: '2026-03-23T11:00:00Z',
      latestSequence: 1,
      session: {
        state: 'running',
        stateLabel: 'Running',
        reason: 'Waiting for user input.',
        lastError: null,
        lastEventAt: '2026-03-23T11:00:00Z',
      },
      thread: {
        threadId: 'thread-1',
        state: 'active',
        stateLabel: 'Active',
      },
      currentTurn: {
        turnId: 'turn-1',
        state: 'paused',
        stateLabel: 'Paused',
        model: null,
        effort: null,
        startedAt: '2026-03-23T10:59:45Z',
        completedAt: null,
      },
      streams: {
        assistantText: 'Choose a mode before I continue.',
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
          kind: 'tool_user_input',
          kindLabel: 'Question',
          state: 'open',
          detail: 'Please choose a mode.',
          decision: null,
          questions: [
            {
              id: 'mode',
              header: 'Mode',
              question: 'Choose SAFE or FAST before I continue.',
              options: [
                { label: 'SAFE', description: 'Proceed carefully.' },
                { label: 'FAST', description: 'Move quickly.' },
              ],
            },
          ],
          answers: [],
          updatedAt: '2026-03-23T11:00:00Z',
        },
      ],
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

    await vi.waitFor(() => {
      expect(getLensSnapshot).toHaveBeenCalledWith('s1');
      expect(getLensEvents.mock.calls.length).toBeLessThanOrEqual(1);
    });

    const interruptionHost = panel.querySelector(
      '[data-agent-field="composer-interruption"]',
    ) as any;
    expect(interruptionHost).toBeTruthy();
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

  it('does not close the live Lens stream when the agent tab is deactivated', async () => {
    const disconnectStream = vi.fn();
    openLensEventStream.mockReturnValue(disconnectStream);
    attachSessionLens.mockResolvedValue(undefined);
    getLensSnapshot.mockResolvedValue({
      sessionId: 's1',
      provider: 'codex',
      generatedAt: '2026-03-28T11:00:00Z',
      latestSequence: 1,
      session: {
        state: 'ready',
        stateLabel: 'Ready',
        reason: null,
        lastError: null,
        lastEventAt: '2026-03-28T11:00:00Z',
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
        startedAt: '2026-03-28T10:59:30Z',
        completedAt: '2026-03-28T11:00:00Z',
      },
      streams: {
        assistantText: 'Done.',
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
      transcript: [],
    });
    getLensEvents.mockResolvedValue({
      sessionId: 's1',
      latestSequence: 1,
      events: [],
    });

    setActiveLensSession('s1');

    const { initAgentView } = await import('./index');
    initAgentView();

    const activate = onTabActivated.mock.calls[0]?.[1] as
      | ((sessionId: string, panel: HTMLDivElement) => void)
      | undefined;
    const deactivate = onTabDeactivated.mock.calls[0]?.[1] as
      | ((sessionId: string) => void)
      | undefined;
    expect(activate).toBeTypeOf('function');
    expect(deactivate).toBeTypeOf('function');

    activate?.('s1', createPanel());

    await vi.waitFor(() => {
      expect(openLensEventStream).toHaveBeenCalledTimes(1);
    });

    deactivate?.('s1');
    await Promise.resolve();

    expect(disconnectStream).not.toHaveBeenCalled();
  });

  it('keeps background Lens streams alive but skips history rerenders while hidden', async () => {
    const disconnectStream = vi.fn();
    openLensEventStream.mockReturnValue(disconnectStream);
    attachSessionLens.mockResolvedValue(undefined);
    getLensSnapshot.mockResolvedValue({
      sessionId: 's1',
      provider: 'codex',
      generatedAt: '2026-03-28T11:00:00Z',
      latestSequence: 1,
      session: {
        state: 'running',
        stateLabel: 'Running',
        reason: null,
        lastError: null,
        lastEventAt: '2026-03-28T11:00:00Z',
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
        startedAt: '2026-03-28T10:59:30Z',
        completedAt: null,
      },
      streams: {
        assistantText: 'Initial assistant text.',
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
      transcript: [
        {
          entryId: 'assistant:turn-1',
          turnId: 'turn-1',
          itemId: 'assistant-1',
          requestId: null,
          order: 1,
          kind: 'assistant',
          status: 'running',
          title: 'Assistant',
          body: 'Initial assistant text.',
          updatedAt: '2026-03-28T11:00:00Z',
          streaming: true,
          attachments: [],
        },
      ],
    });
    getLensEvents.mockResolvedValue({
      sessionId: 's1',
      latestSequence: 1,
      events: [],
    });

    setActiveLensSession('s1');

    const { initAgentView } = await import('./index');
    initAgentView();

    const activate = onTabActivated.mock.calls[0]?.[1] as
      | ((sessionId: string, panel: HTMLDivElement) => void)
      | undefined;
    expect(activate).toBeTypeOf('function');

    const panel = createPanel();
    activate?.('s1', panel);

    await vi.waitFor(() => {
      expect(openLensEventStream).toHaveBeenCalledTimes(1);
    });

    const historyHost = panel.querySelector('[data-agent-field="history"]') as any;
    historyHost.replaceChildren.mockClear();

    setActiveLensSession('s2');

    const streamCallbacks = openLensEventStream.mock.calls[0]?.[4] as
      | { onDelta(delta: unknown): void }
      | undefined;
    expect(streamCallbacks).toBeTruthy();

    streamCallbacks?.onDelta({
      sessionId: 's1',
      provider: 'codex',
      generatedAt: '2026-03-28T11:00:01Z',
      latestSequence: 2,
      totalHistoryCount: 1,
      session: {
        state: 'running',
        stateLabel: 'Running',
        reason: 'Codex turn started.',
        lastError: null,
        lastEventAt: '2026-03-28T11:00:01Z',
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
        model: 'gpt-5.4',
        effort: 'medium',
        startedAt: '2026-03-28T11:00:00Z',
        completedAt: null,
      },
      streams: {
        assistantText: 'partial answer',
        reasoningText: '',
        reasoningSummaryText: '',
        planText: '',
        commandOutput: '',
        fileChangeOutput: '',
        unifiedDiff: '',
      },
      historyUpserts: [
        {
          entryId: 'assistant:assistant-1',
          order: 1,
          kind: 'assistant',
          turnId: 'turn-1',
          itemId: 'assistant-1',
          requestId: null,
          status: 'streaming',
          itemType: 'assistant_text',
          title: null,
          body: 'partial answer',
          attachments: [],
          streaming: true,
          createdAt: '2026-03-28T11:00:00Z',
          updatedAt: '2026-03-28T11:00:01Z',
        },
      ],
      historyRemovals: [],
      itemUpserts: [],
      itemRemovals: [],
      requestUpserts: [],
      requestRemovals: [],
      noticeUpserts: [],
    });
    await Promise.resolve();

    expect(disconnectStream).not.toHaveBeenCalled();
    expect(historyHost.replaceChildren).not.toHaveBeenCalled();
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
    expect(issue.actions.map((action) => action.id)).toEqual(['retry-lens']);
  });

  it('classifies shell recovery failure as an expected handoff issue', async () => {
    const { classifyLensActivationIssue } = await import('./index');

    const issue = classifyLensActivationIssue(
      new Error('HTTP 400: Terminal shell did not recover after stopping Codex.'),
      false,
    );

    expect(issue.kind).toBe('shell-recovery-failed');
    expect(issue.meta).toBe('Terminal recovery failed');
    expect(issue.actions.map((action) => action.id)).toEqual(['retry-lens']);
  });

  it('classifies native runtime unavailability as an expected Lens issue', async () => {
    const { classifyLensActivationIssue } = await import('./index');

    const issue = classifyLensActivationIssue(
      new Error('HTTP 400: Lens native runtime is not available for this session.'),
      false,
    );

    expect(issue.kind).toBe('native-runtime-unavailable');
    expect(issue.meta).toBe('Native runtime unavailable');
    expect(issue.actions.map((action) => action.id)).toEqual(['retry-lens']);
  });

  it('prepends a readable Lens issue row ahead of the history', async () => {
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
          body: 'History still visible.',
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
          { id: 'retry-lens', label: 'Retry Lens', style: 'primary', busyLabel: 'Retrying...' },
        ],
      },
    );

    expect(entries).toHaveLength(2);
    expect(entries[0]?.kind).toBe('system');
    expect(entries[0]?.title).toBe('No resumable Codex thread is known yet');
    expect(entries[0]?.actions?.map((action) => action.id)).toEqual(['retry-lens']);
    expect(entries[1]?.body).toBe('History still visible.');
  });

  it('compacts duplicate activation failure rows when an expected handoff issue is active', async () => {
    const { buildActivationHistoryEntries } = await import('./index');

    const entries = buildActivationHistoryEntries({
      panel: createPanel(),
      snapshot: null,
      events: [],
      historyViewport: null,
      historyEntries: [],
      disconnectStream: null,
      streamConnected: false,
      refreshScheduled: null,
      refreshInFlight: false,
      requestBusyIds: new Set<string>(),
      historyAutoScrollPinned: true,
      historyRenderScheduled: null,
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
          detail: 'MidTerm is opening the Lens conversation surface for this session.',
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
    const { buildActivationHistoryEntries } = await import('./index');

    const entries = buildActivationHistoryEntries({
      panel: createPanel(),
      snapshot: null,
      events: [],
      historyViewport: null,
      historyEntries: [],
      disconnectStream: null,
      streamConnected: false,
      refreshScheduled: null,
      refreshInFlight: false,
      requestBusyIds: new Set<string>(),
      historyAutoScrollPinned: true,
      historyRenderScheduled: null,
      activationState: 'failed',
      activationDetail: 'Lens startup failed.',
      activationError:
        'HTTP 400: MidTerm could not determine the Codex resume id for this session.',
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
          detail: 'MidTerm is opening the Lens conversation surface for this session.',
        },
      ],
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe('system');
    expect(entries[0]?.meta).toBe('Opening • 03:16');
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

  it('drops optimistic placeholders once canonical history entries exist for the turn', async () => {
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

  it.skip('builds history-first rows from canonical Lens events', async () => {
    const { buildLensHistoryEntries } = await import('./index');

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
          detail: 'Implement the history UI.',
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

    const history = buildLensHistoryEntries(snapshot, events);

    expect(history.map((entry) => entry.kind)).toContain('user');
    expect(history.map((entry) => entry.kind)).toContain('assistant');
    expect(history.map((entry) => entry.kind)).toContain('tool');
    expect(history.map((entry) => entry.kind)).toContain('request');
    expect(history.find((entry) => entry.kind === 'assistant')?.body).toContain('Working on it.');
    expect(history.find((entry) => entry.kind === 'request')?.requestId).toBe('req-1');
  });

  it.skip('backs current-turn history rows from snapshot items when event history is incomplete', async () => {
    const { buildLensHistoryEntries, withLiveAssistantState } = await import('./index');

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

    const history = buildLensHistoryEntries(snapshot, []);
    const marked = withLiveAssistantState(snapshot, history);

    expect(
      marked.some((entry) => entry.kind === 'user' && entry.body.includes('Describe the logo')),
    ).toBe(true);
    expect(
      marked.some(
        (entry) =>
          entry.kind === 'assistant' && entry.body.includes('Streaming answer in progress.'),
      ),
    ).toBe(true);
    expect(marked.some((entry) => entry.kind === 'assistant' && entry.live)).toBe(true);
  });

  it('prefers canonical backend history rows over rebuilding from raw events', async () => {
    const { buildLensHistoryEntries } = await import('./index');

    const snapshot = {
      sessionId: 's1',
      provider: 'codex',
      generatedAt: '2026-03-27T13:00:00Z',
      latestSequence: 22,
      session: {
        state: 'ready',
        stateLabel: 'Ready',
        reason: null,
        lastError: null,
        lastEventAt: '2026-03-27T13:00:00Z',
      },
      thread: {
        threadId: 'thread-1',
        state: 'active',
        stateLabel: 'Active',
      },
      currentTurn: {
        turnId: 'turn-2',
        state: 'completed',
        stateLabel: 'Completed',
        model: 'gpt-5',
        effort: 'medium',
        startedAt: '2026-03-27T12:59:00Z',
        completedAt: '2026-03-27T13:00:00Z',
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
      transcript: [
        {
          entryId: 'user:turn-1',
          order: 1,
          kind: 'user',
          turnId: 'turn-1',
          itemId: 'local-user:turn-1',
          requestId: null,
          status: 'completed',
          itemType: 'user_message',
          title: null,
          body: 'first question',
          attachments: [],
          streaming: false,
          createdAt: '2026-03-27T12:58:00Z',
          updatedAt: '2026-03-27T12:58:00Z',
        },
        {
          entryId: 'assistant:turn-1',
          order: 2,
          kind: 'assistant',
          turnId: 'turn-1',
          itemId: 'assistant-1',
          requestId: null,
          status: 'completed',
          itemType: 'assistant_message',
          title: null,
          body: 'first answer',
          attachments: [],
          streaming: false,
          createdAt: '2026-03-27T12:58:01Z',
          updatedAt: '2026-03-27T12:58:02Z',
        },
        {
          entryId: 'assistant:turn-2',
          order: 4,
          kind: 'assistant',
          turnId: 'turn-2',
          itemId: 'assistant-2',
          requestId: null,
          status: 'streaming',
          itemType: 'assistant_message',
          title: null,
          body: 'second answer in progress',
          attachments: [],
          streaming: true,
          createdAt: '2026-03-27T12:59:30Z',
          updatedAt: '2026-03-27T12:59:31Z',
        },
      ],
      items: [],
      requests: [],
      notices: [],
    } as any;

    const events = [
      {
        sequence: 1,
        eventId: 'contradictory-event',
        sessionId: 's1',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-99',
        itemId: 'assistant-99',
        requestId: null,
        createdAt: '2026-03-27T12:59:59Z',
        type: 'content.delta',
        contentDelta: {
          streamKind: 'assistant_text',
          delta: 'wrong answer',
        },
      },
    ] as any;

    const history = buildLensHistoryEntries(snapshot, events);

    expect(history.map((entry) => entry.id)).toEqual([
      'user:turn-1',
      'assistant:turn-1',
      'assistant:turn-2',
    ]);
    expect(history[2]?.body).toBe('second answer in progress');
    expect(history[2]?.live).toBe(true);
  });

  it('maps canonical history metadata, requests, and attachments into render rows', async () => {
    const { buildLensHistoryEntries } = await import('./index');

    const snapshot = {
      sessionId: 's1',
      provider: 'codex',
      generatedAt: '2026-03-27T13:05:00Z',
      latestSequence: 9,
      session: {
        state: 'ready',
        stateLabel: 'Ready',
        reason: null,
        lastError: null,
        lastEventAt: '2026-03-27T13:05:00Z',
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
        startedAt: '2026-03-27T13:04:00Z',
        completedAt: '2026-03-27T13:05:00Z',
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
      transcript: [
        {
          entryId: 'user:turn-1',
          order: 1,
          kind: 'user',
          turnId: 'turn-1',
          itemId: 'local-user:turn-1',
          requestId: null,
          status: 'completed',
          itemType: 'user_message',
          title: null,
          body: '',
          attachments: [
            {
              kind: 'image',
              path: 'Q:/repo/.midterm/uploads/example.png',
              mimeType: 'image/png',
              displayName: 'example.png',
            },
          ],
          streaming: false,
          createdAt: '2026-03-27T13:04:01Z',
          updatedAt: '2026-03-27T13:04:01Z',
        },
        {
          entryId: 'request:req-1',
          order: 2,
          kind: 'request',
          turnId: 'turn-1',
          itemId: null,
          requestId: 'req-1',
          status: 'open',
          itemType: 'tool_user_input',
          title: 'User input',
          body: 'Choose SAFE or FAST.',
          attachments: [],
          streaming: false,
          createdAt: '2026-03-27T13:04:02Z',
          updatedAt: '2026-03-27T13:04:03Z',
        },
      ],
      items: [],
      requests: [],
      notices: [],
    } as any;

    const history = buildLensHistoryEntries(snapshot, []);

    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({
      kind: 'user',
    });
    expect(history[0]?.attachments).toHaveLength(1);
    expect(history[1]).toMatchObject({
      kind: 'request',
      requestId: 'req-1',
      body: 'Choose SAFE or FAST.',
    });
  });

  it('keeps backend history order when a turn has both streamed and final assistant rows', async () => {
    const { buildLensHistoryEntries } = await import('./index');

    const snapshot = {
      sessionId: 's1',
      provider: 'codex',
      generatedAt: '2026-03-27T16:40:59Z',
      latestSequence: 12,
      session: {
        state: 'ready',
        stateLabel: 'Ready',
        reason: null,
        lastError: null,
        lastEventAt: '2026-03-27T16:40:59Z',
      },
      thread: {
        threadId: 'thread-1',
        state: 'active',
        stateLabel: 'Active',
      },
      currentTurn: {
        turnId: 'turn-2',
        state: 'completed',
        stateLabel: 'Completed',
        model: 'gpt-5',
        effort: 'medium',
        startedAt: '2026-03-27T16:40:24Z',
        completedAt: '2026-03-27T16:40:59Z',
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
      transcript: [
        {
          entryId: 'user:turn-2',
          order: 1,
          kind: 'user',
          turnId: 'turn-2',
          itemId: 'local-user:turn-2',
          requestId: null,
          status: 'completed',
          itemType: 'user_message',
          title: null,
          body: 'erstelle eine tabelle',
          attachments: [],
          streaming: false,
          createdAt: '2026-03-27T16:40:24Z',
          updatedAt: '2026-03-27T16:40:24Z',
        },
        {
          entryId: 'assistant-stream:turn-2',
          order: 2,
          kind: 'assistant',
          turnId: 'turn-2',
          itemId: null,
          requestId: null,
          status: 'streaming',
          itemType: 'assistant_text',
          title: null,
          body: 'Ich lese kurz den Inhalt des aktuellen Arbeitsverzeichnisses.',
          attachments: [],
          streaming: true,
          createdAt: '2026-03-27T16:40:25Z',
          updatedAt: '2026-03-27T16:40:25Z',
        },
        {
          entryId: 'tool:tool-1',
          order: 3,
          kind: 'tool',
          turnId: 'turn-2',
          itemId: 'tool-1',
          requestId: null,
          status: 'completed',
          itemType: 'command',
          title: 'Get-ChildItem',
          body: 'Dateiliste abgefragt',
          attachments: [],
          streaming: false,
          createdAt: '2026-03-27T16:40:32Z',
          updatedAt: '2026-03-27T16:40:32Z',
        },
        {
          entryId: 'assistant:assistant-item-2',
          order: 4,
          kind: 'assistant',
          turnId: 'turn-2',
          itemId: 'assistant-item-2',
          requestId: null,
          status: 'completed',
          itemType: 'assistant_message',
          title: null,
          body: '| Name | Groesse |\n| --- | --- |\n| file.txt | 42 |',
          attachments: [],
          streaming: false,
          createdAt: '2026-03-27T16:40:58Z',
          updatedAt: '2026-03-27T16:40:59Z',
        },
      ],
      items: [],
      requests: [],
      notices: [],
    } as any;

    const history = buildLensHistoryEntries(snapshot, []);

    expect(history.map((entry) => entry.id)).toEqual([
      'user:turn-2',
      'assistant-stream:turn-2',
      'tool:tool-1',
      'assistant:assistant-item-2',
    ]);
    expect(history[1]?.live).toBe(true);
    expect(history[3]?.live).toBe(false);
  });

  it.skip('hides normal state-management events and merges tool updates', async () => {
    const { buildLensHistoryEntries } = await import('./index');

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

    const history = buildLensHistoryEntries(snapshot, events);

    expect(history).toHaveLength(3);
    expect(history[0]).toMatchObject({
      kind: 'tool',
      title: 'Run tests',
    });
    expect(history[0]?.body).toContain('npm run typecheck');
    expect(history[1]).toMatchObject({
      kind: 'tool',
      title: 'Command output',
    });
    expect(history[1]?.body).toContain('All green');
    expect(history[2]).toMatchObject({
      kind: 'reasoning',
      title: 'Reasoning',
    });
    expect(history[2]?.body).toContain('Thinking...');
  });

  it.skip('surfaces generic tool result streams instead of dropping them', async () => {
    const { buildLensHistoryEntries } = await import('./index');

    const snapshot = {
      sessionId: 's1',
      provider: 'codex',
      generatedAt: '2026-03-23T10:00:00Z',
      latestSequence: 2,
      session: {
        state: 'ready',
        stateLabel: 'Ready',
        reason: null,
        lastError: null,
        lastEventAt: '2026-03-23T10:00:00Z',
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
        startedAt: '2026-03-23T09:59:58Z',
        completedAt: '2026-03-23T10:00:00Z',
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
        eventId: 'e-tool-result',
        sessionId: 's1',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'tool-1',
        requestId: null,
        createdAt: '2026-03-23T09:59:59Z',
        type: 'content.delta',
        raw: null,
        contentDelta: {
          streamKind: 'tool_result',
          delta: 'exit_code: 0',
        },
      },
    ] as any;

    const history = buildLensHistoryEntries(snapshot, events);

    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      kind: 'tool',
      title: 'Tool Result',
    });
    expect(history[0]?.body).toContain('exit_code: 0');
  });

  it.skip('keeps distinct tool and reasoning stream kinds in separate history rows', async () => {
    const { buildLensHistoryEntries } = await import('./index');

    const snapshot = {
      sessionId: 's1',
      provider: 'codex',
      generatedAt: '2026-03-23T10:00:00Z',
      latestSequence: 4,
      session: {
        state: 'ready',
        stateLabel: 'Ready',
        reason: null,
        lastError: null,
        lastEventAt: '2026-03-23T10:00:00Z',
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
        startedAt: '2026-03-23T09:59:58Z',
        completedAt: '2026-03-23T10:00:00Z',
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
        eventId: 'e-command-output',
        sessionId: 's1',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: null,
        requestId: null,
        createdAt: '2026-03-23T09:59:59Z',
        type: 'content.delta',
        raw: null,
        contentDelta: {
          streamKind: 'command_output',
          delta: 'npm test',
        },
      },
      {
        sequence: 2,
        eventId: 'e-file-change-output',
        sessionId: 's1',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: null,
        requestId: null,
        createdAt: '2026-03-23T09:59:59Z',
        type: 'content.delta',
        raw: null,
        contentDelta: {
          streamKind: 'file_change_output',
          delta: 'M report.md',
        },
      },
      {
        sequence: 3,
        eventId: 'e-reasoning',
        sessionId: 's1',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: null,
        requestId: null,
        createdAt: '2026-03-23T09:59:59Z',
        type: 'content.delta',
        raw: null,
        contentDelta: {
          streamKind: 'reasoning_text',
          delta: 'Need approval first.',
        },
      },
      {
        sequence: 4,
        eventId: 'e-reasoning-summary',
        sessionId: 's1',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: null,
        requestId: null,
        createdAt: '2026-03-23T09:59:59Z',
        type: 'content.delta',
        raw: null,
        contentDelta: {
          streamKind: 'reasoning_summary_text',
          delta: 'Waiting for SAFE/FAST.',
        },
      },
    ] as any;

    const history = buildLensHistoryEntries(snapshot, events);

    expect(history).toHaveLength(4);
    expect(history[0]).toMatchObject({ kind: 'tool', title: 'Command output' });
    expect(history[0]?.body).toContain('npm test');
    expect(history[1]).toMatchObject({ kind: 'tool', title: 'File change output' });
    expect(history[1]?.body).toContain('M report.md');
    expect(history[2]).toMatchObject({ kind: 'reasoning', title: 'Reasoning' });
    expect(history[2]?.body).toContain('Need approval first.');
    expect(history[3]).toMatchObject({ kind: 'reasoning', title: 'Reasoning summary' });
    expect(history[3]?.body).toContain('Waiting for SAFE/FAST.');
  });

  it.skip('renders plan delta and plan completed events as a visible plan row', async () => {
    const { buildLensHistoryEntries } = await import('./index');

    const snapshot = {
      sessionId: 's1',
      provider: 'codex',
      generatedAt: '2026-03-23T10:00:00Z',
      latestSequence: 2,
      session: {
        state: 'ready',
        stateLabel: 'Ready',
        reason: null,
        lastError: null,
        lastEventAt: '2026-03-23T10:00:00Z',
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
        startedAt: '2026-03-23T09:59:55Z',
        completedAt: '2026-03-23T10:00:00Z',
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
        eventId: 'e-plan-delta',
        sessionId: 's1',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: null,
        requestId: null,
        createdAt: '2026-03-23T09:59:56Z',
        type: 'plan.delta',
        raw: null,
        planDelta: {
          delta: '1. Inspect the workspace.\n',
        },
      },
      {
        sequence: 2,
        eventId: 'e-plan-done',
        sessionId: 's1',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: null,
        requestId: null,
        createdAt: '2026-03-23T09:59:57Z',
        type: 'plan.completed',
        raw: null,
        planCompleted: {
          planMarkdown: '1. Inspect the workspace.\n2. Apply the change.',
        },
      },
    ] as any;

    const history = buildLensHistoryEntries(snapshot, events);

    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      kind: 'plan',
      title: 'Plan',
    });
    expect(history[0]?.body).toContain('2. Apply the change.');
  });

  it.skip('uses snapshot reasoning streams when event history is incomplete', async () => {
    const { buildLensHistoryEntries } = await import('./index');

    const snapshot = {
      sessionId: 's1',
      provider: 'codex',
      generatedAt: '2026-03-23T10:00:00Z',
      latestSequence: 0,
      session: {
        state: 'ready',
        stateLabel: 'Ready',
        reason: null,
        lastError: null,
        lastEventAt: '2026-03-23T10:00:00Z',
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
        startedAt: '2026-03-23T09:59:50Z',
        completedAt: '2026-03-23T10:00:00Z',
      },
      streams: {
        assistantText: '',
        reasoningText: 'Need to inspect the modified files first.',
        reasoningSummaryText: 'Summary: verify output, then update docs.',
        planText: '',
        commandOutput: '',
        fileChangeOutput: '',
        unifiedDiff: '',
      },
      items: [],
      requests: [],
      notices: [],
    } as any;

    const history = buildLensHistoryEntries(snapshot, []);

    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({
      kind: 'reasoning',
      title: 'Reasoning',
    });
    expect(history[0]?.body).toContain('inspect the modified files');
    expect(history[1]).toMatchObject({
      kind: 'reasoning',
      title: 'Reasoning summary',
    });
    expect(history[1]?.body).toContain('verify output');
  });

  it.skip('keeps snapshot command output and file change output as separate tool rows', async () => {
    const { buildLensHistoryEntries } = await import('./index');

    const snapshot = {
      sessionId: 's1',
      provider: 'codex',
      generatedAt: '2026-03-23T10:00:00Z',
      latestSequence: 0,
      session: {
        state: 'ready',
        stateLabel: 'Ready',
        reason: null,
        lastError: null,
        lastEventAt: '2026-03-23T10:00:00Z',
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
        startedAt: '2026-03-23T09:59:50Z',
        completedAt: '2026-03-23T10:00:00Z',
      },
      streams: {
        assistantText: '',
        reasoningText: '',
        reasoningSummaryText: '',
        planText: '',
        commandOutput: 'status: TODO\nowner: codex',
        fileChangeOutput: 'Success. Updated the following files:\nM report.md',
        unifiedDiff: '',
      },
      items: [],
      requests: [],
      notices: [],
    } as any;

    const history = buildLensHistoryEntries(snapshot, []);

    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ kind: 'tool', title: 'Command output' });
    expect(history[0]?.body).toContain('status: TODO');
    expect(history[1]).toMatchObject({ kind: 'tool', title: 'File change output' });
    expect(history[1]?.body).toContain('Updated the following files');
  });

  it.skip('places fallback request rows after existing snapshot conversation content', async () => {
    const { buildLensHistoryEntries } = await import('./index');

    const snapshot = {
      sessionId: 's1',
      provider: 'codex',
      generatedAt: '2026-03-23T10:00:00Z',
      latestSequence: 0,
      session: {
        state: 'running',
        stateLabel: 'Running',
        reason: null,
        lastError: null,
        lastEventAt: '2026-03-23T10:00:00Z',
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
        startedAt: '2026-03-23T09:59:50Z',
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
      items: [
        {
          itemId: 'user-1',
          turnId: 'turn-1',
          itemType: 'user_message',
          status: 'completed',
          title: 'User message',
          detail: 'Ask for SAFE or FAST before editing files.',
          attachments: [],
          updatedAt: '2026-03-23T09:59:52Z',
        },
      ],
      requests: [
        {
          requestId: 'req-1',
          turnId: 'turn-1',
          kind: 'tool_user_input',
          kindLabel: 'Question',
          state: 'open',
          detail: 'The agent needs an operator choice.',
          decision: null,
          questions: [
            {
              id: 'mode',
              header: 'Mode',
              question: 'Choose SAFE or FAST.',
              options: [
                { label: 'SAFE', description: 'Validate carefully.' },
                { label: 'FAST', description: 'Move quickly.' },
              ],
            },
          ],
          answers: [],
          updatedAt: '2026-03-23T09:59:58Z',
        },
      ],
      notices: [],
    } as any;

    const history = buildLensHistoryEntries(snapshot, []);

    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ kind: 'user' });
    expect(history[1]).toMatchObject({ kind: 'request' });
  });

  it('suppresses the active open composer request from history rendering', async () => {
    const { suppressActiveComposerRequestEntries } = await import('./index');

    const entries = [
      {
        id: 'user-1',
        order: 1,
        kind: 'user',
        tone: 'info',
        label: 'You',
        title: '',
        body: 'Do the careful path.',
        meta: '11:59:50',
      },
      {
        id: 'request:req-1',
        order: 2,
        kind: 'request',
        tone: 'warning',
        label: 'Request',
        title: 'Question',
        body: 'Choose SAFE or FAST.',
        meta: '11:59:58',
        requestId: 'req-1',
      },
      {
        id: 'diff-1',
        order: 3,
        kind: 'diff',
        tone: 'warning',
        label: 'Diff',
        title: 'Working diff',
        body: '+status: DONE',
        meta: '12:00:00',
      },
    ] as any;

    const requests = [
      {
        requestId: 'req-1',
        state: 'open',
        kind: 'tool_user_input',
        updatedAt: '2026-03-23T11:59:58Z',
      },
    ] as any;

    const visible = suppressActiveComposerRequestEntries(entries, requests);

    expect(visible).toHaveLength(2);
    expect(visible.some((entry) => entry.kind === 'request')).toBe(false);
    expect(visible[0]?.kind).toBe('user');
    expect(visible[1]?.kind).toBe('diff');
  });

  it.skip('renders question requests from user-input events into history rows', async () => {
    const { buildLensHistoryEntries } = await import('./index');

    const snapshot = {
      sessionId: 's1',
      provider: 'codex',
      generatedAt: '2026-03-23T10:00:00Z',
      latestSequence: 1,
      session: {
        state: 'ready',
        stateLabel: 'Ready',
        reason: null,
        lastError: null,
        lastEventAt: '2026-03-23T10:00:00Z',
      },
      thread: {
        threadId: 'thread-1',
        state: 'active',
        stateLabel: 'Active',
      },
      currentTurn: {
        turnId: 'turn-1',
        state: 'paused',
        stateLabel: 'Paused',
        model: null,
        effort: null,
        startedAt: '2026-03-23T09:59:50Z',
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
        eventId: 'e-user-input',
        sessionId: 's1',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: null,
        requestId: 'req-1',
        createdAt: '2026-03-23T09:59:58Z',
        type: 'user-input.requested',
        raw: null,
        userInputRequested: {
          questions: [
            {
              id: 'mode',
              header: 'Mode',
              question: 'Choose SAFE or FAST before I continue.',
              options: [
                { label: 'SAFE', description: 'Proceed cautiously.' },
                { label: 'FAST', description: 'Optimize for speed.' },
              ],
            },
          ],
        },
      },
    ] as any;

    const history = buildLensHistoryEntries(snapshot, events);

    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      kind: 'request',
      requestId: 'req-1',
    });
    expect(history[0]?.body).toContain('Choose SAFE or FAST before I continue.');
    expect(history[0]?.body).toContain('[1] SAFE');
    expect(history[0]?.body).toContain('[2] FAST');
  });

  it('exposes the workflow Lens debug scenario for browser-side UX validation', async () => {
    const { getLensDebugScenarioNames } = await import('./index');

    expect(getLensDebugScenarioNames()).toContain('workflow');
  });

  it.skip('renders a rich real-Codex event mix into visible history rows', async () => {
    const { buildLensHistoryEntries } = await import('./index');

    const snapshot = {
      sessionId: 's1',
      provider: 'codex',
      generatedAt: '2026-03-22T23:59:24Z',
      latestSequence: 12,
      session: {
        state: 'ready',
        stateLabel: 'Ready',
        reason: 'Codex turn completed.',
        lastError: null,
        lastEventAt: '2026-03-22T23:59:24Z',
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
        model: 'gpt-5.4',
        effort: 'high',
        startedAt: '2026-03-22T23:58:54Z',
        completedAt: '2026-03-22T23:59:24Z',
      },
      streams: {
        assistantText:
          'Plan:\n1. Review the workspace.\n2. Summarize the inventory.\n\n| name | count | owner |\n| --- | ---: | --- |\n| alpha | 3 | Ada |',
        reasoningText: '',
        reasoningSummaryText: '',
        planText: '',
        commandOutput: 'status: TODO',
        fileChangeOutput: 'Success. Updated the following files:\nM report.md',
        unifiedDiff: 'diff --git a/report.md b/report.md\n@@\n-status: TODO\n+status: DONE',
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
        createdAt: '2026-03-22T23:58:54Z',
        type: 'item.started',
        raw: null,
        item: {
          itemType: 'user_message',
          status: 'in_progress',
          title: 'You',
          detail: 'Inspect the repo and update report.md.',
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
        createdAt: '2026-03-22T23:58:54Z',
        type: 'item.completed',
        raw: null,
        item: {
          itemType: 'user_message',
          status: 'completed',
          title: 'You',
          detail: 'Inspect the repo and update report.md.',
        },
      },
      {
        sequence: 3,
        eventId: 'e-command-start',
        sessionId: 's1',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'cmd-1',
        requestId: null,
        createdAt: '2026-03-22T23:58:57Z',
        type: 'item.started',
        raw: null,
        item: {
          itemType: 'command_execution',
          status: 'in_progress',
          title: 'Command started',
          detail: 'Get-Content report.md',
        },
      },
      {
        sequence: 4,
        eventId: 'e-command-out',
        sessionId: 's1',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'cmd-1',
        requestId: null,
        createdAt: '2026-03-22T23:58:58Z',
        type: 'content.delta',
        raw: null,
        contentDelta: {
          streamKind: 'command_output',
          delta: 'status: TODO',
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
        createdAt: '2026-03-22T23:58:59Z',
        type: 'item.completed',
        raw: null,
        item: {
          itemType: 'command_execution',
          status: 'completed',
          title: 'Command completed',
          detail: 'Get-Content report.md',
        },
      },
      {
        sequence: 6,
        eventId: 'e-file-start',
        sessionId: 's1',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'file-1',
        requestId: null,
        createdAt: '2026-03-22T23:59:04Z',
        type: 'item.started',
        raw: null,
        item: {
          itemType: 'file_change',
          status: 'in_progress',
          title: 'File change started',
          detail: 'report.md',
        },
      },
      {
        sequence: 7,
        eventId: 'e-file-out',
        sessionId: 's1',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'file-1',
        requestId: null,
        createdAt: '2026-03-22T23:59:05Z',
        type: 'content.delta',
        raw: null,
        contentDelta: {
          streamKind: 'file_change_output',
          delta: 'Success. Updated the following files:\nM report.md',
        },
      },
      {
        sequence: 8,
        eventId: 'e-file-done',
        sessionId: 's1',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'file-1',
        requestId: null,
        createdAt: '2026-03-22T23:59:06Z',
        type: 'item.completed',
        raw: null,
        item: {
          itemType: 'file_change',
          status: 'completed',
          title: 'File change completed',
          detail: 'report.md',
        },
      },
      {
        sequence: 9,
        eventId: 'e-diff',
        sessionId: 's1',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: null,
        requestId: null,
        createdAt: '2026-03-22T23:59:07Z',
        type: 'diff.updated',
        raw: null,
        diffUpdated: {
          unifiedDiff: 'diff --git a/report.md b/report.md\n@@\n-status: TODO\n+status: DONE',
        },
      },
      {
        sequence: 10,
        eventId: 'e-assistant-final',
        sessionId: 's1',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'assistant-1',
        requestId: null,
        createdAt: '2026-03-22T23:59:20Z',
        type: 'content.delta',
        raw: null,
        contentDelta: {
          streamKind: 'assistant_text',
          delta:
            'Plan:\n1. Review the workspace.\n2. Summarize the inventory.\n\n| name | count | owner |\n| --- | ---: | --- |\n| alpha | 3 | Ada |',
        },
      },
    ] as any;

    const history = buildLensHistoryEntries(snapshot, events);
    const userEntry = history.find((entry) => entry.kind === 'user');
    const commandCallEntry = history.find(
      (entry) => entry.kind === 'tool' && entry.body.includes('Get-Content report.md'),
    );
    const commandOutputEntry = history.find(
      (entry) => entry.kind === 'tool' && entry.title === 'Command output',
    );
    const fileChangeEntry = history.find(
      (entry) =>
        entry.kind === 'tool' && entry.body.includes('Success. Updated the following files'),
    );
    const diffEntry = history.find((entry) => entry.kind === 'diff');
    const assistantEntry = history.find((entry) => entry.kind === 'assistant');

    expect(userEntry?.body).toContain('update report.md');
    expect(commandCallEntry?.body).toContain('Get-Content report.md');
    expect(commandOutputEntry?.body).toContain('status: TODO');
    expect(fileChangeEntry?.body).toContain('report.md');
    expect(diffEntry?.body).toContain('+status: DONE');
    expect(assistantEntry?.body).toContain('| alpha | 3 | Ada |');
  });

  it.skip('keeps Codex user rows visible and avoids duplicate assistant rows for camelCase item types', async () => {
    const { buildLensHistoryEntries } = await import('./index');

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

    const history = buildLensHistoryEntries(snapshot, events);
    const userEntries = history.filter((entry) => entry.kind === 'user');
    const assistantEntries = history.filter((entry) => entry.kind === 'assistant');
    const toolEntries = history.filter((entry) => entry.kind === 'tool');

    expect(userEntries).toHaveLength(1);
    expect(userEntries[0]?.body).toContain('Reply with exactly HELLO_FROM_CODEX');
    expect(userEntries[0]?.title).toBe('You');

    expect(assistantEntries).toHaveLength(1);
    expect(assistantEntries[0]?.body).toBe('HELLO_FROM_CODEX');

    expect(toolEntries).toHaveLength(1);
    expect(toolEntries[0]?.title).toContain('pwsh.exe');
    expect(toolEntries[0]?.body).toContain('pwsh.exe');
  });

  it.skip('concatenates assistant stream chunks without paragraph separators or duplicate final text', async () => {
    const { buildLensHistoryEntries } = await import('./index');

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

    const history = buildLensHistoryEntries(snapshot, events);
    const assistantEntries = history.filter((entry) => entry.kind === 'assistant');

    expect(assistantEntries).toHaveLength(1);
    expect(assistantEntries[0]?.body).toBe('HELLO_FROM_CODEX');
  });

  it.skip('keeps separate assistant updates from the same turn in distinct rows when item ids differ', async () => {
    const { buildLensHistoryEntries } = await import('./index');

    const snapshot = {
      sessionId: 's1',
      provider: 'codex',
      generatedAt: '2026-03-24T19:00:00Z',
      latestSequence: 2,
      session: {
        state: 'ready',
        stateLabel: 'Ready',
        reason: null,
        lastError: null,
        lastEventAt: '2026-03-24T19:00:00Z',
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
        startedAt: '2026-03-24T18:59:50Z',
        completedAt: '2026-03-24T19:00:00Z',
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
        eventId: 'assistant-1',
        sessionId: 's1',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'assistant-item-1',
        requestId: null,
        createdAt: '2026-03-24T18:59:55Z',
        type: 'item.completed',
        raw: null,
        item: {
          itemType: 'assistant_message',
          status: 'completed',
          title: 'Assistant message',
          detail: 'Ich pruefe kurz die lokale MidTerm-Anweisung.',
        },
      },
      {
        sequence: 2,
        eventId: 'assistant-2',
        sessionId: 's1',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'assistant-item-2',
        requestId: null,
        createdAt: '2026-03-24T18:59:57Z',
        type: 'item.completed',
        raw: null,
        item: {
          itemType: 'assistant_message',
          status: 'completed',
          title: 'Assistant message',
          detail: 'Die DMI-Kennung ist leer, daher pruefe ich jetzt direkt das ARM-Board-Modell.',
        },
      },
    ] as any;

    const history = buildLensHistoryEntries(snapshot, events);
    const assistantEntries = history.filter((entry) => entry.kind === 'assistant');

    expect(assistantEntries).toHaveLength(2);
    expect(assistantEntries[0]?.body).toBe('Ich pruefe kurz die lokale MidTerm-Anweisung.');
    expect(assistantEntries[1]?.body).toBe(
      'Die DMI-Kennung ist leer, daher pruefe ich jetzt direkt das ARM-Board-Modell.',
    );
  });

  it.skip('keeps the first-seen order for a live assistant row instead of moving it on completion', async () => {
    const { buildLensHistoryEntries } = await import('./index');

    const snapshot = {
      sessionId: 's1',
      provider: 'codex',
      generatedAt: '2026-03-24T19:10:00Z',
      latestSequence: 3,
      session: {
        state: 'ready',
        stateLabel: 'Ready',
        reason: null,
        lastError: null,
        lastEventAt: '2026-03-24T19:10:00Z',
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
        startedAt: '2026-03-24T19:09:50Z',
        completedAt: '2026-03-24T19:10:00Z',
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
        eventId: 'assistant-delta',
        sessionId: 's1',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'assistant-1',
        requestId: null,
        createdAt: '2026-03-24T19:09:55Z',
        type: 'content.delta',
        raw: null,
        contentDelta: {
          streamKind: 'assistant_text',
          delta: 'Working',
        },
      },
      {
        sequence: 2,
        eventId: 'tool-completed',
        sessionId: 's1',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'tool-1',
        requestId: null,
        createdAt: '2026-03-24T19:09:56Z',
        type: 'item.completed',
        raw: null,
        item: {
          itemType: 'command_execution',
          status: 'completed',
          title: 'Command completed',
          detail: 'git status',
        },
      },
      {
        sequence: 3,
        eventId: 'assistant-completed',
        sessionId: 's1',
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'assistant-1',
        requestId: null,
        createdAt: '2026-03-24T19:09:59Z',
        type: 'item.completed',
        raw: null,
        item: {
          itemType: 'assistant_message',
          status: 'completed',
          title: 'Assistant message',
          detail: 'Working response.',
        },
      },
    ] as any;

    const history = buildLensHistoryEntries(snapshot, events);

    expect(history[0]).toMatchObject({
      kind: 'assistant',
      body: 'Working response.',
    });
    expect(history[1]).toMatchObject({
      kind: 'tool',
      title: 'git status',
    });
  });

  it.skip('prefers the final Codex assistant message when it supersedes streamed chunks', async () => {
    const { buildLensHistoryEntries } = await import('./index');

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

    const history = buildLensHistoryEntries(snapshot, events);
    const assistantEntries = history.filter((entry) => entry.kind === 'assistant');

    expect(assistantEntries).toHaveLength(1);
    expect(assistantEntries[0]?.body).toBe('The answer is 42.');
  });

  it.skip('keeps one user row when Codex emits repeated started/completed message payloads', async () => {
    const { buildLensHistoryEntries } = await import('./index');

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
          detail: 'Explain the recent Lens history bug.',
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
          detail: 'Explain the recent Lens history bug.',
        },
      },
    ] as any;

    const history = buildLensHistoryEntries(snapshot, events);
    const userEntries = history.filter((entry) => entry.kind === 'user');

    expect(userEntries).toHaveLength(1);
    expect(userEntries[0]?.body).toBe('Explain the recent Lens history bug.');
  });

  it.skip('merges a local submitted user row with the later provider user item for the same turn', async () => {
    const { buildLensHistoryEntries } = await import('./index');

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

    const history = buildLensHistoryEntries(snapshot, events);
    const userEntries = history.filter((entry) => entry.kind === 'user');

    expect(userEntries).toHaveLength(1);
    expect(userEntries[0]?.body).toBe('Please inspect this image.');
    expect(userEntries[0]?.attachments).toHaveLength(1);
    expect(userEntries[0]?.attachments?.[0]?.displayName).toBe('screen.png');
  });

  it.skip('keeps attachment-only user rows visible in the history', async () => {
    const { buildLensHistoryEntries } = await import('./index');

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

    const history = buildLensHistoryEntries(snapshot, events);
    const userEntries = history.filter((entry) => entry.kind === 'user');

    expect(userEntries).toHaveLength(1);
    expect(userEntries[0]?.body).toBe('');
    expect(userEntries[0]?.attachments).toHaveLength(1);
  });

  it.skip('keeps user text from item title and still falls back to snapshot assistant text', async () => {
    const { buildLensHistoryEntries } = await import('./index');

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

    const history = buildLensHistoryEntries(snapshot, events);

    expect(history.find((entry) => entry.kind === 'user')?.body).toContain(
      'Please summarize the failing test run.',
    );
    expect(
      history.find(
        (entry) => entry.kind === 'assistant' && entry.body.includes('Final answer from snapshot'),
      ),
    ).toBeTruthy();
  });

  it.skip('hides completed-status noise in normal chat row metadata', async () => {
    const { buildLensHistoryEntries, formatHistoryMeta, shouldHideStatusInMeta } =
      await import('./index');

    expect(shouldHideStatusInMeta('user', 'Completed')).toBe(true);
    expect(shouldHideStatusInMeta('assistant', 'Assistant Text')).toBe(true);
    expect(shouldHideStatusInMeta('request', 'Completed')).toBe(false);
    expect(formatHistoryMeta('user', 'Completed', '2026-03-21T15:09:20Z')).not.toContain(
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

    const history = buildLensHistoryEntries(snapshot, events);
    const userEntry = history.find((entry) => entry.kind === 'user');
    const assistantEntry = history.find((entry) => entry.kind === 'assistant');

    expect(userEntry?.meta).not.toContain('Completed');
    expect(assistantEntry?.meta).not.toContain('Completed');
    expect(userEntry?.meta).toMatch(/\d{2}:\d{2}/);
    expect(assistantEntry?.meta).toMatch(/\d{2}:\d{2}/);
  });

  it('virtualizes older history rows but keeps a visible window', async () => {
    const { computeHistoryVirtualWindow } = await import('./index');

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

    const windowed = computeHistoryVirtualWindow(entries, 1800, 900);

    expect(windowed.start).toBeGreaterThan(0);
    expect(windowed.end).toBeLessThan(entries.length);
    expect(windowed.topSpacerPx).toBeGreaterThan(0);
    expect(windowed.bottomSpacerPx).toBeGreaterThan(0);
  });

  it('keeps history virtualization active on compact mobile widths too', async () => {
    const { computeHistoryVirtualWindow } = await import('./index');

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

    const windowed = computeHistoryVirtualWindow(entries, 1800, 900, 375);

    expect(windowed.start).toBeGreaterThan(0);
    expect(windowed.end).toBeLessThan(entries.length);
    expect(windowed.topSpacerPx).toBeGreaterThan(0);
    expect(windowed.bottomSpacerPx).toBeGreaterThan(0);
  });

  it('estimates taller history rows for narrow viewports', async () => {
    const { estimateHistoryEntryHeight } = await import('./index');

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

    const desktopEstimate = estimateHistoryEntryHeight(entry, 960);
    const mobileEstimate = estimateHistoryEntryHeight(entry, 420);

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

  it('collapses long tool-style history bodies by default while keeping them monospace', async () => {
    const { resolveHistoryBodyPresentation } = await import('./index');

    const presentation = resolveHistoryBodyPresentation({
      id: 'tool-1',
      order: 1,
      kind: 'tool',
      tone: 'info',
      label: 'Tool',
      title: 'git diff --stat',
      body: Array.from({ length: 10 }, (_, index) => `line ${index + 1}: tool output`).join('\n'),
      meta: 'Completed • 11:00:01',
    });

    expect(presentation.mode).toBe('monospace');
    expect(presentation.collapsedByDefault).toBe(true);
    expect(presentation.lineCount).toBe(10);
    expect(presentation.preview).toBe('line 1: tool output');
  });

  it('applies canonical live deltas directly into the materialized history window', async () => {
    const { applyCanonicalLensDelta } = await import('./index');

    const snapshot = {
      sessionId: 's1',
      provider: 'codex',
      generatedAt: '2026-03-28T10:00:00Z',
      latestSequence: 1,
      totalHistoryCount: 1,
      historyWindowStart: 0,
      historyWindowEnd: 1,
      hasOlderHistory: false,
      hasNewerHistory: false,
      session: {
        state: 'running',
        stateLabel: 'Running',
        reason: null,
        lastError: null,
        lastEventAt: '2026-03-28T10:00:00Z',
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
        model: 'gpt-5.4',
        effort: 'high',
        startedAt: '2026-03-28T10:00:00Z',
        completedAt: null,
      },
      streams: {
        assistantText: 'Hel',
        reasoningText: '',
        reasoningSummaryText: '',
        planText: '',
        commandOutput: '',
        fileChangeOutput: '',
        unifiedDiff: '',
      },
      transcript: [
        {
          entryId: 'assistant:assistant-1',
          order: 1,
          kind: 'assistant',
          turnId: 'turn-1',
          itemId: 'assistant-1',
          requestId: null,
          status: 'streaming',
          itemType: 'assistant_text',
          title: null,
          body: 'Hel',
          attachments: [],
          streaming: true,
          createdAt: '2026-03-28T10:00:00Z',
          updatedAt: '2026-03-28T10:00:00Z',
        },
      ],
      items: [],
      requests: [],
      notices: [],
    } as any;

    const state = {
      snapshot,
      historyWindowStart: 0,
      historyWindowCount: 80,
    } as any;

    applyCanonicalLensDelta(state, {
      sessionId: 's1',
      provider: 'codex',
      generatedAt: '2026-03-28T10:00:01Z',
      latestSequence: 2,
      totalHistoryCount: 1,
      session: {
        state: 'running',
        stateLabel: 'Running',
        reason: 'Codex turn started.',
        lastError: null,
        lastEventAt: '2026-03-28T10:00:01Z',
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
        model: 'gpt-5.4',
        effort: 'high',
        startedAt: '2026-03-28T10:00:00Z',
        completedAt: null,
      },
      streams: {
        assistantText: 'Hello',
        reasoningText: '',
        reasoningSummaryText: '',
        planText: '',
        commandOutput: '',
        fileChangeOutput: '',
        unifiedDiff: '',
      },
      historyUpserts: [
        {
          entryId: 'assistant:assistant-1',
          order: 1,
          kind: 'assistant',
          turnId: 'turn-1',
          itemId: 'assistant-1',
          requestId: null,
          status: 'streaming',
          itemType: 'assistant_text',
          title: null,
          body: 'Hello',
          attachments: [],
          streaming: true,
          createdAt: '2026-03-28T10:00:00Z',
          updatedAt: '2026-03-28T10:00:01Z',
        },
      ],
      historyRemovals: [],
      itemUpserts: [],
      itemRemovals: [],
      requestUpserts: [],
      requestRemovals: [],
      noticeUpserts: [],
    });

    expect(snapshot.latestSequence).toBe(2);
    expect(snapshot.generatedAt).toBe('2026-03-28T10:00:01Z');
    expect(snapshot.streams.assistantText).toBe('Hello');
    expect(snapshot.transcript).toHaveLength(1);
    expect(snapshot.transcript[0]?.body).toBe('Hello');
    expect(snapshot.transcript[0]?.streaming).toBe(true);
    expect(snapshot.historyWindowStart).toBe(0);
    expect(snapshot.historyWindowEnd).toBe(1);
    expect(snapshot.hasNewerHistory).toBe(false);
  });
});
