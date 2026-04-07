import type { LensAttachmentReference } from '../../api/types';

export const MAX_LENS_IMAGE_BYTES = 10 * 1024 * 1024;

export interface PersistedLensComposerDraftAttachment {
  id: string;
  kind: 'image' | 'file';
  uploadedPath: string;
  displayName: string;
  mimeType: string | null;
  sizeBytes: number;
}

export interface LensComposerDraftAttachment {
  id: string;
  kind: 'image' | 'file';
  file: File | null;
  uploadedPath: string | null;
  displayName: string;
  mimeType: string | null;
  sizeBytes: number;
  previewUrl: string | null;
}

function createDraftAttachmentId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `lens-attachment-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function hasImageExtension(fileName: string): boolean {
  return /\.(png|jpe?g|gif|bmp|webp|svg|tiff?|heic|heif|avif)$/i.test(fileName);
}

export function isLensComposerImageFile(file: Pick<File, 'type' | 'name'>): boolean {
  return file.type.toLowerCase().startsWith('image/') || hasImageExtension(file.name);
}

export function buildLensComposerAttachmentPreviewUrl(sessionId: string, path: string): string {
  return `/api/files/view?path=${encodeURIComponent(path)}&sessionId=${encodeURIComponent(sessionId)}`;
}

export function createLensComposerDraftAttachment(
  sessionId: string,
  file: Pick<File, 'name' | 'size' | 'type'>,
  uploadedPath: string,
  localFile: File | null = null,
): LensComposerDraftAttachment {
  const image = isLensComposerImageFile(file);
  return {
    id: createDraftAttachmentId(),
    kind: image ? 'image' : 'file',
    file: localFile,
    uploadedPath,
    displayName: file.name || 'attachment',
    mimeType: file.type || null,
    sizeBytes: file.size,
    previewUrl: image ? buildLensComposerAttachmentPreviewUrl(sessionId, uploadedPath) : null,
  };
}

export function hydrateLensComposerDraftAttachment(
  sessionId: string,
  attachment: PersistedLensComposerDraftAttachment,
): LensComposerDraftAttachment {
  return {
    ...attachment,
    file: null,
    previewUrl:
      attachment.kind === 'image'
        ? buildLensComposerAttachmentPreviewUrl(sessionId, attachment.uploadedPath)
        : null,
  };
}

export function cloneLensComposerDraftAttachments(
  attachments: readonly LensComposerDraftAttachment[],
): LensComposerDraftAttachment[] {
  return attachments.map((attachment) => ({ ...attachment }));
}

export function toPersistedLensComposerDraftAttachment(
  attachment: LensComposerDraftAttachment,
): PersistedLensComposerDraftAttachment | null {
  if (!attachment.uploadedPath) {
    return null;
  }

  return {
    id: attachment.id,
    kind: attachment.kind,
    uploadedPath: attachment.uploadedPath,
    displayName: attachment.displayName,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
  };
}

export function releaseLensComposerDraftAttachmentPreviews(
  attachments: readonly LensComposerDraftAttachment[],
): void {
  for (const attachment of attachments) {
    if (attachment.previewUrl?.startsWith('blob:')) {
      URL.revokeObjectURL(attachment.previewUrl);
    }
  }
}

export function toLensAttachmentReference(
  attachment: LensComposerDraftAttachment,
  path: string,
): LensAttachmentReference {
  return {
    kind: attachment.kind,
    path,
    mimeType: attachment.mimeType,
    displayName: attachment.displayName,
  };
}
