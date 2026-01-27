/**
 * File Drop Module
 *
 * Handles drag-and-drop file uploads and clipboard image paste.
 * Files are uploaded to the server and the resulting path is inserted into the terminal.
 */

import { $activeSessionId } from '../../stores';
import { isSessionDragActive } from '../sidebar/sessionDrag';

// =============================================================================
// Constants
// =============================================================================

const TEXT_FILE_SIZE_LIMIT = 40 * 1024; // 40KB

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

// =============================================================================
// Forward declarations for callbacks
// =============================================================================

let pasteToTerminal: (sessionId: string, data: string, isFilePath?: boolean) => void = () => {};

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
      setTimeout(() => toast.remove(), 300);
    });
  } else {
    setTimeout(() => {
      toast.classList.add('hiding');
      setTimeout(() => toast.remove(), 300);
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
  title.textContent = 'Clipboard requires trusted HTTPS';

  const desc = document.createElement('div');
  desc.className = 'toast-desc';
  desc.textContent = 'Your browser blocks clipboard access on untrusted connections.';

  const link = document.createElement('a');
  link.href = '/trust';
  link.className = 'toast-link';
  link.textContent = 'Trust Certificate →';

  content.appendChild(title);
  content.appendChild(desc);
  content.appendChild(link);

  const close = document.createElement('button');
  close.className = 'toast-close';
  close.innerHTML = '&times;';
  close.addEventListener('click', (e) => {
    e.stopPropagation();
    toast.classList.add('hiding');
    setTimeout(() => toast.remove(), 300);
  });

  toast.appendChild(icon);
  toast.appendChild(content);
  toast.appendChild(close);
  document.body.appendChild(toast);
}

async function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
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
 * Register callbacks from mux channel and terminal manager
 */
export function registerFileDropCallbacks(callbacks: {
  sendInput?: (sessionId: string, data: string) => void;
  pasteToTerminal?: (sessionId: string, data: string, isFilePath?: boolean) => void;
}): void {
  if (callbacks.pasteToTerminal) pasteToTerminal = callbacks.pasteToTerminal;
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
        showDropToast('Upload failed: not authenticated');
      } else if (response.status === 404) {
        showDropToast('Upload failed: session not found');
      } else {
        showDropToast(`Upload failed: ${response.status}`);
      }
      return null;
    }

    const result = await response.json();
    return result.path;
  } catch (_error) {
    showDropToast('Upload failed: network error');
    return null;
  }
}

/**
 * Handle file drop - routes to appropriate handler based on file type:
 * - Image files: upload and paste path
 * - Rejected files (pdf, exe, etc.): show error toast
 * - Text files: read content and paste (with 40KB limit)
 */
async function handleFileDrop(files: FileList): Promise<void> {
  const activeId = $activeSessionId.get();
  if (!activeId || files.length === 0) return;

  const imagePaths: string[] = [];

  for (const file of Array.from(files)) {
    // Image files: upload and collect path
    if (isImageFile(file.name)) {
      const path = await uploadFile(activeId, file);
      if (path) imagePaths.push(path);
      continue;
    }

    // Rejected files: show error toast
    if (isRejectedFile(file.name)) {
      const ext = getFileExtension(file.name);
      showDropToast(`Cannot paste ${ext} files`);
      continue;
    }

    // Text files: check size limit
    if (file.size > TEXT_FILE_SIZE_LIMIT) {
      showDropToast(`File too large (max 40KB): ${file.name}`);
      continue;
    }

    // Read and paste text content
    try {
      const content = await readFileAsText(file);
      const sanitized = sanitizePasteContent(content);
      pasteToTerminal(activeId, sanitized, false);
    } catch (err) {
      console.error(`[FileDrop] Failed to read file: ${file.name}`, err);
      showDropToast(`Failed to read: ${file.name}`);
    }
  }

  // Paste collected image paths (if any)
  if (imagePaths.length > 0) {
    const joined = sanitizePasteContent(imagePaths.join(' '));
    pasteToTerminal(activeId, joined, true);
  }
}

/**
 * Set up drag-and-drop handlers for a terminal container
 */
export function setupFileDrop(container: HTMLElement): void {
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
  container.addEventListener('drop', async (e) => {
    // Session docking is handled by sessionDrag.ts global handler
    if (isSessionDragActive()) return;

    e.preventDefault();
    e.stopPropagation();
    container.classList.remove('drag-over');

    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      await handleFileDrop(files);
    }
  });
}

/**
 * Handle clipboard paste - checks for images first, falls back to text
 * Used by the keyboard handler in manager.ts (only on secure contexts)
 * On non-secure contexts (HTTP remote), this function won't work due to
 * browser Clipboard API restrictions - paste is handled via native events instead.
 */
export async function handleClipboardPaste(sessionId: string): Promise<void> {
  // Clipboard API requires secure context (HTTPS or localhost)
  // On HTTP remote connections, show warning and bail out
  if (!window.isSecureContext) {
    showHttpsRequiredToast();
    return;
  }

  // Try to read clipboard items (images)
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const imageType = item.types.find((t) => t.startsWith('image/'));
      if (imageType) {
        const blob = await item.getType(imageType);
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const file = new File([blob], `clipboard_${timestamp}.jpg`, { type: imageType });
        const path = await uploadFile(sessionId, file);
        if (path) {
          pasteToTerminal(sessionId, sanitizePasteContent(path), true);
          return; // Image handled, don't paste text
        }
      }
    }
  } catch {
    // clipboard.read() not supported or failed, fall through to text paste
  }

  // No image found or image handling failed, paste text
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      const sanitized = sanitizePasteContent(text);
      pasteToTerminal(sessionId, sanitized);
    }
  } catch {
    // Text paste failed
  }
}
