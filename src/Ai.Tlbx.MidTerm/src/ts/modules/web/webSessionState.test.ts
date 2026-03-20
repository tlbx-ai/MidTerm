import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { $activeSessionId } from '../../stores';
import {
  getSessionDockedClient,
  removeSessionState,
  setSessionDockedClient,
  upsertSessionPreview,
} from './webSessionState';

describe('webSessionState docked preview identity', () => {
  const sessionId = 'session-a';
  const previewName = 'default';

  beforeEach(() => {
    $activeSessionId.set(sessionId);
    removeSessionState(sessionId);
  });

  afterEach(() => {
    removeSessionState(sessionId);
    $activeSessionId.set(null);
  });

  it('keeps the docked preview client when target revision is unchanged', () => {
    upsertSessionPreview({
      sessionId,
      previewName,
      routeKey: 'route-1',
      url: 'https://example.com/',
      active: true,
      targetRevision: 1,
    });

    setSessionDockedClient(sessionId, previewName, {
      sessionId,
      previewName,
      routeKey: 'route-1',
      previewId: 'preview-1',
      previewToken: 'token-1',
    });

    upsertSessionPreview({
      sessionId,
      previewName,
      routeKey: 'route-1',
      url: 'https://example.com/',
      active: true,
      targetRevision: 1,
    });

    expect(getSessionDockedClient(sessionId, previewName)?.previewId).toBe('preview-1');
  });

  it('invalidates the docked preview client when target revision changes', () => {
    upsertSessionPreview({
      sessionId,
      previewName,
      routeKey: 'route-1',
      url: 'https://example.org/',
      active: true,
      targetRevision: 1,
    });

    setSessionDockedClient(sessionId, previewName, {
      sessionId,
      previewName,
      routeKey: 'route-1',
      previewId: 'preview-1',
      previewToken: 'token-1',
    });

    upsertSessionPreview({
      sessionId,
      previewName,
      routeKey: 'route-1',
      url: 'https://example.com/',
      active: true,
      targetRevision: 2,
    });

    expect(getSessionDockedClient(sessionId, previewName)).toBeNull();
  });
});
