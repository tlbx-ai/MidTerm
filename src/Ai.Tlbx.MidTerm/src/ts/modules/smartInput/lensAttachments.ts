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

export interface ClipboardReadImageItem {
  readonly types: readonly string[];
  getType(type: string): Promise<Blob>;
}

type ClipboardReadImageProvider = () => Promise<readonly ClipboardReadImageItem[]>;

type ClipboardTransferItem = Pick<DataTransferItem, 'kind' | 'type' | 'getAsFile'>;
type ClipboardTransferData = Pick<DataTransfer, 'files' | 'items' | 'getData'>;

const HTML_IMAGE_SRC_PATTERN = /<img\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
const IMAGE_URL_PATH_PATTERN = /\.(png|jpe?g|gif|bmp|webp|svg|tiff?|heic|heif|avif|ico)(?:$|[?#])/i;

const IMAGE_EXTENSION_BY_MIME_TYPE: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/tiff': '.tiff',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'image/avif': '.avif',
  'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico',
};

function createDraftAttachmentId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `lens-attachment-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function hasImageExtension(fileName: string): boolean {
  return /\.(png|jpe?g|gif|bmp|webp|svg|tiff?|heic|heif|avif|ico)$/i.test(fileName);
}

export function isLensComposerImageFile(file: Pick<File, 'type' | 'name'>): boolean {
  return file.type.toLowerCase().startsWith('image/') || hasImageExtension(file.name);
}

function normalizeClipboardImageMimeType(mimeType: string | null | undefined): string | null {
  if (typeof mimeType !== 'string') {
    return null;
  }

  const normalized = mimeType.trim().toLowerCase();
  if (!normalized.startsWith('image/')) {
    return null;
  }

  return normalized === 'image/jpg' ? 'image/jpeg' : normalized;
}

function getClipboardImageExtension(mimeType: string | null): string {
  if (!mimeType) {
    return '.png';
  }

  return IMAGE_EXTENSION_BY_MIME_TYPE[mimeType] ?? '.png';
}

function decodeClipboardHtmlEntity(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function trimClipboardUrl(value: string): string {
  return decodeClipboardHtmlEntity(value.trim());
}

function extractClipboardImageUrlsFromHtml(html: string): string[] {
  const matches: string[] = [];
  for (const match of html.matchAll(HTML_IMAGE_SRC_PATTERN)) {
    const candidate = trimClipboardUrl(match[1] ?? match[2] ?? match[3] ?? '');
    if (candidate) {
      matches.push(candidate);
    }
  }

  return matches;
}

function extractClipboardImageUrlsFromUriList(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && !entry.startsWith('#'));
}

function isClipboardImageDataUrl(value: string): boolean {
  return /^data:image\/[a-z0-9.+-]+(?:;charset=[^;,]+)?(?:;base64)?,/i.test(value);
}

function looksLikeClipboardImageUrl(value: string): boolean {
  return isClipboardImageDataUrl(value) || IMAGE_URL_PATH_PATTERN.test(value);
}

function getClipboardTransferImageFiles(
  clipboardData: ClipboardTransferData | null | undefined,
): File[] {
  const files: File[] = [];
  for (const file of Array.from(clipboardData?.files ?? [])) {
    if (isLensComposerImageFile(file)) {
      files.push(file);
    }
  }

  for (const item of Array.from(clipboardData?.items ?? []) as ClipboardTransferItem[]) {
    if (item.kind !== 'file') {
      continue;
    }

    if (!normalizeClipboardImageMimeType(item.type)) {
      continue;
    }

    const file = item.getAsFile();
    if (file && isLensComposerImageFile(file)) {
      files.push(file);
    }
  }

  return files;
}

function dedupeClipboardFiles(files: readonly File[]): File[] {
  const seen = new Set<string>();
  const deduped: File[] = [];

  for (const file of files) {
    const key = `${file.name}\u0000${file.size.toString(10)}\u0000${file.type}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(file);
  }

  return deduped;
}

function buildClipboardImageFileName(
  mimeType: string | null,
  sourceUrl: string | null,
  fallbackIndex: number,
): string {
  if (sourceUrl) {
    try {
      const url = new URL(sourceUrl, 'https://midterm.invalid');
      const candidate = decodeURIComponent(url.pathname.split('/').pop() ?? '').trim();
      if (candidate.length > 0) {
        return hasImageExtension(candidate)
          ? candidate
          : `${candidate}${getClipboardImageExtension(mimeType)}`;
      }
    } catch {
      // Keep the generated fallback name when the clipboard source is not a URL.
    }
  }

  return `clipboard-image-${fallbackIndex.toString(10)}${getClipboardImageExtension(mimeType)}`;
}

