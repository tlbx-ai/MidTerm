/**
 * Smart Input UI
 *
 * Owns the unified active-session footer dock for Terminal and Lens.
 * The dock can expose an input row, a mode-specific context row,
 * manager automation, and a status rail without splitting those concerns
 * into unrelated sibling bars.
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
import { shouldShowManagerBar } from '../managerBar/visibility';
import { onTabActivated } from '../sessionTabs';
import { isDevMode, onDevModeChanged } from '../sidebar/voiceSection';
import { handleFileDrop } from '../terminal';
import { shouldShowTouchController } from '../touchController/detection';
import {
  ADAPTIVE_FOOTER_RESERVED_HEIGHT_CHANGED_EVENT,
  calculateAdaptiveFooterReservedHeight,
  getAdaptiveFooterRailSequence,
} from './layout';
import { startTranscription, stopTranscription } from './transcription';
import {
  shouldShowDockedSmartInput,
  shouldShowLensQuickSettings,
  type SmartInputVisibilityState,
} from './visibility';

let footerDock: HTMLDivElement | null = null;
let footerPrimaryHost: HTMLDivElement | null = null;
let footerContextHost: HTMLDivElement | null = null;
let footerStatusHost: HTMLDivElement | null = null;
let dockedBar: HTMLDivElement | null = null;
let touchControllerEl: HTMLElement | null = null;
let activeTextarea: HTMLTextAreaElement | null = null;
let activeMicBtn: HTMLButtonElement | null = null;
let sendBtn: HTMLButtonElement | null = null;
let toolsToggleBtn: HTMLButtonElement | null = null;
let toolsPanel: HTMLDivElement | null = null;
let toolButtonsStrip: HTMLDivElement | null = null;
let lensQuickSettingsRow: HTMLDivElement | null = null;
let lensModelInput: HTMLInputElement | null = null;
let lensEffortSelect: HTMLSelectElement | null = null;
let lensPlanSelect: HTMLSelectElement | null = null;
let lensPermissionSelect: HTMLSelectElement | null = null;
let lensSettingsSummaryBtn: HTMLButtonElement | null = null;
let autoSendEnabled = localStorage.getItem('smartinput-autosend') === 'true';
let keysExpanded = localStorage.getItem('smartinput-keys-expanded') === 'true';
let isRecording = false;
let lastSessionId: string | null = null;
let lensQuickSettingsSheetOpen = false;
let sendAutoSendLongPressTimer: number | null = null;
let suppressNextSendClick = false;
let footerResizeQueued = false;
let footerResizeObserver: ResizeObserver | null = null;
let lastReservedFooterHeightPx = Number.NaN;

const MAX_TEXTAREA_LINES = 5;
const AUTO_SEND_LONG_PRESS_MS = 520;
const MOBILE_BREAKPOINT_PX = 768;
const sessionDrafts = new Map<string, string>();

interface AdaptiveFooterLayoutState {
  activeSessionId: string | null | undefined;
  lensActive: boolean;
  showInput: boolean;
  showAutomation: boolean;
  showContext: boolean;
  showStatus: boolean;
  showFooter: boolean;
  isMobile: boolean;
  glassEnabled: boolean;
  inputMode: string | null | undefined;
  touchControlsAvailable: boolean;
  touchControlsExpanded: boolean;
}

function getSmartInputVisibilityState(): SmartInputVisibilityState {
  const activeSessionId = $activeSessionId.get();
  return {
    activeSessionId,
    inputMode: $currentSettings.get()?.inputMode,
    lensActive: isLensActiveSession(activeSessionId),
  };
}

function getAdaptiveFooterLayoutState(): AdaptiveFooterLayoutState {
  const visibilityState = getSmartInputVisibilityState();
  const settings = $currentSettings.get();
  const activeSessionId = visibilityState.activeSessionId;
  const isMobile = isMobileViewport();
  const lensActive = visibilityState.lensActive;
  const showInput = shouldShowDockedSmartInput(visibilityState);
  const showAutomation = shouldShowManagerBar(settings?.managerBarEnabled, activeSessionId);
  const touchControlsAvailable =
    Boolean(activeSessionId) && !lensActive && isMobile && shouldShowTouchController();
  const showContext = lensActive ? isMobile : touchControlsAvailable && keysExpanded;
  const showStatus = lensActive || (Boolean(activeSessionId) && (isMobile || showInput));
  const showFooter =
    Boolean(activeSessionId) && (showInput || showAutomation || showContext || showStatus);
  const transparency = settings?.terminalTransparency ?? settings?.uiTransparency ?? 0;

  return {
    activeSessionId,
    lensActive,
    showInput,
    showAutomation,
    showContext,
    showStatus,
    showFooter,
    isMobile,
    glassEnabled: !isMobile && transparency > 0,
    inputMode: settings?.inputMode,
    touchControlsAvailable,
    touchControlsExpanded: touchControlsAvailable && keysExpanded,
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

/**
 * Keeps the footer dock aligned with session changes, Lens activation, mobile
 * touch controls, and dev-only voice affordances.
 */
