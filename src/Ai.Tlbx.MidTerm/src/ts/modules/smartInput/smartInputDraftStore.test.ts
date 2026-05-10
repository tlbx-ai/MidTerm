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

  it('persists uploaded AppServerControl draft attachments per session and restores them after reload', async () => {
    const {
      loadAppServerControlDraftAttachmentsForSession,
      setAppServerControlDraftAttachmentsForSession,
    } = await import('./smartInputDraftStore');

    const drafts = new Map();
    setAppServerControlDraftAttachmentsForSession(drafts, 's1', [
      {
        id: 'a1',
        kind: 'image',
        file: null,
        uploadedPath: 'Q:/repo/.midterm/uploads/screen.png',
        displayName: 'screen.png',
        mimeType: 'image/png',
        referenceCharCount: null,
        referenceKind: 'image',
        referenceLabel: 'Image 1',
        referenceLineCount: null,
        referenceOrdinal: 1,
        sizeBytes: 3,
        previewUrl:
          '/api/files/view?path=Q%3A%2Frepo%2F.midterm%2Fuploads%2Fscreen.png&sessionId=s1',
      },
    ]);

    expect(loadAppServerControlDraftAttachmentsForSession('s1')).toEqual([
      {
        id: 'a1',
        kind: 'image',
        file: null,
        uploadedPath: 'Q:/repo/.midterm/uploads/screen.png',
        displayName: 'screen.png',
        mimeType: 'image/png',
        referenceCharCount: null,
        referenceKind: 'image',
        referenceLabel: 'Image 1',
        referenceLineCount: null,
        referenceOrdinal: 1,
        sizeBytes: 3,
        previewUrl:
          '/api/files/view?path=Q%3A%2Frepo%2F.midterm%2Fuploads%2Fscreen.png&sessionId=s1',
      },
    ]);
  });

  it('clears persisted AppServerControl draft attachments when the session draft is removed', async () => {
    const {
      clearAppServerControlDraftAttachmentsForSession,
      loadAppServerControlDraftAttachmentsForSession,
      setAppServerControlDraftAttachmentsForSession,
    } = await import('./smartInputDraftStore');

    const drafts = new Map();
    setAppServerControlDraftAttachmentsForSession(drafts, 's1', [
      {
        id: 'a1',
        kind: 'image',
        file: null,
        uploadedPath: 'Q:/repo/.midterm/uploads/screen.png',
        displayName: 'screen.png',
        mimeType: 'image/png',
        referenceCharCount: null,
        referenceKind: 'image',
        referenceLabel: 'Image 1',
        referenceLineCount: null,
        referenceOrdinal: 1,
        sizeBytes: 3,
        previewUrl:
          '/api/files/view?path=Q%3A%2Frepo%2F.midterm%2Fuploads%2Fscreen.png&sessionId=s1',
      },
    ]);

    clearAppServerControlDraftAttachmentsForSession(drafts, 's1', false);

    expect(loadAppServerControlDraftAttachmentsForSession('s1')).toEqual([]);
  });

  it('restores staged text-reference metadata for file-viewer chips after reload', async () => {
    const {
      loadAppServerControlDraftAttachmentsForSession,
      setAppServerControlDraftAttachmentsForSession,
    } = await import('./smartInputDraftStore');

    const drafts = new Map();
    setAppServerControlDraftAttachmentsForSession(drafts, 's1', [
      {
        id: 't1',
        kind: 'file',
        file: null,
        uploadedPath: 'Q:/repo/.midterm/uploads/pasted-text.txt',
        displayName: 'pasted-text.txt',
        mimeType: 'text/plain',
        referenceCharCount: 594,
        referenceKind: 'text',
        referenceLabel: 'Text 1',
        referenceLineCount: 37,
        referenceOrdinal: 1,
        sizeBytes: 594,
        previewUrl: null,
      },
    ]);

    expect(loadAppServerControlDraftAttachmentsForSession('s1')).toEqual([
      {
        id: 't1',
        kind: 'file',
        file: null,
        uploadedPath: 'Q:/repo/.midterm/uploads/pasted-text.txt',
        displayName: 'pasted-text.txt',
        mimeType: 'text/plain',
        referenceCharCount: 594,
        referenceKind: 'text',
        referenceLabel: 'Text 1',
        referenceLineCount: 37,
        referenceOrdinal: 1,
        sizeBytes: 594,
        previewUrl: null,
      },
    ]);
  });

  it('persists submitted prompt history snapshots with attachments and quick settings', async () => {
    const { loadSmartInputPromptHistoryForSession, pushSmartInputPromptHistoryEntryForSession } =
      await import('./smartInputDraftStore');

    const histories = new Map();
    pushSmartInputPromptHistoryEntryForSession(histories, 's1', {
      composerDraft: {
        nextOrdinalByKind: { image: 2 },
        parts: [
          { kind: 'text', text: 'Review ' },
          { kind: 'reference', referenceId: 'a1' },
        ],
      },
      attachments: [
        {
          id: 'a1',
          kind: 'image',
          file: null,
          uploadedPath: 'Q:/repo/.midterm/uploads/screen.png',
          displayName: 'screen.png',
          mimeType: 'image/png',
          referenceCharCount: null,
          referenceKind: 'image',
          referenceLabel: 'Image 1',
          referenceLineCount: null,
          referenceOrdinal: 1,
          sizeBytes: 3,
          previewUrl:
            '/api/files/view?path=Q%3A%2Frepo%2F.midterm%2Fuploads%2Fscreen.png&sessionId=s1',
        },
      ],
      quickSettings: {
        model: 'gpt-5.4',
        effort: 'high',
        planMode: 'on',
        permissionMode: 'auto',
      },
    });

    expect(loadSmartInputPromptHistoryForSession('s1')).toEqual([
      {
        composerDraft: {
          nextOrdinalByKind: { image: 2 },
          parts: [
            { kind: 'text', text: 'Review ' },
            { kind: 'reference', referenceId: 'a1' },
          ],
        },
        attachments: [
          {
            id: 'a1',
            kind: 'image',
            file: null,
            uploadedPath: 'Q:/repo/.midterm/uploads/screen.png',
            displayName: 'screen.png',
            mimeType: 'image/png',
            referenceCharCount: null,
            referenceKind: 'image',
            referenceLabel: 'Image 1',
            referenceLineCount: null,
            referenceOrdinal: 1,
            sizeBytes: 3,
            previewUrl:
              '/api/files/view?path=Q%3A%2Frepo%2F.midterm%2Fuploads%2Fscreen.png&sessionId=s1',
          },
        ],
        quickSettings: {
          model: 'gpt-5.4',
          effort: 'high',
          planMode: 'on',
          permissionMode: 'auto',
        },
      },
    ]);
  });

  it('caps submitted prompt history at five entries with the newest first', async () => {
    const {
      MAX_SMART_INPUT_PROMPT_HISTORY_ENTRIES,
      loadSmartInputPromptHistoryForSession,
      pushSmartInputPromptHistoryEntryForSession,
    } = await import('./smartInputDraftStore');

    const histories = new Map();
    for (let index = 0; index < 7; index += 1) {
      pushSmartInputPromptHistoryEntryForSession(histories, 's1', {
        composerDraft: {
          nextOrdinalByKind: {},
          parts: [{ kind: 'text', text: `Prompt ${index}` }],
        },
        attachments: [],
        quickSettings: null,
      });
    }

    expect(loadSmartInputPromptHistoryForSession('s1')).toHaveLength(
      MAX_SMART_INPUT_PROMPT_HISTORY_ENTRIES,
    );
    expect(
      loadSmartInputPromptHistoryForSession('s1').map((entry) => entry.composerDraft.parts[0]),
    ).toEqual([
      { kind: 'text', text: 'Prompt 6' },
      { kind: 'text', text: 'Prompt 5' },
      { kind: 'text', text: 'Prompt 4' },
      { kind: 'text', text: 'Prompt 3' },
      { kind: 'text', text: 'Prompt 2' },
    ]);
  });
});