async function buildClipboardImageFileFromUrl(
  sourceUrl: string,
  fallbackIndex: number,
): Promise<File | null> {
  if (!sourceUrl || /^javascript:/i.test(sourceUrl)) {
    return null;
  }

  try {
    const response = await fetch(sourceUrl);
    if (!response.ok) {
      return null;
    }

    const blob = await response.blob();
    const mimeType = normalizeClipboardImageMimeType(blob.type);
    const file = new File(
      [blob],
      buildClipboardImageFileName(mimeType, sourceUrl, fallbackIndex),
      mimeType ? { type: mimeType } : undefined,
    );
    return isLensComposerImageFile(file) ? file : null;
  } catch {
    return null;
  }
}

function getDefaultClipboardReadImageProvider(): ClipboardReadImageProvider | null {
  if (
    typeof navigator === 'undefined' ||
    typeof navigator.clipboard === 'undefined' ||
    typeof navigator.clipboard.read !== 'function'
  ) {
    return null;
  }

  return () => navigator.clipboard.read();
}

async function getClipboardReadImageFiles(
  readClipboardItems: ClipboardReadImageProvider | null,
): Promise<File[]> {
  if (!readClipboardItems) {
    return [];
  }

  try {
    const files: File[] = [];
    const clipboardItems = await readClipboardItems();
    let index = 0;
    for (const item of clipboardItems) {
      for (const type of item.types) {
        const mimeType = normalizeClipboardImageMimeType(type);
        if (!mimeType) {
          continue;
        }

        const blob = await item.getType(type);
        index += 1;
        files.push(
          new File([blob], buildClipboardImageFileName(mimeType, null, index), { type: mimeType }),
        );
      }
    }

    return files;
  } catch {
    return [];
  }
}

function getClipboardImageSourceUrls(
  clipboardData: ClipboardTransferData | null | undefined,
): string[] {
  if (!clipboardData) {
    return [];
  }

  const html = clipboardData.getData('text/html');
  const htmlUrls = html ? extractClipboardImageUrlsFromHtml(html) : [];
  const uriList = clipboardData.getData('text/uri-list');
  const uriListUrls = uriList ? extractClipboardImageUrlsFromUriList(uriList) : [];
  const plainText = clipboardData.getData('text/plain').trim();

  if (isClipboardImageDataUrl(plainText)) {
    return [...htmlUrls, ...uriListUrls, plainText];
  }

  return [...htmlUrls, ...uriListUrls];
}

export function clipboardDataMayContainLensComposerImage(
  clipboardData: ClipboardTransferData | null | undefined,
): boolean {
  if (getClipboardTransferImageFiles(clipboardData).length > 0) {
    return true;
  }

  const html = clipboardData?.getData('text/html') ?? '';
  if (html && extractClipboardImageUrlsFromHtml(html).length > 0) {
    return true;
  }

  return getClipboardImageSourceUrls(clipboardData).some((url) => looksLikeClipboardImageUrl(url));
}

export async function extractLensComposerPasteImageFiles(
  clipboardData: ClipboardTransferData | null | undefined,
  readClipboardItems: ClipboardReadImageProvider | null = getDefaultClipboardReadImageProvider(),
): Promise<File[]> {
  const transferFiles = getClipboardTransferImageFiles(clipboardData);
  if (transferFiles.length > 0) {
    return dedupeClipboardFiles(transferFiles);
  }

  const filesFromUrls: File[] = [];
  let sourceIndex = 0;
  for (const sourceUrl of getClipboardImageSourceUrls(clipboardData)) {
    if (!looksLikeClipboardImageUrl(sourceUrl) && !/^https?:\/\//i.test(sourceUrl)) {
      continue;
    }

    sourceIndex += 1;
    const file = await buildClipboardImageFileFromUrl(sourceUrl, sourceIndex);
    if (file) {
      filesFromUrls.push(file);
    }
  }

  if (filesFromUrls.length > 0) {
    return dedupeClipboardFiles(filesFromUrls);
  }

  return dedupeClipboardFiles(await getClipboardReadImageFiles(readClipboardItems));
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
