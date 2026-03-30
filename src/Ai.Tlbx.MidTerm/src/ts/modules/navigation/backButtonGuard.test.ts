import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

async function loadModule() {
  vi.resetModules();
  return import('./backButtonGuard');
}

function createWindowHarness() {
  const target = new EventTarget() as EventTarget & {
    history: {
      state: Record<string, unknown> | null;
      replaceState: (state: Record<string, unknown> | null) => void;
      pushState: (state: Record<string, unknown> | null) => void;
    };
    location: {
      href: string;
    };
    setTimeout: typeof setTimeout;
  };

  target.history = {
    state: null,
    replaceState(state: Record<string, unknown> | null) {
      this.state = state;
    },
    pushState(state: Record<string, unknown> | null) {
      this.state = state;
    },
  };
  target.location = {
    href: 'http://midterm.test/',
  };
  target.setTimeout = setTimeout;

  return target;
}

describe('backButtonGuard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', createWindowHarness());
    vi.stubGlobal('document', {
      title: 'MidTerm',
    });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps a synthetic guard entry active after a back press', async () => {
    const { initBackButtonGuard } = await loadModule();

    initBackButtonGuard();
    expect(window.history.state?.__midtermBackGuard).toBe('guard');

    window.dispatchEvent(new Event('popstate'));
    vi.runAllTimers();

    expect(window.history.state?.__midtermBackGuard).toBe('guard');
  });

  it('closes the top registered layer before restoring the guard entry', async () => {
    const { initBackButtonGuard, registerBackButtonLayer } = await loadModule();
    const closeTop = vi.fn();
    const closeBottom = vi.fn();

    initBackButtonGuard();
    registerBackButtonLayer(closeBottom);
    registerBackButtonLayer(closeTop);

    window.dispatchEvent(new Event('popstate'));
    vi.runAllTimers();

    expect(closeTop).toHaveBeenCalledTimes(1);
    expect(closeBottom).not.toHaveBeenCalled();
    expect(window.history.state?.__midtermBackGuard).toBe('guard');
  });
});