export function initSmartInput(): void {
  ensureFooterHosts();

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
      syncSmartInputVisibility();
    });
    window.addEventListener('resize', () => {
      syncSmartInputVisibility();
    });
    window.addEventListener('orientationchange', () => {
      syncSmartInputVisibility();
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
    if (e.code === 'ControlRight') {
      if (!getAdaptiveFooterLayoutState().showInput) return;
      if (!canUseSmartInputVoice()) return;
      if (isRecording) return;
      e.preventDefault();
      beginRecording();
      return;
    }

    if (e.key === 'Escape' && closeFooterTransientUi()) {
      e.preventDefault();
    }
  });

  document.addEventListener('keyup', (e) => {
    if (e.code !== 'ControlRight') return;
    if (!isRecording) return;
    e.preventDefault();
    endRecording();
  });

  document.addEventListener('click', (event) => {
    const target = event.target as Node | null;
    if (!target) {
      return;
    }

    if (toolsPanel && toolsToggleBtn) {
      const clickedInsideTools = toolsPanel.contains(target) || toolsToggleBtn.contains(target);
      if (!clickedInsideTools) {
        setToolsPanelOpen(false);
      }
    }

    if (lensQuickSettingsRow && lensSettingsSummaryBtn) {
      const clickedInsideLensSettings =
        lensQuickSettingsRow.contains(target) || lensSettingsSummaryBtn.contains(target);
      if (!clickedInsideLensSettings) {
        setLensQuickSettingsSheetOpen(false);
      }
    }
  });
}

export function showSmartInput(): void {
  syncSmartInputVisibility(true);
}

export function hideSmartInput(): void {
  syncSmartInputVisibility();
}

function syncSmartInputVisibility(focusTextarea: boolean = false): void {
  ensureFooterHosts();

  const layoutState = getAdaptiveFooterLayoutState();
  if (!layoutState.showFooter) {
    hideAdaptiveFooter();
    queueFooterReserveSync();
    return;
  }

  if (!dockedBar) {
    createDockedDOM();
  }

  applyFooterPresentation(layoutState);
  syncInputRow(layoutState);
  syncContextRow(layoutState);

  const managerBar = document.getElementById('manager-bar');
  managerBar?.classList.toggle('hidden', !layoutState.showAutomation);
  syncFooterRailOrder(layoutState);
  syncStatusRow(layoutState);
  footerDock?.toggleAttribute('hidden', false);

  syncVoiceInputAvailability();
  updateAutoSendVisibility();
  queueFooterReserveSync();

  if (focusTextarea && layoutState.showInput) {
    activeTextarea?.focus({ preventScroll: true });
  }
}

function hideAdaptiveFooter(): void {
  if (!footerDock) {
    return;
  }

  setToolsPanelOpen(false);
  setLensQuickSettingsSheetOpen(false);
  footerDock.hidden = true;
  footerPrimaryHost?.setAttribute('hidden', '');
  footerContextHost?.setAttribute('hidden', '');
  footerStatusHost?.setAttribute('hidden', '');
}

function ensureFooterHosts(): void {
  footerDock ??= document.getElementById('adaptive-footer-dock') as HTMLDivElement | null;
  footerPrimaryHost ??= document.getElementById('adaptive-footer-primary') as HTMLDivElement | null;
  footerContextHost ??= document.getElementById('adaptive-footer-context') as HTMLDivElement | null;
  footerStatusHost ??= document.getElementById('adaptive-footer-status') as HTMLDivElement | null;
  ensureFooterResizeObserver();
}

