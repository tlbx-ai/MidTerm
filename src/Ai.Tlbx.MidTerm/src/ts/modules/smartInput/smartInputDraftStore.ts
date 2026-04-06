import type { LensComposerDraftAttachment } from './lensAttachments';
import {
  cloneLensComposerDraftAttachments,
  releaseLensComposerDraftAttachmentPreviews,
} from './lensAttachments';

export function getLensDraftAttachmentsForSession(
  drafts: ReadonlyMap<string, LensComposerDraftAttachment[]>,
  sessionId: string | null,
): LensComposerDraftAttachment[] {
  return sessionId ? (drafts.get(sessionId) ?? []) : [];
}

export function setLensDraftAttachmentsForSession(
  drafts: Map<string, LensComposerDraftAttachment[]>,
  sessionId: string,
  attachments: readonly LensComposerDraftAttachment[],
): void {
  if (attachments.length === 0) {
    drafts.delete(sessionId);
    return;
  }

  drafts.set(sessionId, [...attachments]);
}

export function clearLensDraftAttachmentsForSession(
  drafts: Map<string, LensComposerDraftAttachment[]>,
  sessionId: string,
  revokePreviews: boolean = true,
): void {
  const attachments = drafts.get(sessionId);
  if (!attachments) {
    return;
  }

  drafts.delete(sessionId);
  if (revokePreviews) {
    releaseLensComposerDraftAttachmentPreviews(attachments);
  }
}

export function detachLensDraftAttachmentsForSession(
  drafts: Map<string, LensComposerDraftAttachment[]>,
  sessionId: string,
): LensComposerDraftAttachment[] {
  const attachments = getLensDraftAttachmentsForSession(drafts, sessionId);
  drafts.delete(sessionId);
  return cloneLensComposerDraftAttachments(attachments);
}

export function persistSessionDraft(
  drafts: Map<string, string>,
  sessionId: string | null,
  draft: string,
): void {
  if (!sessionId) {
    return;
  }

  if (draft) {
    drafts.set(sessionId, draft);
    return;
  }

  drafts.delete(sessionId);
}

export function applySessionDraftToTextarea(
  drafts: ReadonlyMap<string, string>,
  textarea: HTMLTextAreaElement | null,
  sessionId: string | null,
  resizeTextarea: (textarea: HTMLTextAreaElement) => void,
): void {
  if (!textarea) {
    return;
  }

  const nextValue = sessionId ? (drafts.get(sessionId) ?? '') : '';
  if (textarea.value !== nextValue) {
    textarea.value = nextValue;
  }
  textarea.scrollTop = 0;
  resizeTextarea(textarea);
}
