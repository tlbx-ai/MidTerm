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
        sizeBytes: 3,
        previewUrl:
          '/api/files/view?path=Q%3A%2Frepo%2F.midterm%2Fuploads%2Fscreen.png&sessionId=s1',
      },
    ]);

    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview');
  });
});
