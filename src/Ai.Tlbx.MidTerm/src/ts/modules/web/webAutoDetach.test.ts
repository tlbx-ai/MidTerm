import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  detachPreview: vi.fn().mockResolvedValue(undefined),
  isDetachedOpenForSession: vi.fn(() => false),
  getSessionPreview: vi.fn(() => null),
  getSessionSelectedPreviewName: vi.fn(() => 'default'),
}));

vi.mock('./webDetach', () => ({
  detachPreview: mocks.detachPreview,
  isDetachedOpenForSession: mocks.isDetachedOpenForSession,
}));

vi.mock('./webSessionState', () => ({
  getSessionPreview: mocks.getSessionPreview,
  getSessionSelectedPreviewName: mocks.getSessionSelectedPreviewName,
}));

describe('autoDetachPreviewOnSessionSwitch', () => {
  beforeEach(() => {
    mocks.detachPreview.mockClear();
    mocks.isDetachedOpenForSession.mockReset();
    mocks.isDetachedOpenForSession.mockReturnValue(false);
    mocks.getSessionPreview.mockReset();
    mocks.getSessionPreview.mockReturnValue(null);
    mocks.getSessionSelectedPreviewName.mockReset();
    mocks.getSessionSelectedPreviewName.mockReturnValue('default');
  });

  it('detaches the previous session preview when switching away from a live docked preview', async () => {
    mocks.getSessionPreview.mockReturnValue({
      mode: 'docked',
      url: 'https://example.com/',
    });

    const { autoDetachPreviewOnSessionSwitch } = await import('./webAutoDetach');

    await autoDetachPreviewOnSessionSwitch('session-a', 'session-b');

    expect(mocks.detachPreview).toHaveBeenCalledWith('session-a', 'default', {
      suppressFocus: true,
    });
  });

  it('does not detach when the previous preview is already detached', async () => {
    mocks.getSessionPreview.mockReturnValue({
      mode: 'docked',
      url: 'https://example.com/',
    });
    mocks.isDetachedOpenForSession.mockReturnValue(true);

    const { autoDetachPreviewOnSessionSwitch } = await import('./webAutoDetach');

    await autoDetachPreviewOnSessionSwitch('session-a', 'session-b');

    expect(mocks.detachPreview).not.toHaveBeenCalled();
  });

  it('does not detach when the previous preview is not a live docked preview', async () => {
    mocks.getSessionPreview.mockReturnValue({
      mode: 'hidden',
      url: 'https://example.com/',
    });

    const { autoDetachPreviewOnSessionSwitch } = await import('./webAutoDetach');

    await autoDetachPreviewOnSessionSwitch('session-a', 'session-b');

    expect(mocks.detachPreview).not.toHaveBeenCalled();
  });
});
