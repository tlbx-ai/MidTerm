/**
 * File Drop Module
 *
 * Handles drag-and-drop file uploads and clipboard image paste.
 * Files are uploaded to the server and the resulting path is inserted into the terminal.
 */

import { $activeSessionId } from '../../stores';
import { sendLensTurn } from '../../api/client';
import type { LensAttachmentReference } from '../../api/types';
import { createLensTurnRequest, isLensActiveSession } from '../lens/input';
import { isSessionDragActive } from '../sidebar/sessionDrag';
import { pasteToTerminal } from './manager';
import { resolveImagePasteMode } from './imagePasteMode';
import { t } from '../i18n';
import { createLogger } from '../logging';

const log = createLogger('fileDrop');

// =============================================================================
// Constants
// =============================================================================

const TEXT_FILE_SIZE_LIMIT = 40 * 1024; // 40KB
const LONG_TRANSFER_TEXT_THRESHOLD = 1024;
const TRANSFER_OVERLAY_CLASS = 'terminal-transfer-active';

const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.webp',
  '.svg',
  '.ico',
  '.tiff',
  '.tif',
  '.heic',
  '.heif',
  '.avif',
]);

const REJECTED_EXTENSIONS = new Set([
  // Documents
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.odt',
  '.ods',
  '.odp',
  '.rtf',
  // Executables/binaries
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.app',
  '.msi',
  '.deb',
  '.rpm',
  '.dmg',
  '.iso',
  // Archives
  '.zip',
  '.tar',
  '.gz',
  '.7z',
  '.rar',
  '.bz2',
  '.xz',
  '.tgz',
  // Binary data
  '.bin',
  '.dat',
  '.db',
  '.sqlite',
  '.sqlite3',
  // Media (non-image)
  '.mp3',
  '.mp4',
  '.wav',
  '.avi',
  '.mov',
  '.mkv',
  '.flac',
  '.ogg',
  '.webm',
]);

export type ClipboardPasteResult = 'image' | 'text' | 'none' | 'unavailable';

export interface ClipboardPasteContext {
  foregroundName?: string | null;
  foregroundCommandLine?: string | null;
}

interface ClipboardImageData {
  blob: Blob;
  type: string;
}

interface TransferOverlayController {
  setLabel: (label: string) => void;
  close: () => void;
}

// =============================================================================
// Helper Functions
// =============================================================================

function getFileExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  return lastDot >= 0 ? filename.slice(lastDot).toLowerCase() : '';
}

function isImageFile(filename: string): boolean {
  return IMAGE_EXTENSIONS.has(getFileExtension(filename));
}

function isRejectedFile(filename: string): boolean {
  return REJECTED_EXTENSIONS.has(getFileExtension(filename));
}

