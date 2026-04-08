import type { LensComposerDraftAttachment } from './lensAttachments';
import {
  cloneLensComposerDraftAttachments,
  hydrateLensComposerDraftAttachment,
  releaseLensComposerDraftAttachmentPreviews,
  toPersistedLensComposerDraftAttachment,
  type PersistedLensComposerDraftAttachment,
} from './lensAttachments';

const LENS_ATTACHMENT_STORAGE_KEY_PREFIX = 'smartinput-lens-attachments:';

function getLensAttachmentStorageKey(sessionId: string): string {
  return `${LENS_ATTACHMENT_STORAGE_KEY_PREFIX}${sessionId}`;
}

function persistLensDraftAttachmentsForSession(
  sessionId: string,
  attachments: readonly LensComposerDraftAttachment[],
): void {
  if (typeof localStorage === 'undefined') {
    return;
  }

  const persisted = attachments
    .map((attachment) => toPersistedLensComposerDraftAttachment(attachment))
    .filter(
      (attachment): attachment is PersistedLensComposerDraftAttachment => attachment !== null,
    );

  if (persisted.length === 0) {
    localStorage.removeItem(getLensAttachmentStorageKey(sessionId));
    return;
  }

  localStorage.setItem(getLensAttachmentStorageKey(sessionId), JSON.stringify(persisted));
}

function clearPersistedLensDraftAttachmentsForSession(sessionId: string): void {
  if (typeof localStorage === 'undefined') {
    return;
  }

  localStorage.removeItem(getLensAttachmentStorageKey(sessionId));
}

function tryParsePersistedLensDraftAttachment(
  value: unknown,
): PersistedLensComposerDraftAttachment | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const attachment = value as Record<string, unknown>;
  const kind = attachment.kind;
  if (kind !== 'image' && kind !== 'file') {
    return null;
  }

  const uploadedPath = attachment.uploadedPath;
  const displayName = attachment.displayName;
  const sizeBytes = attachment.sizeBytes;
  if (
    typeof attachment.id !== 'string' ||
    typeof uploadedPath !== 'string' ||
    typeof displayName !== 'string' ||
    typeof sizeBytes !== 'number'
  ) {
    return null;
  }

  return {
    id: attachment.id,
    kind,
    uploadedPath,
    displayName,
    mimeType: typeof attachment.mimeType === 'string' ? attachment.mimeType : null,
    referenceKind:
      attachment.referenceKind === 'image' ||
      attachment.referenceKind === 'file' ||
      attachment.referenceKind === 'text'
        ? attachment.referenceKind
        : null,
    referenceLabel:
      typeof attachment.referenceLabel === 'string' ? attachment.referenceLabel : null,
    referenceOrdinal:
      typeof attachment.referenceOrdinal === 'number' ? attachment.referenceOrdinal : null,
    sizeBytes,
  };
}

export function loadLensDraftAttachmentsForSession(
  sessionId: string,
): LensComposerDraftAttachment[] {
  if (typeof localStorage === 'undefined') {
    return [];
  }

  const raw = localStorage.getItem(getLensAttachmentStorageKey(sessionId));
  if (!raw) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((value) => tryParsePersistedLensDraftAttachment(value))
      .filter(
        (attachment): attachment is PersistedLensComposerDraftAttachment => attachment !== null,
      )
      .map((attachment) => hydrateLensComposerDraftAttachment(sessionId, attachment));
  } catch {
    return [];
  }
}

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
    clearPersistedLensDraftAttachmentsForSession(sessionId);
    return;
  }

  drafts.set(sessionId, [...attachments]);
  persistLensDraftAttachmentsForSession(sessionId, attachments);
}

export function clearLensDraftAttachmentsForSession(
  drafts: Map<string, LensComposerDraftAttachment[]>,
  sessionId: string,
  revokePreviews: boolean = true,
): void {
  const attachments = drafts.get(sessionId);
  drafts.delete(sessionId);
  clearPersistedLensDraftAttachmentsForSession(sessionId);
  if (!attachments) {
    return;
  }
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
  clearPersistedLensDraftAttachmentsForSession(sessionId);
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
