import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

declare global {
  interface Window {
    initAudioWithUserInteraction?: () => Promise<boolean>;
    startRecording?: (
      callback: (base64Audio: string) => void,
      intervalMs?: number,
      deviceId?: string | null,
      targetSampleRate?: number,
    ) => Promise<boolean>;
    stopRecording?: () => Promise<void>;
  }
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve));
}

describe('transcription push-to-talk lifecycle', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('window', {});
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('cancels startup cleanly when the user releases before audio init completes', async () => {
    let resolveInit: ((value: boolean) => void) | null = null;
    window.initAudioWithUserInteraction = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveInit = resolve;
        }),
    );
    window.startRecording = vi.fn(async () => true);
    window.stopRecording = vi.fn(async () => {});

    const { startHistoryion, stopHistoryion } = await import('./transcription');

    startHistoryion(
      () => {},
      () => {},
    );
    await stopHistoryion();

    resolveInit?.(true);
    await flushMicrotasks();

    expect(window.startRecording).not.toHaveBeenCalled();
    expect(window.stopRecording).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('stops a late recording startup instead of leaving capture running after release', async () => {
    let resolveStart: ((value: boolean) => void) | null = null;
    window.initAudioWithUserInteraction = vi.fn(async () => true);
    window.startRecording = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveStart = resolve;
        }),
    );
    window.stopRecording = vi.fn(async () => {});

    const { startHistoryion, stopHistoryion } = await import('./transcription');

    startHistoryion(
      () => {},
      () => {},
    );
    await flushMicrotasks();
    await stopHistoryion();

    resolveStart?.(true);
    await flushMicrotasks();

    expect(window.startRecording).toHaveBeenCalledTimes(1);
    expect(window.stopRecording).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });
});
