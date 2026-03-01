/**
 * Smart Input UI
 *
 * Creates and manages a text input bar for terminal sessions.
 * Two modes:
 * - "smartinput": floating overlay that replaces terminal keyboard focus (mobile)
 * - "both": docked bar below manager bar, terminal keeps keyboard focus (desktop)
 *
 * Text typed in the input is sent to the active terminal session via the mux channel.
 */

import { $currentSettings, $activeSessionId } from '../../stores';
import { sendInput } from '../comms';
import { startTranscription, stopTranscription } from './transcription';

let overlay: HTMLDivElement | null = null;
let dockedBar: HTMLDivElement | null = null;
let activeTextarea: HTMLTextAreaElement | null = null;
let isRecording = false;

export function isSmartInputMode(): boolean {
  const mode = $currentSettings.get()?.inputMode;
  return mode === 'smartinput';
}

export function isBothMode(): boolean {
  return $currentSettings.get()?.inputMode === 'both';
}

export function initSmartInput(): void {
  $currentSettings.subscribe((settings) => {
    if (!settings) return;
    if (settings.inputMode === 'smartinput') {
      hideDockedBar();
      const activeId = $activeSessionId.get();
      if (activeId) {
        showSmartInput();
      }
    } else if (settings.inputMode === 'both') {
      hideSmartInput();
      showDockedBar();
    } else {
      hideSmartInput();
      hideDockedBar();
    }
  });
}

export function showSmartInput(): void {
  if (!overlay) createOverlayDOM();
  overlay?.classList.add('visible');
  activeTextarea = overlay?.querySelector('.smart-input-textarea') as HTMLTextAreaElement | null;
  activeTextarea?.focus();
}

export function hideSmartInput(): void {
  overlay?.classList.remove('visible');
}

function showDockedBar(): void {
  if (!dockedBar) createDockedDOM();
  dockedBar?.classList.add('visible');
  activeTextarea = dockedBar?.querySelector('.smart-input-textarea') as HTMLTextAreaElement | null;
}

function hideDockedBar(): void {
  dockedBar?.classList.remove('visible');
}

function createInputElements(): {
  micBtn: HTMLButtonElement;
  textarea: HTMLTextAreaElement;
  sendBtn: HTMLButtonElement;
} {
  const micBtn = document.createElement('button');
  micBtn.className = 'smart-input-mic-btn';
  micBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>';
  micBtn.title = 'Push to talk';

  const textarea = document.createElement('textarea');
  textarea.className = 'smart-input-textarea';
  textarea.rows = 1;
  textarea.placeholder = 'Type here...';

  const sendBtn = document.createElement('button');
  sendBtn.className = 'smart-input-send-btn';
  sendBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>';
  sendBtn.title = 'Send';

  // Auto-grow textarea
  textarea.addEventListener('input', () => {
    textarea.style.height = 'auto';
    const maxHeight = parseInt(getComputedStyle(textarea).lineHeight, 10) * 3;
    textarea.style.height = `${String(Math.min(textarea.scrollHeight, maxHeight))}px`;
  });

  // Enter to send, Shift+Enter for newline
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendText(textarea);
    }
  });

  sendBtn.addEventListener('click', () => {
    sendText(textarea);
  });

  // Push-to-talk mic button
  micBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    startMicRecording(micBtn, textarea);
  });

  micBtn.addEventListener('pointerup', () => {
    stopMicRecording(micBtn);
  });

  micBtn.addEventListener('pointerleave', () => {
    if (isRecording) {
      stopMicRecording(micBtn);
    }
  });

  return { micBtn, textarea, sendBtn };
}

function createOverlayDOM(): void {
  overlay = document.createElement('div');
  overlay.className = 'smart-input-overlay';

  const { micBtn, textarea, sendBtn } = createInputElements();

  overlay.appendChild(micBtn);
  overlay.appendChild(textarea);
  overlay.appendChild(sendBtn);

  const terminalsArea = document.getElementById('terminals-area');
  if (terminalsArea) {
    terminalsArea.appendChild(overlay);
  } else {
    document.body.appendChild(overlay);
  }
}

function createDockedDOM(): void {
  dockedBar = document.createElement('div');
  dockedBar.className = 'smart-input-docked';

  const { micBtn, textarea, sendBtn } = createInputElements();

  dockedBar.appendChild(micBtn);
  dockedBar.appendChild(textarea);
  dockedBar.appendChild(sendBtn);

  const managerBar = document.getElementById('manager-bar');
  if (managerBar?.parentElement) {
    managerBar.parentElement.insertBefore(dockedBar, managerBar.nextSibling);
  } else {
    document.querySelector('.main-content')?.appendChild(dockedBar);
  }
}

function sendText(ta: HTMLTextAreaElement): void {
  const text = ta.value;
  if (!text) return;

  const sessionId = $activeSessionId.get();
  if (!sessionId) return;

  sendInput(sessionId, text);
  setTimeout(() => {
    sendInput(sessionId, '\r');
  }, 50);

  ta.value = '';
  ta.style.height = 'auto';
  ta.focus();
}

function startMicRecording(btn: HTMLButtonElement, ta: HTMLTextAreaElement): void {
  if (isRecording) return;
  isRecording = true;
  btn.classList.add('recording');

  startTranscription(
    (delta) => {
      ta.value += delta;
      ta.dispatchEvent(new Event('input'));
    },
    (completed) => {
      if (completed) {
        ta.value = completed;
        ta.dispatchEvent(new Event('input'));
      }
    },
  );
}

function stopMicRecording(btn: HTMLButtonElement): void {
  if (!isRecording) return;
  isRecording = false;
  btn.classList.remove('recording');
  void stopTranscription();
}
