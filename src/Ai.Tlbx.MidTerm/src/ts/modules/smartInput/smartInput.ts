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
import { t } from '../i18n';
import { submitSessionText } from '../input/submit';
import { handleLensEscape, isLensActiveSession } from '../lens/input';
import {
  LENS_QUICK_SETTINGS_CHANGED_EVENT,
  getLensQuickSettingsDraft,
  getLensQuickSettingsProvider,
  setLensQuickSettingsDraft,
} from '../lens/quickSettings';
import { onTabActivated } from '../sessionTabs';
import { isDevMode, onDevModeChanged } from '../sidebar/voiceSection';
import { handleFileDrop } from '../terminal';
import { hideTouchController } from '../touchController';
import { startTranscription, stopTranscription } from './transcription';
import {
  shouldShowDockedSmartInput,
  shouldShowLensQuickSettings,
  type SmartInputVisibilityState,
} from './visibility';

let dockedBar: HTMLDivElement | null = null;
let activeTextarea: HTMLTextAreaElement | null = null;
let activeMicBtn: HTMLButtonElement | null = null;
let autoSendEnabled = localStorage.getItem('smartinput-autosend') === 'true';
let keysExpanded = localStorage.getItem('smartinput-keys-expanded') === 'true';
let isRecording = false;
let touchControllerOriginalParent: HTMLElement | null = null;
let touchControllerOriginalNext: Node | null = null;
let lastSessionId: string | null = null;
let lensQuickSettingsRow: HTMLDivElement | null = null;
let lensModelInput: HTMLInputElement | null = null;
let lensEffortSelect: HTMLSelectElement | null = null;
let lensPlanSelect: HTMLSelectElement | null = null;
let lensPermissionSelect: HTMLSelectElement | null = null;
const MAX_TEXTAREA_LINES = 5;
const sessionDrafts = new Map<string, string>();

function getSmartInputVisibilityState(): SmartInputVisibilityState {
  const activeSessionId = $activeSessionId.get();
  return {
    activeSessionId,
    inputMode: $currentSettings.get()?.inputMode,
    lensActive: isLensActiveSession(activeSessionId),
  };
}

/**
 * Treats Lens as a conversation-first composer surface even when the global
 * input mode is not Smart Input, so agent turns always use the docked composer.
 */
export function isSmartInputMode(): boolean {
  const state = getSmartInputVisibilityState();
  return state.lensActive || (Boolean(state.activeSessionId) && state.inputMode === 'smartinput');
}

/**
 * Prevents Lens sessions from falling into dual-focus input semantics because
 * the conversation lane needs one clear place to type and submit.
 */
export function isBothMode(): boolean {
  if (isLensActiveSession($activeSessionId.get())) {
    return false;
  }

  return $currentSettings.get()?.inputMode === 'both';
}

function hasSmartInput(): boolean {
  return shouldShowDockedSmartInput(getSmartInputVisibilityState());
}

