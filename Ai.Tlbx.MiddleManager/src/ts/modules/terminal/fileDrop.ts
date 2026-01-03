/**
 * File Drop Module
 *
 * Handles drag-and-drop file uploads and clipboard image paste.
 * Files are uploaded to the server and the resulting path is inserted into the terminal.
 */

import { activeSessionId } from '../../state';

// Forward declaration for sendInput
let sendInput: (sessionId: string, data: string) => void = () => {};

/**
 * Register the sendInput callback from mux channel
 */
export function registerFileDropCallbacks(callbacks: {
  sendInput?: (sessionId: string, data: string) => void;
}): void {
  if (callbacks.sendInput) sendInput = callbacks.sendInput;
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
      body: formData
    });

    if (!response.ok) {
      console.error('File upload failed:', response.status);
      return null;
    }

    const result = await response.json();
    return result.path;
  } catch (error) {
    console.error('File upload error:', error);
    return null;
  }
}

/**
 * Handle file drop - upload and insert path
 */
async function handleFileDrop(files: FileList): Promise<void> {
  if (!activeSessionId || files.length === 0) return;

  const paths: string[] = [];

  for (const file of Array.from(files)) {
    const path = await uploadFile(activeSessionId, file);
    if (path) {
      paths.push(path);
    }
  }

  if (paths.length > 0) {
    // Insert paths separated by space, with quotes if path contains spaces
    const pathString = paths
      .map(p => p.includes(' ') ? `"${p}"` : p)
      .join(' ');
    sendInput(activeSessionId, pathString);
  }
}

/**
 * Handle clipboard image paste - convert to file and upload
 */
async function handleClipboardImage(items: DataTransferItemList): Promise<boolean> {
  if (!activeSessionId) return false;

  for (const item of Array.from(items)) {
    if (item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) {
        // Always use .jpg extension - TUIs are smart enough to detect actual format
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const namedFile = new File([file], `clipboard_${timestamp}.jpg`, { type: file.type });

        const path = await uploadFile(activeSessionId, namedFile);
        if (path) {
          const pathString = path.includes(' ') ? `"${path}"` : path;
          sendInput(activeSessionId, pathString);
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Set up drag-and-drop handlers for a terminal container
 */
export function setupFileDrop(container: HTMLElement): void {
  // Prevent default drag behaviors
  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    container.classList.add('drag-over');
  });

  container.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    container.classList.remove('drag-over');
  });

  container.addEventListener('dragend', () => {
    container.classList.remove('drag-over');
  });

  // Handle drop
  container.addEventListener('drop', async (e) => {
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
 * Set up clipboard paste handler for image data
 * Returns true if an image was handled, false otherwise
 */
export function setupClipboardImagePaste(sessionId: string, terminal: any): void {
  terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
    // Only handle Ctrl+V / Cmd+V
    if (e.type !== 'keydown') return true;
    if (!((e.ctrlKey || e.metaKey) && e.key === 'v')) return true;

    // Check clipboard for images
    navigator.clipboard.read().then(async (items) => {
      for (const item of items) {
        const imageType = item.types.find(t => t.startsWith('image/'));
        if (imageType) {
          const blob = await item.getType(imageType);
          // Always use .jpg extension - TUIs are smart enough to detect actual format
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const file = new File([blob], `clipboard_${timestamp}.jpg`, { type: imageType });

          const path = await uploadFile(sessionId, file);
          if (path) {
            const pathString = path.includes(' ') ? `"${path}"` : path;
            sendInput(sessionId, pathString);
          }
        }
      }
    }).catch(() => {
      // Clipboard read failed or not supported - fall through to normal paste
    });

    // Always return true to allow normal text paste to proceed
    // The image paste happens asynchronously if there was an image
    return true;
  });
}
