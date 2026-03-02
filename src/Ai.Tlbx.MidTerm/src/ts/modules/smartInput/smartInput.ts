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
 * Auto-send toggle: when active, transcribed text is sent immediately.
 * Touch keys: the touch controller bar is embedded as a collapsible second row.
 */

import { $currentSettings, $activeSessionId } from '../../stores';
import { sendInput } from '../comms';
import { t } from '../i18n';
import { hideTouchController } from '../touchController';
import { startTranscription, stopTranscription } from './transcription';

let overlay: HTMLDivElement | null = null;
let dockedBar: HTMLDivElement | null = null;
let activeTextarea: HTMLTextAreaElement | null = null;
let activeMicBtn: HTMLButtonElement | null = null;
let autoSendEnabled = localStorage.getItem('smartinput-autosend') === 'true';
let keysExpanded = localStorage.getItem('smartinput-keys-expanded') === 'true';
let isRecording = false;
let touchControllerOriginalParent: HTMLElement | null = null;
let touchControllerOriginalNext: Node | null = null;

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
      releaseTouchController();
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
  embedTouchController(overlay);
  activeTextarea?.focus();
}

export function hideSmartInput(): void {
  if (overlay?.classList.contains('visible')) {
    releaseTouchController();
  }
  overlay?.classList.remove('visible');
}

function showDockedBar(): void {
  if (!dockedBar) createDockedDOM();
  dockedBar?.classList.add('visible');
  activeTextarea = dockedBar?.querySelector('.smart-input-textarea') as HTMLTextAreaElement | null;
  activeMicBtn = dockedBar?.querySelector('.smart-input-mic-btn') as HTMLButtonElement | null;
  embedTouchController(dockedBar);
}

function hideDockedBar(): void {
  if (dockedBar?.classList.contains('visible')) {
    releaseTouchController();
  }
  dockedBar?.classList.remove('visible');
}

function embedTouchController(container: HTMLElement | null): void {
  if (!container) return;
  const tc = document.getElementById('touch-controller');
  if (!tc) return;

  if (!touchControllerOriginalParent) {
    touchControllerOriginalParent = tc.parentElement;
    touchControllerOriginalNext = tc.nextSibling;
  }

  container.appendChild(tc);
  tc.classList.add('embedded');
  hideTouchController();
  container.classList.toggle('keys-expanded', keysExpanded);
}

function releaseTouchController(): void {
  const tc = document.getElementById('touch-controller');
  if (!tc || !touchControllerOriginalParent) return;
  if (!tc.classList.contains('embedded')) return;

  tc.classList.remove('embedded');
  if (touchControllerOriginalNext) {
    touchControllerOriginalParent.insertBefore(tc, touchControllerOriginalNext);
  } else {
    touchControllerOriginalParent.appendChild(tc);
  }
}

function createInputElements(): {
  inputRow: HTMLDivElement;
} {
  const inputRow = document.createElement('div');
  inputRow.className = 'smart-input-row';

  const micBtn = document.createElement('button');
  micBtn.className = 'smart-input-mic-btn';
  micBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>';
  micBtn.title = 'Push to talk (Right Ctrl)';

  const autoSendBtn = document.createElement('button');
  autoSendBtn.className = 'smart-input-autosend-btn';
  autoSendBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M7 2v11h3v9l7-12h-4l4-8z"/></svg>';
  autoSendBtn.title = t('smartInput.autoSend');
  if (autoSendEnabled) autoSendBtn.classList.add('active');

  autoSendBtn.addEventListener('click', () => {
    autoSendEnabled = !autoSendEnabled;
    autoSendBtn.classList.toggle('active', autoSendEnabled);
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

  const toggleKeysBtn = document.createElement('button');
  toggleKeysBtn.className = 'smart-input-toggle-keys';
  if (keysExpanded) toggleKeysBtn.classList.add('expanded');
  toggleKeysBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg>';
  toggleKeysBtn.title = 'Toggle keys';

  toggleKeysBtn.addEventListener('click', () => {
    keysExpanded = !keysExpanded;
    toggleKeysBtn.classList.toggle('expanded', keysExpanded);
    localStorage.setItem('smartinput-keys-expanded', String(keysExpanded));
    const container = toggleKeysBtn.closest('.smart-input-overlay, .smart-input-docked');
    container?.classList.toggle('keys-expanded', keysExpanded);
  });

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

  inputRow.appendChild(micBtn);
  inputRow.appendChild(autoSendBtn);
  inputRow.appendChild(textarea);
  inputRow.appendChild(sendBtn);
  inputRow.appendChild(toggleKeysBtn);

  return { inputRow };
}

function createOverlayDOM(): void {
  overlay = document.createElement('div');
  overlay.className = 'smart-input-overlay';

  const { inputRow } = createInputElements();
  overlay.appendChild(inputRow);

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

  const { inputRow } = createInputElements();
  dockedBar.appendChild(inputRow);

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