function ensureFooterResizeObserver(): void {
  if (footerResizeObserver || typeof ResizeObserver === 'undefined' || !footerDock) {
    return;
  }

  footerResizeObserver = new ResizeObserver(() => {
    queueFooterReserveSync();
  });
  footerResizeObserver.observe(footerDock);
}

function applyFooterPresentation(layoutState: AdaptiveFooterLayoutState): void {
  if (!footerDock) {
    return;
  }

  footerDock.dataset.surface = layoutState.lensActive ? 'lens' : 'terminal';
  footerDock.dataset.device = layoutState.isMobile ? 'mobile' : 'desktop';
  footerDock.dataset.material = layoutState.glassEnabled ? 'glass' : 'solid';
  footerDock.dataset.inputMode = layoutState.inputMode ?? 'keyboard';
  footerDock.classList.toggle('keys-expanded', layoutState.touchControlsExpanded);
}

function createDockedDOM(): void {
  ensureFooterHosts();
  if (!footerPrimaryHost || !footerContextHost || !footerStatusHost) {
    return;
  }

  dockedBar = document.createElement('div');
  dockedBar.className = 'smart-input-docked';

  const { inputRow, toolsStrip, toolsSurface } = createInputElements();
  dockedBar.appendChild(toolsSurface);
  dockedBar.appendChild(inputRow);
  footerPrimaryHost.appendChild(dockedBar);

  toolButtonsStrip = toolsStrip;
  if (toolsPanel) {
    toolsPanel.appendChild(toolButtonsStrip);
  }

  touchControllerEl ??= document.getElementById('touch-controller');
  if (touchControllerEl && touchControllerEl.parentElement !== footerContextHost) {
    footerContextHost.appendChild(touchControllerEl);
    touchControllerEl.classList.add('embedded');
  }
}

function createInputElements(): {
  inputRow: HTMLDivElement;
  toolsStrip: HTMLDivElement;
  toolsSurface: HTMLDivElement;
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
    syncSmartInputVisibility();
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

  const textarea = document.createElement('textarea');
  textarea.className = 'smart-input-textarea';
  textarea.rows = 1;
  textarea.placeholder = t('smartInput.placeholder');
  resizeTextarea(textarea);

  const nextSendBtn = document.createElement('button');
  nextSendBtn.type = 'button';
  nextSendBtn.className = 'smart-input-send-btn';
  nextSendBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>';
  nextSendBtn.title = t('smartInput.sendGestureHint');
  nextSendBtn.setAttribute('aria-label', t('smartInput.send'));
  sendBtn = nextSendBtn;

  const nextToolsToggleBtn = document.createElement('button');
  nextToolsToggleBtn.type = 'button';
  nextToolsToggleBtn.className = 'smart-input-tools-toggle';
  nextToolsToggleBtn.textContent = '+';
  nextToolsToggleBtn.title = t('smartInput.tools');
  nextToolsToggleBtn.setAttribute('aria-label', t('smartInput.tools'));
  toolsToggleBtn = nextToolsToggleBtn;

  const toolsSurface = document.createElement('div');
  toolsSurface.className = 'smart-input-tools-surface';
  toolsSurface.hidden = true;
  toolsPanel = toolsSurface;

  const toolsStrip = createToolButtonsStrip();

  nextToolsToggleBtn.addEventListener('click', () => {
    setToolsPanelOpen(!(toolsPanel?.hidden === false));
  });

  textarea.addEventListener('input', () => {
    persistDraftForSession($activeSessionId.get(), textarea.value);
    resizeTextarea(textarea);
    if (!footerResizeObserver) {
      queueFooterReserveSync();
    }
  });

  textarea.addEventListener('focus', () => {
    queueFooterReserveSync();
    requestAnimationFrame(() => {
      footerDock?.scrollTo({ top: 0, behavior: 'auto' });
    });
  });

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

  nextSendBtn.addEventListener('dblclick', (event) => {
    if (isMobileViewport()) {
      return;
    }

    event.preventDefault();
    toggleAutoSendEnabled();
  });

  nextSendBtn.addEventListener('pointerdown', () => {
    if (!isMobileViewport()) {
      return;
    }

    clearSendAutoSendLongPressTimer();
    sendAutoSendLongPressTimer = window.setTimeout(() => {
      toggleAutoSendEnabled();
      suppressNextSendClick = true;
      sendAutoSendLongPressTimer = null;
    }, AUTO_SEND_LONG_PRESS_MS);
  });

  for (const eventName of ['pointerup', 'pointercancel', 'pointerleave']) {
    nextSendBtn.addEventListener(eventName, () => {
      clearSendAutoSendLongPressTimer();
    });
  }

  nextSendBtn.addEventListener('click', () => {
    if (suppressNextSendClick) {
      suppressNextSendClick = false;
      return;
    }

    sendText(textarea);
  });

  inputRow.appendChild(textarea);
  inputRow.appendChild(nextToolsToggleBtn);
  inputRow.appendChild(nextSendBtn);

  return { inputRow, toolsStrip, toolsSurface };
}