function showDropToast(message: string, sticky = false): void {
  const existing = document.querySelector('.drop-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'drop-toast error';
  if (sticky) toast.classList.add('sticky');
  toast.textContent = message;
  document.body.appendChild(toast);

  if (sticky) {
    toast.addEventListener('click', () => {
      toast.classList.add('hiding');
      setTimeout(() => {
        toast.remove();
      }, 300);
    });
  } else {
    setTimeout(() => {
      toast.classList.add('hiding');
      setTimeout(() => {
        toast.remove();
      }, 300);
    }, 3000);
  }
}

function showHttpsRequiredToast(): void {
  const existing = document.querySelector('.drop-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'drop-toast error sticky https-warning';

  const icon = document.createElement('span');
  icon.className = 'toast-icon';
  icon.textContent = '🔒';

  const content = document.createElement('div');
  content.className = 'toast-content';

  const title = document.createElement('div');
  title.className = 'toast-title';
  title.textContent = t('fileDrop.httpsRequired');

  const desc = document.createElement('div');
  desc.className = 'toast-desc';
  desc.textContent = t('fileDrop.browserBlocks');

  const link = document.createElement('a');
  link.href = '/trust';
  link.className = 'toast-link';
  link.textContent = t('fileDrop.trustCertificate');

  content.appendChild(title);
  content.appendChild(desc);
  content.appendChild(link);

  const close = document.createElement('button');
  close.className = 'toast-close';
  close.innerHTML = '&times;';
  close.addEventListener('click', (e) => {
    e.stopPropagation();
    toast.classList.add('hiding');
    setTimeout(() => {
      toast.remove();
    }, 300);
  });

  toast.appendChild(icon);
  toast.appendChild(content);
  toast.appendChild(close);
  document.body.appendChild(toast);
}

function getTerminalContainer(sessionId: string): HTMLElement | null {
  const container = document.getElementById(`terminal-${sessionId}`);
  return container instanceof HTMLElement ? container : null;
}

function ensureTransferOverlay(container: HTMLElement): HTMLElement {
  let overlay = container.querySelector<HTMLElement>('.terminal-transfer-overlay');
  if (overlay) {
    return overlay;
  }

  overlay = document.createElement('div');
  overlay.className = 'terminal-transfer-overlay';
  overlay.setAttribute('aria-hidden', 'true');

  const spinner = document.createElement('div');
  spinner.className = 'terminal-transfer-spinner';

  const label = document.createElement('div');
  label.className = 'terminal-transfer-label';

  overlay.appendChild(spinner);
  overlay.appendChild(label);
  container.appendChild(overlay);
  return overlay;
}

function showTransferOverlay(sessionId: string, initialLabel: string): TransferOverlayController {
  const container = getTerminalContainer(sessionId);
  if (!container) {
    return {
      setLabel: () => {},
      close: () => {},
    };
  }

  const overlay = ensureTransferOverlay(container);
  const label = overlay.querySelector<HTMLElement>('.terminal-transfer-label');
  const nextCount = Number(container.dataset.transferCount ?? '0') + 1;
  container.dataset.transferCount = String(nextCount);
  container.classList.add(TRANSFER_OVERLAY_CLASS);

  const setLabel = (text: string): void => {
    if (label) {
      label.textContent = text;
    }
  };

  setLabel(initialLabel);

  return {
    setLabel,
    close: () => {
      const currentCount = Number(container.dataset.transferCount ?? '1');
      const next = Math.max(0, currentCount - 1);
      if (next === 0) {
        delete container.dataset.transferCount;
        container.classList.remove(TRANSFER_OVERLAY_CLASS);
      } else {
        container.dataset.transferCount = String(next);
      }
    },
  };
}

async function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(reader.result as string);
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error('FileReader failed'));
    };
    reader.readAsText(file);
  });
}

/**
 * Sanitize pasted content to:
 * 1. Normalize line endings (CRLF/CR → LF) to prevent interleaved empty lines
 * 2. Strip all escape sequences to prevent "appears then deleted" bugs
 * 3. Remove BPM markers to prevent paste escape attacks
 *
 * BPM markers are re-added by pasteToTerminal() after sanitization.
 */
export function sanitizeCopyContent(text: string): string {
  const lines = text.split('\n');
  const trimmed = lines.map((line) => line.trimEnd());
  const minIndent = trimmed.reduce((min, line) => {
    if (line.length === 0) return min;
    const indent = line.match(/^(\s*)/)?.[0].length ?? 0;
    return Math.min(min, indent);
  }, Infinity);
  if (minIndent > 0 && minIndent < Infinity) {
    return trimmed.map((line) => (line.length > 0 ? line.slice(minIndent) : line)).join('\n');
  }
  return trimmed.join('\n');
}

export function sanitizePasteContent(text: string): string {
  return (
    text
      .replace(/\r\n/g, '\n') // Normalize CRLF → LF first
      .replace(/\r(?!\n)/g, '\n') // Normalize CR → LF (Mac Classic)
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '') // Remove CSI sequences (colors, cursor, clear)
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\][^\x07]*\x07/g, '') // Remove OSC sequences (titles, hyperlinks)
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, '') // Remove DCS/SOS/PM/APC sequences
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b[\x20-\x2F]*[\x30-\x7E]/g, '')
  ); // Remove other escape sequences
}

