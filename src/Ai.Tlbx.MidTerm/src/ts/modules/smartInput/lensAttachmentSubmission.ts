import type { LensTurnRequest } from '../../api/types';
import type { LensComposerDraftAttachment } from './lensAttachments';
import type { SmartInputComposerDraft } from './smartInputComposerDraft';
import { prepareSmartInputOutboundPrompt } from './smartInputOutboundReferences';

export interface SubmitLensComposerDraftArgs {
  sessionId: string;
  draft: SmartInputComposerDraft;
  attachments: readonly LensComposerDraftAttachment[];
  uploadFailureMessage: string;
  attachmentReadFailureMessage: string;
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
  const prepared = await prepareSmartInputOutboundPrompt({
    sessionId: args.sessionId,
    draft: args.draft,
    attachments: args.attachments,
    uploadFailureMessage: args.uploadFailureMessage,
    attachmentReadFailureMessage: args.attachmentReadFailureMessage,
    uploadFile: args.uploadFile,
  });

  const request = args.createTurnRequest(prepared.text, prepared.attachments, args.sessionId);

  return {
    request,
    queuedTurn: args.submitQueuedTurn(args.sessionId, request),
  };
}