/**
 * Keeps the docked composer aligned with session changes, Lens activation, and
 * dev-only voice affordances so Smart Input can serve both terminal and Lens flows.
 */
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

  if (typeof window !== 'undefined') {
    window.addEventListener(LENS_QUICK_SETTINGS_CHANGED_EVENT, () => {
      syncLensQuickSettingsControls();
    });
  }

  onTabActivated('agent', (sessionId) => {
    if ($activeSessionId.get() === sessionId) {
      syncSmartInputVisibility(true);
    }
  });

  onTabActivated('terminal', (sessionId) => {
    if ($activeSessionId.get() === sessionId) {
      syncSmartInputVisibility();
    }
  });

  onTabActivated('files', (sessionId) => {
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

/**
 * Exposes the docked composer for flows that explicitly want text captured in
 * Smart Input rather than by sending keystrokes straight to the terminal.
 */
export function showSmartInput(): void {
  showDockedBar(true);
}

/**
 * Hides the docked composer and releases embedded controls so the terminal can
 * return to being the only visible input surface when that is the active mode.
 */
export function hideSmartInput(): void {
  if (dockedBar?.classList.contains('visible')) {
    releaseTouchController();
  }
  dockedBar?.classList.remove('visible');
}

function syncSmartInputVisibility(focusTextarea: boolean = false): void {
  if (!shouldShowDockedSmartInput(getSmartInputVisibilityState())) {
    hideSmartInput();
    hideDockedBar();
    releaseTouchController();
    return;
  }

  showDockedBar(focusTextarea);
}

function showDockedBar(focusTextarea: boolean = false): void {
  if (!shouldShowDockedSmartInput(getSmartInputVisibilityState())) {
    hideDockedBar();
    return;
  }

  if (!dockedBar) createDockedDOM();
  relocateDockedBar();
  dockedBar?.classList.add('visible');
  activeTextarea = dockedBar?.querySelector('.smart-input-textarea') as HTMLTextAreaElement | null;
  activeMicBtn = dockedBar?.querySelector('.smart-input-mic-btn') as HTMLButtonElement | null;
  if (activeTextarea) {
    applyDraftToTextarea(activeTextarea, $activeSessionId.get());
    resizeTextarea(activeTextarea);
  }
  syncLensQuickSettingsControls();
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
  lensSettingsRow: HTMLDivElement;
  inputRow: HTMLDivElement;
} {
  const nextLensQuickSettingsRow = document.createElement('div');
  nextLensQuickSettingsRow.className = 'smart-input-lens-settings';
  nextLensQuickSettingsRow.hidden = true;
  lensQuickSettingsRow = nextLensQuickSettingsRow;

  lensModelInput = document.createElement('input');
  lensModelInput.className = 'smart-input-lens-control smart-input-lens-model';
  lensModelInput.type = 'text';
  lensModelInput.placeholder = 'Default model';
  lensModelInput.autocomplete = 'off';
  lensModelInput.spellcheck = false;
  lensModelInput.addEventListener('input', () => {
    const sessionId = $activeSessionId.get();
    if (!sessionId || !isLensActiveSession(sessionId)) {
      return;
    }

    setLensQuickSettingsDraft(sessionId, {
      model: lensModelInput?.value ?? null,
    });
  });

  lensEffortSelect = document.createElement('select');
  lensEffortSelect.className = 'smart-input-lens-control';
  for (const [value, label] of [
    ['', 'Default'],
    ['low', 'Low'],
    ['medium', 'Medium'],
    ['high', 'High'],
  ] as const) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    lensEffortSelect.appendChild(option);
  }
  lensEffortSelect.addEventListener('change', () => {
    const sessionId = $activeSessionId.get();
    if (!sessionId || !isLensActiveSession(sessionId)) {
      return;
    }

    setLensQuickSettingsDraft(sessionId, {
      effort: lensEffortSelect?.value ?? null,
    });
  });

  lensPlanSelect = document.createElement('select');
  lensPlanSelect.className = 'smart-input-lens-control';
  for (const [value, label] of [
    ['off', 'Plan off'],
    ['on', 'Plan on'],
  ] as const) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    lensPlanSelect.appendChild(option);
  }
  lensPlanSelect.addEventListener('change', () => {
    const sessionId = $activeSessionId.get();
    if (!sessionId || !isLensActiveSession(sessionId)) {
      return;
    }

    setLensQuickSettingsDraft(sessionId, {
      planMode: lensPlanSelect?.value ?? 'off',
    });
  });

  lensPermissionSelect = document.createElement('select');
  lensPermissionSelect.className = 'smart-input-lens-control';
  for (const [value, label] of [
    ['manual', 'Manual'],
    ['auto', 'Auto'],
  ] as const) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    lensPermissionSelect.appendChild(option);
  }
  lensPermissionSelect.addEventListener('change', () => {
    const sessionId = $activeSessionId.get();
    if (!sessionId || !isLensActiveSession(sessionId)) {
      return;
    }

    setLensQuickSettingsDraft(sessionId, {
      permissionMode: lensPermissionSelect?.value ?? 'manual',
    });
  });

  nextLensQuickSettingsRow.appendChild(createLensQuickSettingsField('Model', lensModelInput));
  nextLensQuickSettingsRow.appendChild(createLensQuickSettingsField('Effort', lensEffortSelect));
  nextLensQuickSettingsRow.appendChild(createLensQuickSettingsField('Plan', lensPlanSelect));
  nextLensQuickSettingsRow.appendChild(
    createLensQuickSettingsField('Permissions', lensPermissionSelect),
  );

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
  autoSendBtn.hidden = !canUseSmartInputVoice();
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
    if (e.key === 'Escape' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const sessionId = $activeSessionId.get();
      if (sessionId && isLensActiveSession(sessionId)) {
        e.preventDefault();
        void handleLensEscape(sessionId);
        return;
      }
    }

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

  return { lensSettingsRow: nextLensQuickSettingsRow, inputRow };
}

function createDockedDOM(): void {
  dockedBar = document.createElement('div');
  dockedBar.className = 'smart-input-docked';

  const { lensSettingsRow, inputRow } = createInputElements();
  dockedBar.appendChild(inputRow);
  dockedBar.appendChild(lensSettingsRow);
  relocateDockedBar();
  updateAutoSendVisibility();
  syncVoiceInputAvailability();
  syncLensQuickSettingsControls();
}