/**
 * Upload a file to the server for the given session
 */
async function uploadFile(sessionId: string, file: File): Promise<string | null> {
  const formData = new FormData();
  formData.append('file', file);

  try {
    const response = await fetch(`/api/sessions/${sessionId}/upload`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      if (response.status === 401) {
        showDropToast(t('fileDrop.uploadFailedAuth'));
      } else if (response.status === 404) {
        showDropToast(t('fileDrop.uploadFailedSession'));
      } else {
        showDropToast(`${t('fileDrop.uploadFailed')}: ${response.status}`);
      }
      return null;
    }

    const result: unknown = await response.json();
    if (typeof result === 'object' && result !== null && 'path' in result) {
      const maybePath = (result as { path: unknown }).path;
      return typeof maybePath === 'string' ? maybePath : null;
    }
    return null;
  } catch (_error) {
    showDropToast(t('fileDrop.uploadFailedNetwork'));
    return null;
  }
}

function buildClipboardImageFile(imageData: ClipboardImageData): File {
  const ext = imageData.type === 'image/png' ? '.png' : '.jpg';
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return new File([imageData.blob], `clipboard_${ts}${ext}`, { type: imageData.type });
}

async function readClipboardImageData(): Promise<ClipboardImageData | null> {
  if (
    typeof navigator.clipboard === 'undefined' ||
    typeof navigator.clipboard.read !== 'function'
  ) {
    return null;
  }

  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const imageType = item.types.find((t) => t.startsWith('image/'));
      if (!imageType) continue;
      const blob = await item.getType(imageType);
      return { blob, type: imageType };
    }
  } catch {
    // clipboard.read() failed (permission denied / blocked / unsupported)
  }

  return null;
}

async function pasteClipboardText(sessionId: string): Promise<ClipboardPasteResult> {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      const sanitized = sanitizePasteContent(text);
      if (sanitized.length > LONG_TRANSFER_TEXT_THRESHOLD) {
        const overlay = showTransferOverlay(sessionId, t('fileDrop.transferringText'));
        try {
          await pasteToTerminal(sessionId, sanitized);
        } finally {
          overlay.close();
        }
      } else {
        await pasteToTerminal(sessionId, sanitized);
      }
      return 'text';
    }
  } catch {
    // clipboard.readText() failed (permission denied / blocked / unsupported)
  }

  return 'none';
}

async function pasteClipboardImageAsPath(
  sessionId: string,
  imageData: ClipboardImageData,
): Promise<ClipboardPasteResult> {
  const overlay = showTransferOverlay(sessionId, t('fileDrop.uploadingToTerminal'));
  const file = buildClipboardImageFile(imageData);
  try {
    const path = await uploadFile(sessionId, file);
    if (!path) {
      return 'unavailable';
    }

    overlay.setLabel(t('fileDrop.transferringToTerminal'));
    await pasteToTerminal(sessionId, sanitizePasteContent(path), true);
    return 'image';
  } finally {
    overlay.close();
  }
}

async function sendNativeClipboardImage(
  sessionId: string,
  imageData: ClipboardImageData,
): Promise<ClipboardPasteResult> {
  const overlay = showTransferOverlay(sessionId, t('fileDrop.uploadingToTerminal'));
  const file = buildClipboardImageFile(imageData);
  const formData = new FormData();
  formData.append('file', file);

  try {
    const resp = await fetch(`/api/sessions/${sessionId}/paste-clipboard-image`, {
      method: 'POST',
      body: formData,
    });
    if (resp.ok) {
      return 'image';
    }
    showDropToast(`${t('fileDrop.clipboardFailed')}: ${resp.status}`);
  } catch {
    // network error
  } finally {
    overlay.close();
  }

  return 'unavailable';
}

