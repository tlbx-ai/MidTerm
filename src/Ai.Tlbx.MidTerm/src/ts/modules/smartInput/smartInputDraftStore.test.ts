import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('smartInputDraftStore', () => {
  const localStorageData = new Map<string, string>();

  beforeEach(() => {
    localStorageData.clear();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => localStorageData.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        localStorageData.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        localStorageData.delete(key);
      }),
      clear: vi.fn(() => {
        localStorageData.clear();
      }),
    });
  });

  it('persists uploaded Lens draft attachments per session and restores them after reload', async () => {
    const {
      loadLensDraftAttachmentsForSession,
      setLensDraftAttachmentsForSession,
    } = await import('./smartInputDraftStore');

    const drafts = new Map();
    setLensDraftAttachmentsForSession(drafts, 's1', [
      {
        id: 'a1',
        kind: 'image',
        file: null,
        uploadedPath: 'Q:/repo/.midterm/uploads/screen.png',
        displayName: 'screen.png',
        mimeType: 'image/png',
        sizeBytes: 3,
        previewUrl:
          '/api/files/view?path=Q%3A%2Frepo%2F.midterm%2Fuploads%2Fscreen.png&sessionId=s1',
      },
    ]);

    expect(loadLensDraftAttachmentsForSession('s1')).toEqual([
      {
        id: 'a1',
        kind: 'image',
        file: null,
        uploadedPath: 'Q:/repo/.midterm/uploads/screen.png',
        displayName: 'screen.png',
        mimeType: 'image/png',
        sizeBytes: 3,
        previewUrl:
          '/api/files/view?path=Q%3A%2Frepo%2F.midterm%2Fuploads%2Fscreen.png&sessionId=s1',
      },
    ]);
  });

  it('clears persisted Lens draft attachments when the session draft is removed', async () => {
    const {
      clearLensDraftAttachmentsForSession,
      loadLensDraftAttachmentsForSession,
      setLensDraftAttachmentsForSession,
    } = await import('./smartInputDraftStore');

    const drafts = new Map();
    setLensDraftAttachmentsForSession(drafts, 's1', [
      {
        id: 'a1',
        kind: 'image',
        file: null,
        uploadedPath: 'Q:/repo/.midterm/uploads/screen.png',
        displayName: 'screen.png',
        mimeType: 'image/png',
        sizeBytes: 3,
        previewUrl:
          '/api/files/view?path=Q%3A%2Frepo%2F.midterm%2Fuploads%2Fscreen.png&sessionId=s1',
      },
    ]);

    clearLensDraftAttachmentsForSession(drafts, 's1', false);

    expect(loadLensDraftAttachmentsForSession('s1')).toEqual([]);
  });
});
