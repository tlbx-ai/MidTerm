import type { LensAttachmentReference } from '../../api/types';

export const MAX_LENS_IMAGE_BYTES = 10 * 1024 * 1024;

export interface LensComposerDraftAttachment {
  id: string;
  kind: 'image' | 'file';
  file: File;
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

export function createLensComposerDraftAttachment(file: File): LensComposerDraftAttachment {
  const image = isLensComposerImageFile(file);
  return {
    id: createDraftAttachmentId(),
    kind: image ? 'image' : 'file',
    file,
    displayName: file.name || 'attachment',
    mimeType: file.type || null,
    sizeBytes: file.size,
    previewUrl: image ? URL.createObjectURL(file) : null,
  };
}

export function cloneLensComposerDraftAttachments(
  attachments: readonly LensComposerDraftAttachment[],
): LensComposerDraftAttachment[] {
  return attachments.map((attachment) => ({ ...attachment }));
}

export function releaseLensComposerDraftAttachmentPreviews(
  attachments: readonly LensComposerDraftAttachment[],
): void {
  for (const attachment of attachments) {
    if (attachment.previewUrl) {
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