/**
 * Handle file drop - routes to appropriate handler based on file type:
 * - Image files: upload and paste path
 * - Rejected files (pdf, exe, etc.): show error toast
 * - Text files: read content and paste (with 40KB limit)
 */
export async function handleFileDrop(files: FileList): Promise<void> {
  const activeId = $activeSessionId.get();
  if (!activeId || files.length === 0) return;

  const fileList = Array.from(files);
  const lensActive = isLensActiveSession(activeId);
  const needsUpload = fileList.some((file) => isImageFile(file.name) || isRejectedFile(file.name));
  const needsLongTextTransfer = fileList.some(
    (file) =>
      !isImageFile(file.name) &&
      !isRejectedFile(file.name) &&
      file.size > LONG_TRANSFER_TEXT_THRESHOLD,
  );
  const overlay =
    needsUpload || needsLongTextTransfer
      ? showTransferOverlay(
          activeId,
          needsUpload
            ? t(lensActive ? 'fileDrop.uploadingToLens' : 'fileDrop.uploadingToTerminal')
            : t(lensActive ? 'fileDrop.transferringTextLens' : 'fileDrop.transferringText'),
        )
      : null;
  const uploadedPaths: string[] = [];
  const lensAttachments: LensAttachmentReference[] = [];
  const textSnippets: string[] = [];

  try {
    for (const file of fileList) {
      // Image files: upload and collect path
      if (isImageFile(file.name)) {
        const path = await uploadFile(activeId, file);
        if (path) {
          uploadedPaths.push(path);
          if (lensActive) {
            lensAttachments.push({
              kind: 'image',
              path,
              mimeType: file.type || null,
              displayName: file.name,
            });
          }
        }
        continue;
      }

      // Binary/document files: upload and paste path (PDFs, archives, etc.)
      if (isRejectedFile(file.name)) {
        const path = await uploadFile(activeId, file);
        if (path) {
          uploadedPaths.push(path);
          if (lensActive) {
            lensAttachments.push({
              kind: 'file',
              path,
              mimeType: file.type || null,
              displayName: file.name,
            });
          }
        }
        continue;
      }

      // Text files: check size limit
      if (file.size > TEXT_FILE_SIZE_LIMIT) {
        showDropToast(`${t('fileDrop.fileTooLarge')}: ${file.name}`);
        continue;
      }

      // Read and paste text content
      try {
        const content = await readFileAsText(file);
        const sanitized = sanitizePasteContent(content);
        if (lensActive) {
          textSnippets.push(`File "${file.name}":\n${sanitized}`);
          continue;
        }

        if (overlay) {
          overlay.setLabel(t('fileDrop.transferringText'));
        }
        await pasteToTerminal(activeId, sanitized, false);
      } catch (_err) {
        log.error(() => `Failed to read file: ${file.name}`);
        showDropToast(`${t('fileDrop.failedToRead')}: ${file.name}`);
      }
    }

    if (lensActive) {
      const promptParts: string[] = [];
      if (textSnippets.length > 0) {
        promptParts.push(textSnippets.join('\n\n'));
      }

      const promptText = promptParts.join('\n\n').trim();
      if (promptText.length > 0 || lensAttachments.length > 0) {
        if (overlay) {
          overlay.setLabel(t('fileDrop.transferringToLens'));
        }
        await sendLensTurn(activeId, createLensTurnRequest(promptText, lensAttachments));
      }
      return;
    }

    if (uploadedPaths.length > 0) {
      if (overlay) {
        overlay.setLabel(t('fileDrop.transferringToTerminal'));
      }
      const joined = sanitizePasteContent(uploadedPaths.join(' '));
      await pasteToTerminal(activeId, joined, true);
    }
  } finally {
    overlay?.close();
  }
}

