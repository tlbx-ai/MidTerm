import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const originalLocalStorage = globalThis.localStorage;
const originalDocument = globalThis.document;
const originalWindow = globalThis.window;

vi.mock('../logging', () => ({
  createLogger: () => ({
    info: vi.fn(),
  }),
}));

vi.mock('../i18n', () => ({
  t: (key: string) => key,
}));

function createLocalStorage(getItem: (key: string) => string | null) {
  return {
    getItem: vi.fn(getItem),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  };
}

function createClassList() {
  const classes = new Set<string>();
  return {
    add: vi.fn((value: string) => {
      classes.add(value);
    }),
    toggle: vi.fn((value: string) => {
      if (classes.has(value)) {
        classes.delete(value);
        return false;
      }
      classes.add(value);
      return true;
    }),
    contains: (value: string) => classes.has(value),
  };
}

function createButton() {
  return {
    addEventListener: vi.fn(),
  };
}

function createDocument(elements: Record<string, unknown>) {
  return {
    getElementById: vi.fn((id: string) => elements[id] ?? null),
  };
}

describe('sidebar section default collapse', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    Object.assign(globalThis, {
      document: originalDocument,
      localStorage: originalLocalStorage,
      window: originalWindow,
    });
  });

  it('collapses the voice section by default for first-time users', async () => {
    vi.stubGlobal('localStorage', createLocalStorage(() => null));
    const section = { classList: createClassList() };
    const toggleBtn = createButton();
    vi.stubGlobal(
      'document',
      createDocument({
        'voice-section': section,
        'btn-toggle-voice': toggleBtn,
      }),
    );

    const { initVoiceSection } = await import('./voiceSection');

    initVoiceSection();

    expect(section.classList.contains('collapsed')).toBe(true);
  });

  it('keeps the voice section expanded when the saved preference is expanded', async () => {
    vi.stubGlobal('localStorage', createLocalStorage(() => 'false'));
    const section = { classList: createClassList() };
    const toggleBtn = createButton();
    vi.stubGlobal(
      'document',
      createDocument({
        'voice-section': section,
        'btn-toggle-voice': toggleBtn,
      }),
    );

    const { initVoiceSection } = await import('./voiceSection');

    initVoiceSection();

    expect(section.classList.contains('collapsed')).toBe(false);
  });

  it('collapses the network section by default for first-time users', async () => {
    vi.stubGlobal('localStorage', createLocalStorage(() => null));
    vi.stubGlobal('window', { isSecureContext: true });
    const section = { classList: createClassList() };
    const toggleBtn = createButton();
    vi.stubGlobal(
      'document',
      createDocument({
        'network-section': section,
        'btn-toggle-network': toggleBtn,
      }),
    );

    const { initNetworkSection } = await import('./networkSection');

    initNetworkSection();

    expect(section.classList.contains('collapsed')).toBe(true);
  });

  it('keeps the network section expanded when the saved preference is expanded', async () => {
    vi.stubGlobal('localStorage', createLocalStorage(() => 'false'));
    vi.stubGlobal('window', { isSecureContext: true });
    const section = { classList: createClassList() };
    const toggleBtn = createButton();
    vi.stubGlobal(
      'document',
      createDocument({
        'network-section': section,
        'btn-toggle-network': toggleBtn,
      }),
    );

    const { initNetworkSection } = await import('./networkSection');

    initNetworkSection();

    expect(section.classList.contains('collapsed')).toBe(false);
  });
});