function createToolButtonsStrip(): HTMLDivElement {
  const strip = document.createElement('div');
  strip.className = 'smart-input-tools-strip';

  const micBtn = document.createElement('button');
  micBtn.type = 'button';
  micBtn.className = 'smart-input-mic-btn';
  micBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>';
  micBtn.title = t('smartInput.mic');
  micBtn.hidden = !canUseSmartInputVoice();
  activeMicBtn = micBtn;

  micBtn.addEventListener('pointerdown', (event) => {
    event.preventDefault();
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

  const photoBtn = document.createElement('button');
  photoBtn.type = 'button';
  photoBtn.className = 'smart-input-photo-btn';
  photoBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4z"/><path d="M9 2 7.17 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2h-3.17L15 2H9zm3 15c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5z"/></svg>';
  photoBtn.title = t('smartInput.photo');

  const photoInput = document.createElement('input');
  photoInput.type = 'file';
  photoInput.accept = 'image/*';
  photoInput.capture = 'environment';
  photoInput.hidden = true;

  photoBtn.addEventListener('click', () => {
    if (isTouchPrimaryDevice()) {
      photoInput.click();
      return;
    }

    void captureFromWebcam();
  });
  photoInput.addEventListener('change', () => {
    if (photoInput.files?.length) {
      void handleFileDrop(photoInput.files);
    }
    photoInput.value = '';
  });

  const attachBtn = document.createElement('button');
  attachBtn.type = 'button';
  attachBtn.className = 'smart-input-attach-btn';
  attachBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5a2.5 2.5 0 0 1 5 0v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5a2.5 2.5 0 0 0 5 0V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z"/></svg>';
  attachBtn.title = t('smartInput.attach');

  const attachInput = document.createElement('input');
  attachInput.type = 'file';
  attachInput.multiple = true;
  attachInput.hidden = true;

  attachBtn.addEventListener('click', () => {
    attachInput.click();
  });
  attachInput.addEventListener('change', () => {
    if (attachInput.files?.length) {
      void handleFileDrop(attachInput.files);
    }
    attachInput.value = '';
  });

  strip.appendChild(micBtn);
  strip.appendChild(photoBtn);
  strip.appendChild(photoInput);
  strip.appendChild(attachBtn);
  strip.appendChild(attachInput);
  return strip;
}

function syncInputRow(layoutState: AdaptiveFooterLayoutState): void {
  if (!footerPrimaryHost || !dockedBar) {
    return;
  }

  footerPrimaryHost.toggleAttribute('hidden', !layoutState.showInput);
  dockedBar.classList.toggle('visible', layoutState.showInput);

  if (!layoutState.showInput) {
    setToolsPanelOpen(false);
    return;
  }

  dockedBar.dataset.surface = layoutState.lensActive ? 'lens' : 'terminal';
  dockedBar.dataset.device = layoutState.isMobile ? 'mobile' : 'desktop';

  activeTextarea = dockedBar.querySelector('.smart-input-textarea');
  if (activeTextarea) {
    applyDraftToTextarea(activeTextarea, layoutState.activeSessionId ?? null);
  }

  const toolsInlineInContext = layoutState.lensActive && layoutState.isMobile;
  toolsToggleBtn?.toggleAttribute('hidden', toolsInlineInContext);
  if (toolsInlineInContext) {
    setToolsPanelOpen(false);
  }
}

function syncContextRow(layoutState: AdaptiveFooterLayoutState): void {
  if (!footerContextHost) {
    return;
  }

  footerContextHost.replaceChildren();

  if (layoutState.lensActive && layoutState.isMobile) {
    if (toolButtonsStrip) {
      footerContextHost.appendChild(toolButtonsStrip);
    }
    footerContextHost.hidden = false;
    return;
  }

  if (toolButtonsStrip && toolsPanel && toolButtonsStrip.parentElement !== toolsPanel) {
    toolsPanel.appendChild(toolButtonsStrip);
  }

  if (layoutState.showContext && layoutState.touchControlsAvailable) {
    if (touchControllerEl) {
      touchControllerEl.classList.add('embedded', 'visible');
      footerContextHost.appendChild(touchControllerEl);
      footerContextHost.hidden = false;
      return;
    }
  }

  touchControllerEl?.classList.remove('visible');
  footerContextHost.hidden = true;
}

function syncFooterRailOrder(layoutState: AdaptiveFooterLayoutState): void {
  if (!footerDock || !footerPrimaryHost || !footerContextHost || !footerStatusHost) {
    return;
  }

  const managerBar = document.getElementById('manager-bar');
  if (!managerBar) {
    return;
  }

  const rails = {
    primary: footerPrimaryHost,
    automation: managerBar,
    context: footerContextHost,
    status: footerStatusHost,
  } satisfies Record<ReturnType<typeof getAdaptiveFooterRailSequence>[number], HTMLElement>;

  for (const key of getAdaptiveFooterRailSequence(layoutState)) {
    footerDock.appendChild(rails[key]);
  }
}

function syncStatusRow(layoutState: AdaptiveFooterLayoutState): void {
  if (!footerStatusHost) {
    return;
  }

  footerStatusHost.replaceChildren();
  footerStatusHost.classList.remove('adaptive-footer-status-sheet-open');
  footerStatusHost.toggleAttribute('hidden', !layoutState.showStatus);
  syncLensQuickSettingsControls();

  if (!layoutState.showStatus || !layoutState.activeSessionId) {
    setLensQuickSettingsSheetOpen(false);
    return;
  }

  if (layoutState.lensActive) {
    renderLensStatusRow(layoutState);
    return;
  }

  renderTerminalStatusRow(layoutState);
}

function renderLensStatusRow(layoutState: AdaptiveFooterLayoutState): void {
  if (
    !footerStatusHost ||
    !lensQuickSettingsRow ||
    !lensModelInput ||
    !lensEffortSelect ||
    !lensPlanSelect ||
    !lensPermissionSelect
  ) {
    return;
  }

  const sessionId = layoutState.activeSessionId as string;
  const provider = getLensQuickSettingsProvider(sessionId);
  const draft = getLensQuickSettingsDraft(sessionId);

  if (!layoutState.isMobile) {
    const heading = document.createElement('div');
    heading.className = 'adaptive-footer-status-label';
    heading.textContent = formatLensProviderLabel(provider);
    footerStatusHost.appendChild(heading);
    lensQuickSettingsRow.classList.remove('smart-input-lens-settings-sheet');
    lensQuickSettingsRow.hidden = false;
    footerStatusHost.appendChild(lensQuickSettingsRow);
    return;
  }

  const summaryBtn = document.createElement('button');
  summaryBtn.type = 'button';
  summaryBtn.className = 'adaptive-footer-status-summary adaptive-footer-status-summary-lens';
  summaryBtn.textContent = formatLensQuickSettingsSummary(provider, draft);
  summaryBtn.dataset.planMode = draft.planMode;
  summaryBtn.setAttribute('aria-expanded', lensQuickSettingsSheetOpen ? 'true' : 'false');
  summaryBtn.addEventListener('click', () => {
    setLensQuickSettingsSheetOpen(!lensQuickSettingsSheetOpen);
  });
  lensSettingsSummaryBtn = summaryBtn;
  footerStatusHost.appendChild(summaryBtn);

  lensQuickSettingsRow.classList.add('smart-input-lens-settings-sheet');
  lensQuickSettingsRow.hidden = !lensQuickSettingsSheetOpen;
  if (lensQuickSettingsSheetOpen) {
    footerStatusHost.classList.add('adaptive-footer-status-sheet-open');
    footerStatusHost.appendChild(lensQuickSettingsRow);
  }
}

function renderTerminalStatusRow(layoutState: AdaptiveFooterLayoutState): void {
  if (!footerStatusHost) {
    return;
  }

  const summary = document.createElement('div');
  summary.className = 'adaptive-footer-status-summary';
  summary.textContent = describeTerminalStatus(layoutState.inputMode);
  footerStatusHost.appendChild(summary);

  if (canUseSmartInputVoice() && autoSendEnabled) {
    const autoSendPill = document.createElement('div');
    autoSendPill.className = 'adaptive-footer-status-pill';
    autoSendPill.textContent = t('smartInput.autoSend');
    footerStatusHost.appendChild(autoSendPill);
  }

  if (layoutState.isMobile && layoutState.touchControlsAvailable) {
    const keysToggle = document.createElement('button');
    keysToggle.type = 'button';
    keysToggle.className = 'adaptive-footer-status-toggle';
    keysToggle.textContent = keysExpanded ? t('smartInput.keysHide') : t('smartInput.keysShow');
    keysToggle.setAttribute('aria-pressed', keysExpanded ? 'true' : 'false');
    keysToggle.addEventListener('click', () => {
      keysExpanded = !keysExpanded;
      localStorage.setItem('smartinput-keys-expanded', String(keysExpanded));
      syncSmartInputVisibility();
    });
    footerStatusHost.appendChild(keysToggle);
  }
}

function describeTerminalStatus(inputMode: string | null | undefined): string {
  if (inputMode === 'smartinput') {
    return t('smartInput.modeSmart');
  }

  if (inputMode === 'both') {
    return t('smartInput.modeBoth');
  }

  return t('smartInput.modeKeyboard');
}

function formatLensProviderLabel(provider: string | null): string {
  if (provider === 'claude') {
    return 'Claude';
  }
  if (provider === 'codex') {
    return 'Codex';
  }
  return 'Lens';
}

function formatLensQuickSettingsSummary(
  provider: string | null,
  draft: ReturnType<typeof getLensQuickSettingsDraft>,
): string {
  const parts = [
    formatLensProviderLabel(provider),
    draft.model?.trim() || 'Default',
    draft.effort?.trim() || 'Default',
    draft.planMode === 'on' ? 'PLAN ON' : 'Plan Off',
  ];
  return parts.join(' · ');
}

function setToolsPanelOpen(open: boolean): void {
  if (!toolsPanel || !toolsToggleBtn) {
    return;
  }

  const canOpen = Boolean(toolButtonsStrip) && !toolsToggleBtn.hidden;
  const shouldOpen = open && canOpen;
  toolsPanel.hidden = !shouldOpen;
  toolsToggleBtn.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
  if (!footerResizeObserver) {
    queueFooterReserveSync();
  }
}

function setLensQuickSettingsSheetOpen(open: boolean): void {
  lensQuickSettingsSheetOpen = open;
  if (lensSettingsSummaryBtn) {
    lensSettingsSummaryBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  if (lensQuickSettingsRow) {
    lensQuickSettingsRow.hidden = !open;
  }
  if (!footerResizeObserver) {
    queueFooterReserveSync();
  }
}

function closeFooterTransientUi(): boolean {
  let closedAny = false;

  if (toolsPanel && !toolsPanel.hidden) {
    setToolsPanelOpen(false);
    closedAny = true;
  }

  if (lensQuickSettingsSheetOpen) {
    setLensQuickSettingsSheetOpen(false);
    closedAny = true;
  }

  return closedAny;
}

function clearSendAutoSendLongPressTimer(): void {
  if (sendAutoSendLongPressTimer !== null) {
    window.clearTimeout(sendAutoSendLongPressTimer);
    sendAutoSendLongPressTimer = null;
  }
}

function toggleAutoSendEnabled(): void {
  if (!canUseSmartInputVoice()) {
    return;
  }

  autoSendEnabled = !autoSendEnabled;
  localStorage.setItem('smartinput-autosend', String(autoSendEnabled));
  updateAutoSendVisibility();
  syncSmartInputVisibility();
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
  if (!footerResizeObserver) {
    queueFooterReserveSync();
  }
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
  applyDraftToTextarea(activeTextarea, sessionId);
  syncLensQuickSettingsControls();
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
  const enabled = canUseSmartInputVoice();
  if (activeMicBtn) {
    activeMicBtn.hidden = !enabled;
  }

  if (!enabled && isRecording) {
    endRecording();
  }

  updateAutoSendVisibility();
}

function updateAutoSendVisibility(): void {
  const active = autoSendEnabled && canUseSmartInputVoice();
  dockedBar?.classList.toggle('autosend-active', active);
  sendBtn?.classList.toggle('autosend-latched', active);
  if (sendBtn) {
    sendBtn.setAttribute('data-autosend', active ? 'true' : 'false');
    sendBtn.title = active ? t('smartInput.autoSendOnHint') : t('smartInput.sendGestureHint');
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
    setLensQuickSettingsSheetOpen(false);
    return;
  }

  const sessionId = visibilityState.activeSessionId as string;
  const provider = getLensQuickSettingsProvider(sessionId);
  const draft = getLensQuickSettingsDraft(sessionId);
  if (dockedBar) {
    dockedBar.dataset.lensSession = 'true';
  }
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

  if (lensSettingsSummaryBtn) {
    lensSettingsSummaryBtn.textContent = formatLensQuickSettingsSummary(provider, draft);
    lensSettingsSummaryBtn.dataset.planMode = draft.planMode;
  }
}

function queueFooterReserveSync(): void {
  if (footerResizeQueued) {
    return;
  }

  footerResizeQueued = true;
  requestAnimationFrame(() => {
    footerResizeQueued = false;
    updateFooterReservedHeight();
  });
}

function updateFooterReservedHeight(): void {
  const root = document.documentElement;
  if (!footerDock || footerDock.hidden) {
    setAdaptiveFooterReservedHeight(root, 0);
    return;
  }

  const textareaHeight = activeTextarea?.offsetHeight ?? null;
  const collapsedTextareaHeight = activeTextarea
    ? getCollapsedTextareaHeight(activeTextarea)
    : null;
  const reserveHeight = calculateAdaptiveFooterReservedHeight({
    dockHeight: footerDock.offsetHeight,
    textareaHeight,
    collapsedTextareaHeight,
  });

  setAdaptiveFooterReservedHeight(root, reserveHeight);
}

function setAdaptiveFooterReservedHeight(root: HTMLElement, reserveHeight: number): void {
  const normalizedReserveHeight = Math.max(0, Math.round(reserveHeight));
  root.style.setProperty('--adaptive-footer-reserved-height', `${String(normalizedReserveHeight)}px`);

  if (lastReservedFooterHeightPx === normalizedReserveHeight) {
    return;
  }

  lastReservedFooterHeightPx = normalizedReserveHeight;
  window.dispatchEvent(
    new CustomEvent(ADAPTIVE_FOOTER_RESERVED_HEIGHT_CHANGED_EVENT, {
      detail: { reservedHeightPx: normalizedReserveHeight },
    }),
  );
}

function getCollapsedTextareaHeight(textarea: HTMLTextAreaElement): number {
  const computedStyle = getComputedStyle(textarea);
  const configuredMinHeight = Number.parseFloat(computedStyle.minHeight);
  if (Number.isFinite(configuredMinHeight) && configuredMinHeight > 0) {
    return configuredMinHeight;
  }

  const lineHeight = Number.parseFloat(computedStyle.lineHeight);
  const fallbackFontSize = Number.parseFloat(computedStyle.fontSize) || 16;
  const effectiveLineHeight = Number.isFinite(lineHeight) ? lineHeight : fallbackFontSize * 1.2;
  const paddingTop = Number.parseFloat(computedStyle.paddingTop) || 0;
  const paddingBottom = Number.parseFloat(computedStyle.paddingBottom) || 0;
  const borderTop = Number.parseFloat(computedStyle.borderTopWidth) || 0;
  const borderBottom = Number.parseFloat(computedStyle.borderBottomWidth) || 0;

  return effectiveLineHeight + paddingTop + paddingBottom + borderTop + borderBottom;
}

async function submitSmartInput(sessionId: string, text: string): Promise<void> {
  await submitSessionText(sessionId, text);
}

function isMobileViewport(): boolean {
  return window.matchMedia(`(max-width: ${String(MOBILE_BREAKPOINT_PX)}px)`).matches;
}

function isTouchPrimaryDevice(): boolean {
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
