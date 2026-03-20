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
        className: '',
        textContent: '',
        appendChild: vi.fn(),
        replaceChildren: vi.fn(),
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
          hidden: false,
          disabled: false,
          textContent: '',
          value: '',
          className: '',
          innerHTML: '',
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

});
