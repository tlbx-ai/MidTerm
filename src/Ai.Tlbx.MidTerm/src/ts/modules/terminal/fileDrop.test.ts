import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendSessionPrompt = vi.fn();
const pasteToTerminal = vi.fn();
const isLensActiveSession = vi.fn<(sessionId: string | null | undefined) => boolean>();

class FakeFileReader {
  public result: string | ArrayBuffer | null = null;
  public error: Error | null = null;
  public onload: (() => void) | null = null;
  public onerror: (() => void) | null = null;

  public readAsText(file: Blob): void {
    void file
      .text()
      .then((text) => {
        this.result = text;
        this.onload?.();
      })
      .catch((error: unknown) => {
        this.error = error instanceof Error ? error : new Error(String(error));
        this.onerror?.();
      });
  }
}

vi.mock('../../stores', () => ({
  $activeSessionId: {
    get: () => 's1',
  },
}));

vi.mock('../../api/client', () => ({
  sendSessionPrompt,
}));

vi.mock('../lens/input', () => ({
  isLensActiveSession,
  createLensPromptRequest: (text: string) => ({
    text,
    mode: 'auto',
    interruptFirst: false,
    interruptKeys: ['C-c'],
    literalInterruptKeys: false,
    interruptDelayMs: 150,
    submitKeys: ['Enter'],
    literalSubmitKeys: false,
    submitDelayMs: 300,
    followupSubmitCount: 0,
    followupSubmitDelayMs: 250,
  }),
}));

vi.mock('./manager', () => ({
  pasteToTerminal,
}));

vi.mock('../sidebar/sessionDrag', () => ({
  isSessionDragActive: () => false,
}));

vi.mock('../i18n', () => ({
  t: (key: string) => key,
}));

vi.mock('../logging', () => ({
  createLogger: () => ({
    error: vi.fn(),
  }),
}));

describe('fileDrop', () => {
  beforeEach(() => {
    sendSessionPrompt.mockReset();
    pasteToTerminal.mockReset();
    isLensActiveSession.mockReset();
    isLensActiveSession.mockReturnValue(false);
    vi.stubGlobal('HTMLElement', class HTMLElement {});
    vi.stubGlobal('FileReader', FakeFileReader as unknown as typeof FileReader);
    vi.stubGlobal(
      'document',
      {
        getElementById: () => null,
        querySelector: () => null,
        body: {
          appendChild: vi.fn(),
        },
      } as unknown as Document,
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ path: 'Q:/repo/uploads/pic.png' }),
      })),
    );
  });

  it('routes Smart Input attachments through the prompt API while Lens is active', async () => {
    isLensActiveSession.mockReturnValue(true);
    const { handleFileDrop } = await import('./fileDrop');

    const files = [
      new File(['hello from note'], 'note.txt', { type: 'text/plain' }),
      new File(['png'], 'pic.png', { type: 'image/png' }),
    ] as unknown as FileList;

    await handleFileDrop(files);

    expect(sendSessionPrompt).toHaveBeenCalledTimes(1);
    expect(sendSessionPrompt).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        text: expect.stringContaining('Attached file:\n- Q:/repo/uploads/pic.png'),
      }),
    );
    expect(sendSessionPrompt).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        text: expect.stringContaining('File "note.txt":\nhello from note'),
      }),
    );
    expect(pasteToTerminal).not.toHaveBeenCalled();
  });

  it('keeps terminal paste behavior when Lens is not active', async () => {
    const { handleFileDrop } = await import('./fileDrop');

    const files = [
      new File(['plain text'], 'note.txt', { type: 'text/plain' }),
      new File(['png'], 'pic.png', { type: 'image/png' }),
    ] as unknown as FileList;

    await handleFileDrop(files);

    expect(sendSessionPrompt).not.toHaveBeenCalled();
    expect(pasteToTerminal).toHaveBeenNthCalledWith(1, 's1', 'plain text', false);
    expect(pasteToTerminal).toHaveBeenNthCalledWith(2, 's1', 'Q:/repo/uploads/pic.png', true);
  });
});
