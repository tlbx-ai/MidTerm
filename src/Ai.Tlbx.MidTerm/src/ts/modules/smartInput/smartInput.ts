/**
 * Smart Input UI
 *
 * Creates and manages a text input bar for terminal sessions.
 * Three modes:
 * - "keyboard": no smart input bar (default)
 * - "smartinput": floating overlay that replaces terminal keyboard focus (mobile)
 * - "both": docked bar below manager bar, terminal keeps keyboard focus (desktop)
 *
 * Right Ctrl push-to-talk: hold to record, release to transcribe.
 * Auto-send checkbox: when checked, transcribed text is sent immediately.
 */

import { $currentSettings, $activeSessionId } from '../../stores';
import { sendInput } from '../comms';
import { t } from '../i18n';
import { startTranscription, stopTranscription } from './transcription';

let overlay: HTMLDivElement | null = null;
let dockedBar: HTMLDivElement | null = null;
let activeTextarea: HTMLTextAreaElement | null = null;
let activeMicBtn: HTMLButtonElement | null = null;
let autoSendEnabled = localStorage.getItem('smartinput-autosend') === 'true';
let isRecording = false;

export function isSmartInputMode(): boolean {
  const mode = $currentSettings.get()?.inputMode;
  return mode === 'smartinput';
}

export function isBothMode(): boolean {
  return $currentSettings.get()?.inputMode === 'both';
}

function hasSmartInput(): boolean {
  const mode = $currentSettings.get()?.inputMode;
  return mode === 'smartinput' || mode === 'both';
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

  document.addEventListener('keydown', (e) => {
    if (e.code !== 'ControlRight') return;
    if (!hasSmartInput()) return;
    if (isRecording) return;
    e.preventDefault();
    beginRecording();
  });

  document.addEventListener('keyup', (e) => {
    if (e.code !== 'ControlRight') return;
    if (!isRecording) return;
    e.preventDefault();
    endRecording();
  });
}

export function showSmartInput(): void {
  if (!overlay) createOverlayDOM();
  overlay?.classList.add('visible');
  activeTextarea = overlay?.querySelector('.smart-input-textarea') as HTMLTextAreaElement | null;
  activeMicBtn = overlay?.querySelector('.smart-input-mic-btn') as HTMLButtonElement | null;
  activeTextarea?.focus();
}

export function hideSmartInput(): void {
  overlay?.classList.remove('visible');
}

function showDockedBar(): void {
  if (!dockedBar) createDockedDOM();
  dockedBar?.classList.add('visible');
  activeTextarea = dockedBar?.querySelector('.smart-input-textarea') as HTMLTextAreaElement | null;
  activeMicBtn = dockedBar?.querySelector('.smart-input-mic-btn') as HTMLButtonElement | null;
}

function hideDockedBar(): void {
  dockedBar?.classList.remove('visible');
}

function createInputElements(): {
  micBtn: HTMLButtonElement;
  autoSendLabel: HTMLLabelElement;
  textarea: HTMLTextAreaElement;
  sendBtn: HTMLButtonElement;
} {
  const micBtn = document.createElement('button');
  micBtn.className = 'smart-input-mic-btn';
  micBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>';
  micBtn.title = 'Push to talk (Right Ctrl)';

  const autoSendLabel = document.createElement('label');
  autoSendLabel.className = 'smart-input-autosend';
  const autoSendCheckbox = document.createElement('input');
  autoSendCheckbox.type = 'checkbox';
  autoSendCheckbox.checked = autoSendEnabled;
  const autoSendText = document.createElement('span');
  autoSendText.textContent = t('smartInput.autoSend');
  autoSendLabel.appendChild(autoSendCheckbox);
  autoSendLabel.appendChild(autoSendText);

  autoSendCheckbox.addEventListener('change', () => {
    autoSendEnabled = autoSendCheckbox.checked;
    localStorage.setItem('smartinput-autosend', String(autoSendEnabled));
    updateAutoSendVisibility();
  });

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

  // Push-to-talk mic button (touch/mouse)
  micBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    beginRecording();
  });

  micBtn.addEventListener('pointerup', () => {
    endRecording();
  });

  micBtn.addEventListener('pointerleave', () => {
    if (isRecording) {
      endRecording();
    }
  });

  return { micBtn, autoSendLabel, textarea, sendBtn };
}

function createOverlayDOM(): void {
  overlay = document.createElement('div');
  overlay.className = 'smart-input-overlay';

  const { micBtn, autoSendLabel, textarea, sendBtn } = createInputElements();

  overlay.appendChild(micBtn);
  overlay.appendChild(autoSendLabel);
  overlay.appendChild(textarea);
  overlay.appendChild(sendBtn);

  const terminalsArea = document.getElementById('terminals-area');
  if (terminalsArea) {
    terminalsArea.appendChild(overlay);
  } else {
    document.body.appendChild(overlay);
  }
  updateAutoSendVisibility();
}

function createDockedDOM(): void {
  dockedBar = document.createElement('div');
  dockedBar.className = 'smart-input-docked';

  const { micBtn, autoSendLabel, textarea, sendBtn } = createInputElements();

  dockedBar.appendChild(micBtn);
  dockedBar.appendChild(autoSendLabel);
  dockedBar.appendChild(textarea);
  dockedBar.appendChild(sendBtn);

  const managerBar = document.getElementById('manager-bar');
  if (managerBar?.parentElement) {
    managerBar.parentElement.insertBefore(dockedBar, managerBar.nextSibling);
  } else {
    document.querySelector('.main-content')?.appendChild(dockedBar);
  }
  updateAutoSendVisibility();
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

function beginRecording(): void {
  if (isRecording) return;
  isRecording = true;
  activeMicBtn?.classList.add('recording');

  const ta = activeTextarea;
  startTranscription(
    (delta) => {
      if (ta && !autoSendEnabled) {
        ta.value += delta;
        ta.dispatchEvent(new Event('input'));
      }
    },
    (completed) => {
      if (!completed) return;
      if (autoSendEnabled) {
        sendDirectly(completed);
      } else if (ta) {
        ta.value = completed;
        ta.dispatchEvent(new Event('input'));
      }
    },
  );
}

function sendDirectly(text: string): void {
  const sessionId = $activeSessionId.get();
  if (!sessionId) return;
  sendInput(sessionId, text);
  setTimeout(() => {
    sendInput(sessionId, '\r');
  }, 50);
}

function endRecording(): void {
  if (!isRecording) return;
  isRecording = false;
  activeMicBtn?.classList.remove('recording');
  void stopTranscription();
}

function updateAutoSendVisibility(): void {
  for (const container of [overlay, dockedBar]) {
    if (!container) continue;
    container.classList.toggle('autosend-active', autoSendEnabled);
  }
}
