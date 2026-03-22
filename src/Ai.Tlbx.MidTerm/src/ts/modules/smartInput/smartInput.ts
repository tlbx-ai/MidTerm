/**
 * Smart Input UI
 *
 * Creates and manages a docked text input bar for terminal sessions.
 * Three modes:
 * - "keyboard": no smart input bar (default)
 * - "smartinput": docked bar below the terminal that replaces terminal keyboard focus
 * - "both": docked bar below the terminal while direct terminal keyboard input still works
 *
 * Right Ctrl push-to-talk: hold to record, release to transcribe.
 * Auto-send toggle: when active, transcribed text is sent immediately.
 * Touch keys: the touch controller bar is embedded as a collapsible second row.
 */

import { $currentSettings, $activeSessionId, $voiceServerPassword } from '../../stores';
import { sendInput } from '../comms';
import { t } from '../i18n';
import { isLensActiveSession, createLensTurnRequest, submitLensTurn } from '../lens/input';
import { onTabActivated, onTabDeactivated } from '../sessionTabs';
import { isDevMode, onDevModeChanged } from '../sidebar/voiceSection';
import { handleFileDrop, pasteToTerminal } from '../terminal';
import { hideTouchController } from '../touchController';
import { startTranscription, stopTranscription } from './transcription';

let dockedBar: HTMLDivElement | null = null;
let activeTextarea: HTMLTextAreaElement | null = null;
let activeMicBtn: HTMLButtonElement | null = null;
let autoSendEnabled = localStorage.getItem('smartinput-autosend') === 'true';
let keysExpanded = localStorage.getItem('smartinput-keys-expanded') === 'true';
let isRecording = false;
let touchControllerOriginalParent: HTMLElement | null = null;
let touchControllerOriginalNext: Node | null = null;
let lastSessionId: string | null = null;
const MAX_TEXTAREA_LINES = 5;
const SMART_INPUT_SUBMIT_DELAY_MS = 200;
const sessionDrafts = new Map<string, string>();

export function isSmartInputMode(): boolean {
  if (isLensActiveSession($activeSessionId.get())) {
    return true;
  }

  const mode = $currentSettings.get()?.inputMode;
  return mode === 'smartinput';
}

export function isBothMode(): boolean {
  if (isLensActiveSession($activeSessionId.get())) {
    return false;
  }

  return $currentSettings.get()?.inputMode === 'both';
}

function hasSmartInput(): boolean {
  if (isLensActiveSession($activeSessionId.get())) {
    return true;
  }

  const mode = $currentSettings.get()?.inputMode;
  return mode === 'smartinput' || mode === 'both';
}

