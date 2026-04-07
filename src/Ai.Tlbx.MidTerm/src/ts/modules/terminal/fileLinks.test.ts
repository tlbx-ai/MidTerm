import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sessionTerminals } from '../../state';
import { $currentSettings } from '../../stores';
import { clearPathAllowlist, scanOutputForPaths } from './fileLinks';

const mocks = vi.hoisted(() => ({
  registerFilePaths: vi.fn(async () => undefined),
}));

vi.mock('../../api/client', () => ({
  registerFilePaths: mocks.registerFilePaths,
}));

vi.mock('../fileViewer', () => ({
  openFile: vi.fn(),
}));

describe('fileLinks hot-path throttling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', globalThis);
    sessionTerminals.clear();
    $currentSettings.set({ fileRadar: true } as never);
    mocks.registerFilePaths.mockClear();
  });

  afterEach(() => {
    clearPathAllowlist('sess1');
    sessionTerminals.clear();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('skips scan registration while synchronized output mode is active', async () => {
    sessionTerminals.set('sess1', {
      terminal: {
        modes: { synchronizedOutputMode: true },
      },
    } as never);

    scanOutputForPaths('sess1', new TextEncoder().encode('Q:\\repos\\MidTermWorkspace3\\src\\main.ts'));
    await vi.runAllTimersAsync();

    expect(mocks.registerFilePaths).not.toHaveBeenCalled();
  });

  it('registers only newly discovered absolute paths', async () => {
    sessionTerminals.set('sess1', {
      terminal: {
        modes: { synchronizedOutputMode: false },
      },
    } as never);

    const payload = new TextEncoder().encode('Q:\\repos\\MidTermWorkspace3\\src\\main.ts');

    scanOutputForPaths('sess1', payload);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    scanOutputForPaths('sess1', payload);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(mocks.registerFilePaths).toHaveBeenCalledTimes(1);
    expect(mocks.registerFilePaths).toHaveBeenCalledWith('sess1', [
      'Q:\\repos\\MidTermWorkspace3\\src\\main.ts',
    ]);
  });
});