function relocateDockedBar(): void {
  if (!dockedBar) return;
  const managerBar = document.getElementById('manager-bar');
  if (managerBar?.parentElement) {
    managerBar.parentElement.insertBefore(dockedBar, managerBar.nextSibling);
    return;
  }

  document.querySelector('.main-content')?.appendChild(dockedBar);
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
  syncLensQuickSettingsControls();
}

/**
 * Clears per-session drafts once a session is gone so text does not leak into a
 * future session that reuses the same UI slot.
 */
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
  const paddingTop = Number.parseFloat(computedStyle.paddingTop) || 0;
  const paddingBottom = Number.parseFloat(computedStyle.paddingBottom) || 0;
  const borderTop = Number.parseFloat(computedStyle.borderTopWidth) || 0;
  const borderBottom = Number.parseFloat(computedStyle.borderBottomWidth) || 0;
  const minHeight = Number.parseFloat(computedStyle.minHeight) || 0;
  const maxHeight =
    effectiveLineHeight * MAX_TEXTAREA_LINES +
    paddingTop +
    paddingBottom +
    borderTop +
    borderBottom;
  const contentHeight = textarea.scrollHeight + borderTop + borderBottom;
  const nextHeight = Math.max(minHeight, Math.min(contentHeight, maxHeight));

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
  const autoSendBtn = dockedBar?.querySelector(
    '.smart-input-autosend-btn',
  ) as HTMLButtonElement | null;
  if (!micBtn && !autoSendBtn) {
    return;
  }

  const enabled = canUseSmartInputVoice();
  if (micBtn) {
    micBtn.hidden = !enabled;
  }
  if (autoSendBtn) {
    autoSendBtn.hidden = !enabled;
  }
  if (!enabled && isRecording) {
    endRecording();
  }

  updateAutoSendVisibility();
}

function updateAutoSendVisibility(): void {
  for (const container of [dockedBar]) {
    if (!container) continue;
    container.classList.toggle('autosend-active', autoSendEnabled && canUseSmartInputVoice());
  }
}

function createLensQuickSettingsField(
  labelText: string,
  control: HTMLInputElement | HTMLSelectElement,
): HTMLLabelElement {
  const field = document.createElement('label');
  field.className = 'smart-input-lens-field';

  const label = document.createElement('span');
  label.className = 'smart-input-lens-label';
  label.textContent = labelText;

  field.appendChild(label);
  field.appendChild(control);
  return field;
}

function syncLensQuickSettingsControls(): void {
  if (
    !lensQuickSettingsRow ||
    !lensModelInput ||
    !lensEffortSelect ||
    !lensPlanSelect ||
    !lensPermissionSelect
  ) {
    return;
  }

  const visibilityState = getSmartInputVisibilityState();
  if (!shouldShowLensQuickSettings(visibilityState)) {
    if (dockedBar) {
      dockedBar.dataset.lensSession = 'false';
    }
    lensQuickSettingsRow.hidden = true;
    delete lensQuickSettingsRow.dataset.provider;
    return;
  }

  const sessionId = visibilityState.activeSessionId as string;
  const provider = getLensQuickSettingsProvider(sessionId);
  const draft = getLensQuickSettingsDraft(sessionId);
  if (dockedBar) {
    dockedBar.dataset.lensSession = 'true';
  }
  lensQuickSettingsRow.hidden = false;
  lensQuickSettingsRow.dataset.provider = provider ?? '';

  const modelPlaceholder =
    provider === 'claude'
      ? 'Default Claude model'
      : provider === 'codex'
        ? 'Default Codex model'
        : 'Default model';
  if (lensModelInput.placeholder !== modelPlaceholder) {
    lensModelInput.placeholder = modelPlaceholder;
  }

  const modelValue = draft.model ?? '';
  if (lensModelInput.value !== modelValue) {
    lensModelInput.value = modelValue;
  }

  const effortValue = draft.effort ?? '';
  if (lensEffortSelect.value !== effortValue) {
    lensEffortSelect.value = effortValue;
  }

  if (lensPlanSelect.value !== draft.planMode) {
    lensPlanSelect.value = draft.planMode;
  }

  if (lensPermissionSelect.value !== draft.permissionMode) {
    lensPermissionSelect.value = draft.permissionMode;
  }
}

async function submitSmartInput(sessionId: string, text: string): Promise<void> {
  await submitSessionText(sessionId, text);
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