/**
 * Set up drag-and-drop handlers for a terminal container
 */
export function setupFileDrop(container: HTMLElement): void {
  container.dataset.dropText = t('fileDrop.dropToUpload');

  // Prevent default drag behaviors - but only show indicator for file drags
  container.addEventListener('dragover', (e) => {
    // Don't show file drop indicator during session docking
    if (isSessionDragActive()) return;

    e.preventDefault();
    e.stopPropagation();
    container.classList.add('drag-over');
  });

  container.addEventListener('dragleave', (e) => {
    if (isSessionDragActive()) return;

    e.preventDefault();
    e.stopPropagation();
    container.classList.remove('drag-over');
  });

  container.addEventListener('dragend', () => {
    container.classList.remove('drag-over');
  });

  // Handle drop - only process actual file drops, not session docking
  container.addEventListener('drop', (e) => {
    // Session docking is handled by sessionDrag.ts global handler
    if (isSessionDragActive()) return;

    e.preventDefault();
    e.stopPropagation();
    container.classList.remove('drag-over');

    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      void handleFileDrop(files);
    }
  });
}

/**
 * Handle clipboard paste with automatic image strategy:
 * - native clipboard injection for known CLI agents (Codex, Gemini, etc.)
 * - path paste for apps that read file paths (Claude, unknown)
 * - text paste fallback when clipboard has no image
 */
export async function handleClipboardPaste(
  sessionId: string,
  context: ClipboardPasteContext = {},
): Promise<ClipboardPasteResult> {
  if (!window.isSecureContext) {
    showHttpsRequiredToast();
    return 'unavailable';
  }

  if (
    typeof navigator.clipboard === 'undefined' ||
    typeof navigator.clipboard.readText !== 'function'
  ) {
    return 'unavailable';
  }

  const imageData = await readClipboardImageData();
  if (imageData) {
    const mode = resolveImagePasteMode({
      name: context.foregroundName ?? null,
      commandLine: context.foregroundCommandLine ?? null,
    });

    if (mode === 'native') {
      const nativeResult = await sendNativeClipboardImage(sessionId, imageData);
      if (nativeResult === 'image') return nativeResult;
      const pathResult = await pasteClipboardImageAsPath(sessionId, imageData);
      if (pathResult === 'image') return pathResult;
      return nativeResult === 'unavailable' || pathResult === 'unavailable'
        ? 'unavailable'
        : 'none';
    }

    const pathResult = await pasteClipboardImageAsPath(sessionId, imageData);
    if (pathResult === 'image') return pathResult;
    const nativeResult = await sendNativeClipboardImage(sessionId, imageData);
    if (nativeResult === 'image') return nativeResult;
    return pathResult === 'unavailable' || nativeResult === 'unavailable' ? 'unavailable' : 'none';
  }

  return pasteClipboardText(sessionId);
}

/**
 * Handle Alt+V clipboard image paste.
 * Process-aware: for native-clipboard apps (Codex, etc.) sets OS clipboard
 * and injects \x1bv into PTY. For path-mode apps (Claude, unknown) uploads
 * and pastes the file path instead.
 */
export async function handleNativeImagePaste(
  sessionId: string,
  context: ClipboardPasteContext = {},
): Promise<ClipboardPasteResult> {
  if (!window.isSecureContext) {
    showHttpsRequiredToast();
    return 'unavailable';
  }

  if (
    typeof navigator.clipboard === 'undefined' ||
    typeof navigator.clipboard.read !== 'function'
  ) {
    return 'unavailable';
  }

  const imageData = await readClipboardImageData();
  if (!imageData) return 'none';

  const mode = resolveImagePasteMode({
    name: context.foregroundName ?? null,
    commandLine: context.foregroundCommandLine ?? null,
  });

  if (mode === 'path') {
    return pasteClipboardImageAsPath(sessionId, imageData);
  }

  return sendNativeClipboardImage(sessionId, imageData);
}
