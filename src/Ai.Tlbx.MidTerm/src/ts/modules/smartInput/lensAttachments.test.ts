import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('lensAttachments', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('creates image draft attachments with server-backed preview URLs', async () => {
    const { createLensComposerDraftAttachment } = await import('./lensAttachments');
    const file = new File(['png'], 'screen.png', { type: 'image/png' });
    const attachment = createLensComposerDraftAttachment(
      's1',
      file,
      'Q:/repo/.midterm/uploads/screen.png',
    );

    expect(attachment.kind).toBe('image');
    expect(attachment.uploadedPath).toBe('Q:/repo/.midterm/uploads/screen.png');
    expect(attachment.previewUrl).toBe(
      '/api/files/view?path=Q%3A%2Frepo%2F.midterm%2Fuploads%2Fscreen.png&sessionId=s1',
    );
    expect(attachment.displayName).toBe('screen.png');
    expect(attachment.file).toBeNull();
  });

  it('creates non-image draft attachments without preview URLs', async () => {
    const { createLensComposerDraftAttachment } = await import('./lensAttachments');
    const file = new File(['pdf'], 'report.pdf', { type: 'application/pdf' });
    const attachment = createLensComposerDraftAttachment(
      's1',
      file,
      'Q:/repo/.midterm/uploads/report.pdf',
    );

    expect(attachment.kind).toBe('file');
    expect(attachment.previewUrl).toBeNull();
    expect(attachment.uploadedPath).toBe('Q:/repo/.midterm/uploads/report.pdf');
  });

  it('detects pasted image clipboard data from data transfer items', async () => {
    const { clipboardDataMayContainLensComposerImage, extractLensComposerPasteImageFiles } =
      await import('./lensAttachments');
    const clipboardImage = new File(['png'], 'copied-image.png', { type: 'image/png' });
    const clipboardData = {
      files: [],
      items: [
        {
          kind: 'file',
          type: 'image/png',
          getAsFile: () => clipboardImage,
        },
      ],
      getData: () => '',
    };

    expect(clipboardDataMayContainLensComposerImage(clipboardData as unknown as DataTransfer)).toBe(
      true,
    );
    await expect(
      extractLensComposerPasteImageFiles(clipboardData as unknown as DataTransfer, null),
    ).resolves.toEqual([clipboardImage]);
  });

  it('extracts pasted image files from copied html image markup', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      blob: async () => new Blob(['img'], { type: 'image/webp' }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const { clipboardDataMayContainLensComposerImage, extractLensComposerPasteImageFiles } =
      await import('./lensAttachments');
    const clipboardData = {
      files: [],
      items: [],
      getData: (type: string) =>
        type === 'text/html' ? '<img src="https://cdn.example.com/photo">' : '',
    };

    expect(clipboardDataMayContainLensComposerImage(clipboardData as unknown as DataTransfer)).toBe(
      true,
    );

    const files = await extractLensComposerPasteImageFiles(
      clipboardData as unknown as DataTransfer,
      null,
    );

    expect(fetchMock).toHaveBeenCalledWith('https://cdn.example.com/photo');
    expect(files).toHaveLength(1);
    expect(files[0]?.type).toBe('image/webp');
    expect(files[0]?.name).toBe('photo.webp');
  });

  it('falls back to navigator clipboard image blobs when paste data lacks files', async () => {
    const { extractLensComposerPasteImageFiles } = await import('./lensAttachments');
    const files = await extractLensComposerPasteImageFiles(null, async () => [
      {
        types: ['image/avif'],
        getType: async () => new Blob(['avif'], { type: 'image/avif' }),
      },
    ]);

    expect(files).toHaveLength(1);
    expect(files[0]?.type).toBe('image/avif');
    expect(files[0]?.name).toMatch(/\.avif$/);
  });

  it('maps uploaded attachments into Lens attachment references', async () => {
    const { toLensAttachmentReference } = await import('./lensAttachments');

    expect(
      toLensAttachmentReference(
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
        'Q:/repo/.midterm/uploads/screen.png',
      ),
    ).toEqual({
      kind: 'image',
      path: 'Q:/repo/.midterm/uploads/screen.png',
      mimeType: 'image/png',
      displayName: 'screen.png',
    });
  });

  it('releases preview URLs when drafts are discarded', async () => {
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: revokeObjectURL,
    });

    const { releaseLensComposerDraftAttachmentPreviews } = await import('./lensAttachments');
    releaseLensComposerDraftAttachmentPreviews([
      {
        id: 'a1',
        kind: 'image',
        file: new File(['png'], 'screen.png', { type: 'image/png' }),
        uploadedPath: null,
        displayName: 'screen.png',
        mimeType: 'image/png',
        referenceCharCount: null,
        referenceKind: 'image',
        referenceLabel: 'Image 1',
        referenceLineCount: null,
        referenceOrdinal: 1,
        sizeBytes: 3,
        previewUrl: 'blob:preview',
      },
      {
        id: 'a2',
        kind: 'file',
        file: null,
        uploadedPath: 'Q:/repo/.midterm/uploads/note.txt',
        displayName: 'note.txt',
        mimeType: 'text/plain',
        referenceCharCount: null,
        referenceKind: null,
        referenceLabel: null,
        referenceLineCount: null,
        referenceOrdinal: null,
        sizeBytes: 4,
        previewUrl: null,
      },
      {
        id: 'a3',
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

    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview');
  });

  it('keeps copied html text paste alone when it does not carry image content', async () => {
    const { clipboardDataMayContainLensComposerImage, extractLensComposerPasteImageFiles } =
      await import('./lensAttachments');
    const clipboardData = {
      files: [],
      items: [],
      getData: (type: string) =>
        type === 'text/html' ? '<p>regular copied text</p>' : 'regular copied text',
    };

    expect(clipboardDataMayContainLensComposerImage(clipboardData as unknown as DataTransfer)).toBe(
      false,
    );
    await expect(
      extractLensComposerPasteImageFiles(clipboardData as unknown as DataTransfer, null),
    ).resolves.toEqual([]);
  });
});
