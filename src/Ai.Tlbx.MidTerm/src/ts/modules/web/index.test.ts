import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../sessionTabs', () => ({
  setWebClickHandler: vi.fn(),
}));

vi.mock('./webDock', () => ({
  toggleWebPreviewDock: vi.fn(),
  closeWebPreviewDock: vi.fn(),
  setupWebPreviewDockResize: vi.fn(),
  openWebPreviewDock: vi.fn(),
  applyWebPreviewHiddenState: vi.fn(),
  hideWebPreviewDockForDetach: vi.fn(),
  initViewportReset: vi.fn(),
}));

vi.mock('./webPanel', () => ({
  initWebPanel: vi.fn(),
  loadPreview: vi.fn().mockResolvedValue(undefined),
  renderPreviewTabs: vi.fn(),
  restoreLastUrl: vi.fn(),
  setPreviewTabSelectHandler: vi.fn(),
}));

vi.mock('./webDetach', () => ({
  closeDetachedIfOwnedBy: vi.fn(),
  dockBack: vi.fn(),
  initDetach: vi.fn(),
  isDetachedOpenForSession: vi.fn().mockReturnValue(false),
}));

vi.mock('./webApi', () => ({
  listWebPreviewSessions: vi.fn(),
}));

import { $activeSessionId } from '../../stores';
import { syncActiveWebPreview } from './index';
import { getSessionDockedClient, getSessionPreview, removeSessionState, setSessionDockedClient, upsertSessionPreview } from './webSessionState';
import { listWebPreviewSessions } from './webApi';

describe('syncActiveWebPreview', () => {
  const sessionId = 'session-a';
  const previewName = 'default';
  const mockedListWebPreviewSessions = vi.mocked(listWebPreviewSessions);

  beforeEach(() => {
    removeSessionState(sessionId);
    $activeSessionId.set(sessionId);
  });

  afterEach(() => {
    mockedListWebPreviewSessions.mockReset();
    removeSessionState(sessionId);
    $activeSessionId.set(null);
  });

  it('preserves existing preview state when the preview list fetch fails', async () => {
    upsertSessionPreview({
      sessionId,
      previewName,
      routeKey: 'route-1',
      url: 'https://example.com/',
      active: true,
      targetRevision: 3,
    });
    setSessionDockedClient(sessionId, previewName, {
      sessionId,
      previewName,
      routeKey: 'route-1',
      previewId: 'preview-1',
      previewToken: 'token-1',
    });
    mockedListWebPreviewSessions.mockResolvedValue(null);

    await syncActiveWebPreview();

    const preview = getSessionPreview(sessionId, previewName);
    expect(preview?.routeKey).toBe('route-1');
    expect(preview?.url).toBe('https://example.com/');
    expect(preview?.targetRevision).toBe(3);
    expect(getSessionDockedClient(sessionId, previewName)?.previewId).toBe('preview-1');
  });
});
