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
  destroyPreviewFrame: vi.fn(),
  loadPreview: vi.fn().mockResolvedValue(undefined),
  renderPreviewTabs: vi.fn(),
  restoreLastUrl: vi.fn(),
  setPreviewTabCloseHandler: vi.fn(),
  setPreviewTabSelectHandler: vi.fn(),
}));

vi.mock('./webDetach', () => ({
  closeDetachedPreview: vi.fn(),
  closeDetachedIfOwnedBy: vi.fn(),
  dockBack: vi.fn(),
  initDetach: vi.fn(),
  isDetachedOpenForSession: vi.fn().mockReturnValue(false),
}));

vi.mock('./webApi', () => ({
  deleteWebPreviewSession: vi.fn(),
  listWebPreviewSessions: vi.fn(),
}));

import { $activeSessionId } from '../../stores';
import { closeActivePreview, syncActiveWebPreview } from './index';
import { deleteWebPreviewSession, listWebPreviewSessions } from './webApi';
import { closeDetachedPreview } from './webDetach';
import { destroyPreviewFrame } from './webPanel';
import {
  getSessionDockedClient,
  getSessionPreview,
  getSessionSelectedPreviewName,
  removeSessionState,
  setSessionDockedClient,
  setSessionSelectedPreviewName,
  upsertSessionPreview,
} from './webSessionState';

describe('syncActiveWebPreview', () => {
  const sessionId = 'session-a';
  const previewName = 'default';
  const extraPreviewName = 'docs';
  const mockedListWebPreviewSessions = vi.mocked(listWebPreviewSessions);
  const mockedDeleteWebPreviewSession = vi.mocked(deleteWebPreviewSession);
  const mockedCloseDetachedPreview = vi.mocked(closeDetachedPreview);
  const mockedDestroyPreviewFrame = vi.mocked(destroyPreviewFrame);

  beforeEach(() => {
    removeSessionState(sessionId);
    $activeSessionId.set(sessionId);
  });

  afterEach(() => {
    mockedListWebPreviewSessions.mockReset();
    mockedDeleteWebPreviewSession.mockReset();
    mockedCloseDetachedPreview.mockReset();
    mockedDestroyPreviewFrame.mockReset();
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

  it('deletes a named preview tab and falls back to the default selection', async () => {
    upsertSessionPreview({
      sessionId,
      previewName,
      routeKey: 'route-1',
      url: 'https://example.com/',
      active: true,
      targetRevision: 1,
    });
    upsertSessionPreview({
      sessionId,
      previewName: extraPreviewName,
      routeKey: 'route-2',
      url: 'https://example.org/docs',
      active: true,
      targetRevision: 1,
    });
    setSessionSelectedPreviewName(sessionId, extraPreviewName);
    mockedDeleteWebPreviewSession.mockResolvedValue(true);
    mockedListWebPreviewSessions.mockResolvedValue([
      {
        sessionId,
        previewName,
        routeKey: 'route-1',
        url: 'https://example.com/',
        active: true,
        targetRevision: 1,
      },
    ]);

    await closeActivePreview(extraPreviewName);

    expect(mockedDeleteWebPreviewSession).toHaveBeenCalledWith(sessionId, extraPreviewName);
    expect(mockedCloseDetachedPreview).toHaveBeenCalledWith(sessionId, extraPreviewName);
    expect(mockedDestroyPreviewFrame).toHaveBeenCalledWith(sessionId, extraPreviewName);
    expect(getSessionPreview(sessionId, extraPreviewName)).toBeNull();
    expect(getSessionSelectedPreviewName(sessionId)).toBe(previewName);
  });
});