export function initSmartInput(): void {
  $activeSessionId.subscribe((sessionId) => {
    persistDraftForSession(lastSessionId);
    lastSessionId = sessionId;
    syncDraftForActiveSession();
    syncSmartInputVisibility(isLensActiveSession(sessionId));
  });

  $currentSettings.subscribe((settings) => {
    if (!settings) return;
    persistDraftForSession($activeSessionId.get());
    syncSmartInputVisibility();
  });

  $voiceServerPassword.subscribe(() => {
    syncVoiceInputAvailability();
  });

  onDevModeChanged(() => {
    syncVoiceInputAvailability();
  });

  onTabActivated('agent', (sessionId) => {
    if ($activeSessionId.get() === sessionId) {
      syncSmartInputVisibility(true);
    }
  });

  onTabDeactivated('agent', (sessionId) => {
    if ($activeSessionId.get() === sessionId) {
      syncSmartInputVisibility();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.code !== 'ControlRight') return;
    if (!hasSmartInput()) return;
    if (!canUseSmartInputVoice()) return;
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
  showDockedBar(true);
}

export function hideSmartInput(): void {
  if (dockedBar?.classList.contains('visible')) {
    releaseTouchController();
  }
  dockedBar?.classList.remove('visible');
}

function syncSmartInputVisibility(focusTextarea: boolean = false): void {
  const activeId = $activeSessionId.get();
  if (isLensActiveSession(activeId)) {
    showDockedBar(focusTextarea);
    return;
  }

  const settings = $currentSettings.get();
  if (!settings) {
    return;
  }

  if (settings.inputMode === 'smartinput') {
    hideSmartInput();
    if (activeId) {
      showSmartInput();
    }
    return;
  }

  if (settings.inputMode === 'both') {
    hideSmartInput();
    showDockedBar(focusTextarea);
    return;
  }

  hideSmartInput();
  hideDockedBar();
  releaseTouchController();
}

function showDockedBar(focusTextarea: boolean = false): void {
  if (!dockedBar) createDockedDOM();
  relocateDockedBar();
  dockedBar?.classList.add('visible');
  activeTextarea = dockedBar?.querySelector('.smart-input-textarea') as HTMLTextAreaElement | null;
  activeMicBtn = dockedBar?.querySelector('.smart-input-mic-btn') as HTMLButtonElement | null;
  if (activeTextarea) {
    applyDraftToTextarea(activeTextarea, $activeSessionId.get());
    resizeTextarea(activeTextarea);
  }
  syncVoiceInputAvailability();
  embedTouchController(dockedBar);
  if (focusTextarea) {
    activeTextarea?.focus({ preventScroll: true });
  }
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
  micBtn.hidden = !canUseSmartInputVoice();

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

  const photoBtn = document.createElement('button');
  photoBtn.className = 'smart-input-photo-btn';
  photoBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4z"/><path d="M9 2 7.17 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2h-3.17L15 2H9zm3 15c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5z"/></svg>';
  photoBtn.title = t('smartInput.photo');

  const photoInput = document.createElement('input');
  photoInput.type = 'file';
  photoInput.accept = 'image/*';
  photoInput.capture = 'environment';
  photoInput.style.display = 'none';

  photoBtn.addEventListener('click', () => {
    if (isTouchDevice()) {
      photoInput.click();
    } else {
      void captureFromWebcam();
    }
  });
  photoInput.addEventListener('change', () => {
    if (photoInput.files?.length) {
      void handleFileDrop(photoInput.files);
    }
    photoInput.value = '';
  });

  const attachBtn = document.createElement('button');
  attachBtn.className = 'smart-input-attach-btn';
  attachBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5a2.5 2.5 0 0 1 5 0v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5a2.5 2.5 0 0 0 5 0V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z"/></svg>';
  attachBtn.title = t('smartInput.attach');

  const attachInput = document.createElement('input');
  attachInput.type = 'file';
  attachInput.multiple = true;
  attachInput.style.display = 'none';

  attachBtn.addEventListener('click', () => {
    attachInput.click();
  });
  attachInput.addEventListener('change', () => {
    if (attachInput.files?.length) {
      void handleFileDrop(attachInput.files);
    }
    attachInput.value = '';
  });

  const textarea = document.createElement('textarea');
  textarea.className = 'smart-input-textarea';
  textarea.rows = 1;
  textarea.placeholder = 'Type here...';
  resizeTextarea(textarea);

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
    const container = toggleKeysBtn.closest('.smart-input-docked');
    container?.classList.toggle('keys-expanded', keysExpanded);
  });

  // Auto-grow textarea
  textarea.addEventListener('input', () => {
    persistDraftForSession($activeSessionId.get(), textarea.value);
    resizeTextarea(textarea);
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
  inputRow.appendChild(photoBtn);
  inputRow.appendChild(photoInput);
  inputRow.appendChild(attachBtn);
  inputRow.appendChild(attachInput);
  inputRow.appendChild(textarea);
  inputRow.appendChild(sendBtn);
  inputRow.appendChild(toggleKeysBtn);

  return { inputRow };
}

function createDockedDOM(): void {
  dockedBar = document.createElement('div');
  dockedBar.className = 'smart-input-docked';

  const { inputRow } = createInputElements();
  dockedBar.appendChild(inputRow);
  relocateDockedBar();
  updateAutoSendVisibility();
  syncVoiceInputAvailability();
}

function relocateDockedBar(): void {
  if (!dockedBar) return;

  const lensComposerHost = findActiveLensComposerHost();
  if (lensComposerHost) {
    lensComposerHost.appendChild(dockedBar);
    dockedBar.classList.add('smart-input-lens-docked');
    return;
  }

  dockedBar.classList.remove('smart-input-lens-docked');
  const managerBar = document.getElementById('manager-bar');
  if (managerBar?.parentElement) {
    managerBar.parentElement.insertBefore(dockedBar, managerBar.nextSibling);
    return;
  }

  document.querySelector('.main-content')?.appendChild(dockedBar);
}

function findActiveLensComposerHost(): HTMLElement | null {
  const activeSessionId = $activeSessionId.get();
  if (!activeSessionId || !isLensActiveSession(activeSessionId)) {
    return null;
  }

  const activePanel = document.querySelector<HTMLElement>(
    `.session-wrapper[data-session-id="${CSS.escape(activeSessionId)}"] .agent-composer-host`,
  );
  if (activePanel) {
    return activePanel;
  }

  return document.querySelector<HTMLElement>('.session-wrapper.active .agent-composer-host');
}

function sendText(ta: HTMLTextAreaElement): void {
  const text = ta.value;
  if (!text) return;

  const sessionId = $activeSessionId.get();
  if (!sessionId) return;

  void submitSmartInput(sessionId, text);

  ta.value = '';
  persistDraftForSession(sessionId, '');
  syncDraftForActiveSession();
  ta.scrollTop = 0;
  resizeTextarea(ta);
  ta.focus();
}

function persistDraftForSession(sessionId: string | null, draftOverride?: string): void {
  if (!sessionId) return;

  const draft = draftOverride ?? activeTextarea?.value ?? '';
  if (draft) {
    sessionDrafts.set(sessionId, draft);
    return;
  }

  sessionDrafts.delete(sessionId);
}

function applyDraftToTextarea(
  textarea: HTMLTextAreaElement | null,
  sessionId: string | null,
): void {
  if (!textarea) return;

  const nextValue = sessionId ? (sessionDrafts.get(sessionId) ?? '') : '';
  if (textarea.value !== nextValue) {
    textarea.value = nextValue;
  }
  textarea.scrollTop = 0;
  resizeTextarea(textarea);
}

function syncDraftForActiveSession(): void {
  const sessionId = $activeSessionId.get();
  applyDraftToTextarea(
    dockedBar?.querySelector('.smart-input-textarea') as HTMLTextAreaElement | null,
    sessionId,
  );
  if (activeTextarea) {
    applyDraftToTextarea(activeTextarea, sessionId);
  }
}

export function removeSmartInputSessionState(sessionId: string): void {
  sessionDrafts.delete(sessionId);
  if ($activeSessionId.get() === sessionId) {
    syncDraftForActiveSession();
  }
}

function resizeTextarea(textarea: HTMLTextAreaElement): void {
  textarea.style.height = 'auto';

  const computedStyle = getComputedStyle(textarea);
  const lineHeight = Number.parseFloat(computedStyle.lineHeight);
  const fallbackFontSize = Number.parseFloat(computedStyle.fontSize) || 16;
  const effectiveLineHeight = Number.isFinite(lineHeight) ? lineHeight : fallbackFontSize * 1.2;
  const maxHeight = effectiveLineHeight * MAX_TEXTAREA_LINES;
  const nextHeight = Math.min(textarea.scrollHeight, maxHeight);

  textarea.style.height = `${String(nextHeight)}px`;
  textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
}

function beginRecording(): void {
  if (!canUseSmartInputVoice()) return;
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
  void submitSmartInput(sessionId, text);
}

function endRecording(): void {
  if (!isRecording) return;
  isRecording = false;
  activeMicBtn?.classList.remove('recording');
  void stopTranscription();
}

function canUseSmartInputVoice(): boolean {
  return isDevMode() && Boolean($voiceServerPassword.get());
}

function syncVoiceInputAvailability(): void {
  const micBtn = dockedBar?.querySelector('.smart-input-mic-btn') as HTMLButtonElement | null;
  if (!micBtn) {
    return;
  }

  const enabled = canUseSmartInputVoice();
  micBtn.hidden = !enabled;
  if (!enabled && isRecording) {
    endRecording();
  }
}

function updateAutoSendVisibility(): void {
  for (const container of [dockedBar]) {
    if (!container) continue;
    container.classList.toggle('autosend-active', autoSendEnabled);
  }
}

async function submitSmartInput(sessionId: string, text: string): Promise<void> {
  if (isLensActiveSession(sessionId)) {
    await submitLensTurn(sessionId, createLensTurnRequest(text));
    return;
  }

  // Smart Input is closer to a paste/submit workflow than raw keyboard input.
  // Using the shared paste path preserves BPM handling, and a short settle
  // delay before Enter is more reliable for JS TUIs such as Codex.
  await pasteToTerminal(sessionId, text);
  await new Promise((resolve) => window.setTimeout(resolve, SMART_INPUT_SUBMIT_DELAY_MS));
  sendInput(sessionId, '\r');
}

function isTouchDevice(): boolean {
  return !matchMedia('(hover: hover) and (pointer: fine)').matches;
}

async function captureFromWebcam(): Promise<void> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
    });
  } catch {
    return;
  }

  const captureOverlay = document.createElement('div');
  captureOverlay.className = 'camera-capture-overlay';

  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.srcObject = stream;

  const controls = document.createElement('div');
  controls.className = 'camera-capture-controls';

  const snapBtn = document.createElement('button');
  snapBtn.className = 'camera-capture-snap';
  snapBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="32" height="32" fill="currentColor"><circle cx="12" cy="12" r="10"/></svg>';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'camera-capture-cancel';
  cancelBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';

  controls.appendChild(snapBtn);
  controls.appendChild(cancelBtn);
  captureOverlay.appendChild(video);
  captureOverlay.appendChild(controls);
  document.body.appendChild(captureOverlay);

  const cleanup = (): void => {
    for (const track of stream.getTracks()) {
      track.stop();
    }
    captureOverlay.remove();
  };

  cancelBtn.addEventListener('click', cleanup);
  captureOverlay.addEventListener('click', (e) => {
    if (e.target === captureOverlay) cleanup();
  });

  snapBtn.addEventListener('click', () => {
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      cleanup();
      return;
    }
    ctx.drawImage(video, 0, 0);
    cleanup();

    canvas.toBlob((blob) => {
      if (!blob) return;
      const now = new Date();
      const ts = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
      const file = new File([blob], `photo_${ts}.png`, { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      void handleFileDrop(dt.files);
    }, 'image/png');
  });
}
