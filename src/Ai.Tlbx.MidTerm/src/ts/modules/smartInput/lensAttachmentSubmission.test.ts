import { describe, expect, it, vi } from 'vitest';

describe('lensAttachmentSubmission', () => {
  it('uploads all queued composer attachments before queuing the Lens turn', async () => {
    const uploadFile = vi
      .fn<(_: string, __: File) => Promise<string | null>>()
      .mockResolvedValueOnce('Q:/repo/.midterm/uploads/screen.png')
      .mockResolvedValueOnce('Q:/repo/.midterm/uploads/report.pdf');
    const createTurnRequest = vi.fn(
      (text: string, attachments: unknown[], sessionId: string) => ({
        text,
        attachments,
        sessionId,
      }),
    );
    const submitQueuedTurn = vi.fn(async () => {});

    const { submitLensComposerDraft } = await import('./lensAttachmentSubmission');
    const result = await submitLensComposerDraft({
      sessionId: 's1',
      text: 'Inspect these files.',
      attachments: [
        {
          id: 'a1',
          kind: 'image',
          file: new File(['png'], 'screen.png', { type: 'image/png' }),
          displayName: 'screen.png',
          mimeType: 'image/png',
          sizeBytes: 3,
          previewUrl: 'blob:screen',
        },
        {
          id: 'a2',
          kind: 'file',
          file: new File(['pdf'], 'report.pdf', { type: 'application/pdf' }),
          displayName: 'report.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 3,
          previewUrl: null,
        },
      ],
      uploadFailureMessage: 'Attachment upload failed',
      uploadFile,
      createTurnRequest,
      submitQueuedTurn,
    });

    expect(createTurnRequest).toHaveBeenCalledWith(
      'Inspect these files.',
      [
        {
          kind: 'image',
          path: 'Q:/repo/.midterm/uploads/screen.png',
          mimeType: 'image/png',
          displayName: 'screen.png',
        },
        {
          kind: 'file',
          path: 'Q:/repo/.midterm/uploads/report.pdf',
          mimeType: 'application/pdf',
          displayName: 'report.pdf',
        },
      ],
      's1',
    );
    expect(submitQueuedTurn).toHaveBeenCalledWith('s1', {
      text: 'Inspect these files.',
      attachments: [
        {
          kind: 'image',
          path: 'Q:/repo/.midterm/uploads/screen.png',
          mimeType: 'image/png',
          displayName: 'screen.png',
        },
        {
          kind: 'file',
          path: 'Q:/repo/.midterm/uploads/report.pdf',
          mimeType: 'application/pdf',
          displayName: 'report.pdf',
        },
      ],
      sessionId: 's1',
    });
    await expect(result.queuedTurn).resolves.toBeUndefined();
  });

  it('fails fast when any upload does not produce a path', async () => {
    const uploadFile = vi
      .fn<(_: string, __: File) => Promise<string | null>>()
      .mockResolvedValueOnce(null);

    const { submitLensComposerDraft } = await import('./lensAttachmentSubmission');

    await expect(
      submitLensComposerDraft({
        sessionId: 's1',
        text: 'Inspect this image.',
        attachments: [
          {
            id: 'a1',
            kind: 'image',
            file: new File(['png'], 'screen.png', { type: 'image/png' }),
            displayName: 'screen.png',
            mimeType: 'image/png',
            sizeBytes: 3,
            previewUrl: 'blob:screen',
          },
        ],
        uploadFailureMessage: 'Attachment upload failed',
        uploadFile,
        createTurnRequest: vi.fn(),
        submitQueuedTurn: vi.fn(async () => {}),
      }),
    ).rejects.toThrow('Attachment upload failed');
  });
});
