import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('lensAttachments', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('creates image draft attachments with preview URLs', async () => {
    const createObjectURL = vi.fn(() => 'blob:preview');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: revokeObjectURL,
    });

    const { createLensComposerDraftAttachment } = await import('./lensAttachments');
    const file = new File(['png'], 'screen.png', { type: 'image/png' });
    const attachment = createLensComposerDraftAttachment(file);

    expect(attachment.kind).toBe('image');
    expect(attachment.previewUrl).toBe('blob:preview');
    expect(attachment.displayName).toBe('screen.png');
    expect(createObjectURL).toHaveBeenCalledWith(file);
  });

  it('creates non-image draft attachments without preview URLs', async () => {
    const createObjectURL = vi.fn(() => 'blob:preview');
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });

    const { createLensComposerDraftAttachment } = await import('./lensAttachments');
    const file = new File(['pdf'], 'report.pdf', { type: 'application/pdf' });
    const attachment = createLensComposerDraftAttachment(file);

    expect(attachment.kind).toBe('file');
    expect(attachment.previewUrl).toBeNull();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('maps uploaded attachments into Lens attachment references', async () => {
    const { toLensAttachmentReference } = await import('./lensAttachments');

    expect(
      toLensAttachmentReference(
        {
          id: 'a1',
          kind: 'image',
          file: new File(['png'], 'screen.png', { type: 'image/png' }),
          displayName: 'screen.png',
          mimeType: 'image/png',
          sizeBytes: 3,
          previewUrl: 'blob:preview',
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
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:preview'),
    });
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
        displayName: 'screen.png',
        mimeType: 'image/png',
        sizeBytes: 3,
        previewUrl: 'blob:preview',
      },
      {
        id: 'a2',
        kind: 'file',
        file: new File(['txt'], 'note.txt', { type: 'text/plain' }),
        displayName: 'note.txt',
        mimeType: 'text/plain',
        sizeBytes: 4,
        previewUrl: null,
      },
    ]);

    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview');
  });
});
