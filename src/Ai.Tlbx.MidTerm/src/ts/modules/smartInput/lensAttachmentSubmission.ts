import type { LensTurnRequest } from '../../api/types';
import type { LensComposerDraftAttachment } from './lensAttachments';
import { toLensAttachmentReference } from './lensAttachments';

export interface SubmitLensComposerDraftArgs {
  sessionId: string;
  text: string;
  attachments: readonly LensComposerDraftAttachment[];
  uploadFailureMessage: string;
  uploadFile: (sessionId: string, file: File) => Promise<string | null>;
  createTurnRequest: (
    text: string,
    attachments: LensTurnRequest['attachments'],
    sessionId: string,
  ) => LensTurnRequest;
  submitQueuedTurn: (sessionId: string, request: LensTurnRequest) => Promise<void>;
}

export async function submitLensComposerDraft(
  args: SubmitLensComposerDraftArgs,
): Promise<{ request: LensTurnRequest; queuedTurn: Promise<void> }> {
  const uploadedPaths = await Promise.all(
    args.attachments.map(async (attachment) => {
      const path = await args.uploadFile(args.sessionId, attachment.file);
      if (!path) {
        throw new Error(args.uploadFailureMessage);
      }

      return path;
    }),
  );

  const request = args.createTurnRequest(
    args.text,
    args.attachments.map((attachment, index) =>
      toLensAttachmentReference(attachment, uploadedPaths[index] ?? ''),
    ),
    args.sessionId,
  );

  return {
    request,
    queuedTurn: args.submitQueuedTurn(args.sessionId, request),
  };
}
