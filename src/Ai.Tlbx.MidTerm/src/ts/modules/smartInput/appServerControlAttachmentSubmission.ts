import type { AppServerControlTurnRequest } from '../../api/types';
import type { AppServerControlComposerDraftAttachment } from './appServerControlAttachments';
import type { SmartInputComposerDraft } from './smartInputComposerDraft';
import { prepareSmartInputOutboundPrompt } from './smartInputOutboundReferences';

export interface SubmitAppServerControlComposerDraftArgs {
  sessionId: string;
  draft: SmartInputComposerDraft;
  attachments: readonly AppServerControlComposerDraftAttachment[];
  uploadFailureMessage: string;
  attachmentReadFailureMessage: string;
  uploadFile: (sessionId: string, file: File) => Promise<string | null>;
  createTurnRequest: (
    text: string,
    attachments: AppServerControlTurnRequest['attachments'],
    sessionId: string,
  ) => AppServerControlTurnRequest;
  submitQueuedTurn: (sessionId: string, request: AppServerControlTurnRequest) => Promise<void>;
}

export async function submitAppServerControlComposerDraft(
  args: SubmitAppServerControlComposerDraftArgs,
): Promise<{ request: AppServerControlTurnRequest; queuedTurn: Promise<void> }> {
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
