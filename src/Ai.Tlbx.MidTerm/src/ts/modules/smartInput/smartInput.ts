/**
 * Smart Input UI
 *
 * The dock can expose an input row, a mode-specific context row,
 * manager automation, and a status rail without splitting those concerns
 * into unrelated sibling bars.
 */

import {
  $currentSettings,
  $activeSessionId,
  $settingsOpen,
  $voiceServerPassword,
} from '../../stores';
import { t } from '../i18n';
import { submitSessionText } from '../input/submit';
import {
  createLensTurnRequest,
  handleLensEscape,
  hasInterruptibleLensTurnWork,
  isLensActiveSession,
  submitQueuedLensTurn,
} from '../lens/input';
import {
  LENS_QUICK_SETTINGS_CHANGED_EVENT,
  getLensQuickSettingsDraft,
  setLensQuickSettingsDraft,
} from '../lens/quickSettings';
import { shouldShowManagerBar } from '../managerBar/visibility';
import { onTabActivated } from '../sessionTabs';
import { onDevModeChanged } from '../sidebar/voiceSection';
import { handleFileDrop, showDropToast, uploadFile } from '../terminal';
import { shouldShowTouchController } from '../touchController/detection';
import { getAdaptiveFooterRailSequence } from './layout';
import {
  type LensComposerDraftAttachment,
  MAX_LENS_IMAGE_BYTES,
  createLensComposerDraftAttachment,
  isLensComposerImageFile,
  releaseLensComposerDraftAttachmentPreviews,
} from './lensAttachments';
import { submitLensComposerDraft } from './lensAttachmentSubmission';
import { startTranscription, stopTranscription } from './transcription';
import { shouldShowDockedSmartInput, type SmartInputVisibilityState } from './visibility';
import { captureImageFromWebcam } from './cameraCapture';
import { renderLensAttachmentDraftView } from './attachmentDraftView';
import {
  createSmartInputDom,
  createToolButton,
  createToolButtonsStrip,
  formatLensQuickSettingsSummary,
  openFileInputPicker as showSmartInputFilePicker,
  renderTerminalStatusRow,
  type ToolKind,
} from './smartInputView';
import {
  applySessionDraftToTextarea,
  clearLensDraftAttachmentsForSession,
  detachLensDraftAttachmentsForSession,
  getLensDraftAttachmentsForSession,
  persistSessionDraft,
  setLensDraftAttachmentsForSession,
} from './smartInputDraftStore';
import {
  isMobileViewport,
  isTouchPrimaryDevice,
  resizeSmartInputTextarea,
} from './smartInputMetrics';
import type { ResumeProvider } from '../providerResume';
import { bindSmartInputGlobalKeyBindings } from './smartInputKeyBindings';
import {
  canUseSmartInputVoice as canUseSmartInputVoiceSupport,
  getMicButtons as getMicButtonsSupport,
  queueFooterReserveSync as queueFooterReserveSyncSupport,
  syncLensQuickSettingsControls as syncLensQuickSettingsControlsSupport,
  syncVoiceInputAvailability as syncVoiceInputAvailabilitySupport,
  updateAutoSendVisibility as updateAutoSendVisibilitySupport,
  updateFooterReservedHeight as updateFooterReservedHeightSupport,
} from './footerSupport';
import { createLensResumeButton } from './lensResumeButton';
import {
  insertSmartInputLineBreak,
  shouldInsertLineBreakOnEnter,
  shouldSubmitSmartInputOnEnter,
} from './enterBehavior';

let footerDock: HTMLDivElement | null = null;
let footerPrimaryHost: HTMLDivElement | null = null;
let footerContextHost: HTMLDivElement | null = null;
let footerStatusHost: HTMLDivElement | null = null;
let dockedBar: HTMLDivElement | null = null;
let touchControllerEl: HTMLElement | null = null;
let activeTextarea: HTMLTextAreaElement | null = null;
let sendBtn: HTMLButtonElement | null = null;
let toolsToggleBtn: HTMLButtonElement | null = null;
let toolsPanel: HTMLDivElement | null = null;
let toolButtonsStrip: HTMLDivElement | null = null;
let inlineToolHost: HTMLDivElement | null = null;
let lensAttachmentHost: HTMLDivElement | null = null;
let sharedPhotoInput: HTMLInputElement | null = null;
let sharedAttachInput: HTMLInputElement | null = null;
let toolsPanelOpen = false;
let lensQuickSettingsRow: HTMLDivElement | null = null;
let lensQuickSettingsActions: HTMLDivElement | null = null;
let lensModelSelect: HTMLSelectElement | null = null;
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
let suppressNextToolsToggleClick = false;
let footerResizeQueued = false;
let footerResizeObserver: ResizeObserver | null = null;
let lastReservedFooterHeightPx = Number.NaN;

const AUTO_SEND_LONG_PRESS_MS = 520;
const sessionDrafts = new Map<string, string>();
const lensAttachmentDrafts = new Map<string, LensComposerDraftAttachment[]>();
const sessionPinnedTools = new Map<string, ToolKind[]>();
let lensResumeConversationHandler:
  | ((args: {
      sessionId: string;
      provider: ResumeProvider;
      workingDirectory: string;
    }) => void | Promise<void>)
  | null = null;

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

export function setLensResumeConversationHandler(
  handler:
    | ((args: {
        sessionId: string;
        provider: ResumeProvider;
        workingDirectory: string;
      }) => void | Promise<void>)
    | null,
): void {
  lensResumeConversationHandler = handler;
  syncSmartInputVisibility();
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
  const settingsOpen = $settingsOpen.get();
  const activeSessionId = visibilityState.activeSessionId ?? null;
  const isMobile = isMobileViewport();
  const lensActive = visibilityState.lensActive;
  const showInput = !settingsOpen && shouldShowDockedSmartInput(visibilityState);
  const showAutomation =
    !settingsOpen && shouldShowManagerBar(settings?.managerBarEnabled, activeSessionId);
  const touchControlsAvailable = resolveTouchControlsAvailable({
    activeSessionId,
    isMobile,
    lensActive,
  });
  const showContext = settingsOpen
    ? false
    : resolveShowContext({
        isMobile,
        lensActive,
        touchControlsAvailable,
      });
  const showStatus = settingsOpen
    ? false
    : resolveShowStatus({
        activeSessionId,
        isMobile,
        lensActive,
        showInput,
      });
  const showFooter = settingsOpen
    ? false
    : resolveShowFooter({
        activeSessionId,
        showAutomation,
        showContext,
        showInput,
        showStatus,
      });
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

function setFooterResizeQueued(queued: boolean): void {
  footerResizeQueued = queued;
}

function setLastReservedFooterHeightPx(value: number): void {
  lastReservedFooterHeightPx = value;
}

function resolveTouchControlsAvailable(args: {
  activeSessionId: string | null;
  isMobile: boolean;
  lensActive: boolean;
}): boolean {
  return (
    Boolean(args.activeSessionId) &&
    !args.lensActive &&
    args.isMobile &&
    shouldShowTouchController()
  );
}

function resolveShowContext(args: {
  isMobile: boolean;
  lensActive: boolean;
  touchControlsAvailable: boolean;
}): boolean {
  return args.lensActive ? args.isMobile : args.touchControlsAvailable && keysExpanded;
}

function resolveShowStatus(args: {
  activeSessionId: string | null;
  isMobile: boolean;
  lensActive: boolean;
  showInput: boolean;
}): boolean {
  return args.lensActive || (Boolean(args.activeSessionId) && (args.isMobile || args.showInput));
}

function resolveShowFooter(args: {
  activeSessionId: string | null;
  showAutomation: boolean;
  showContext: boolean;
  showInput: boolean;
  showStatus: boolean;
}): boolean {
  return (
    Boolean(args.activeSessionId) &&
    (args.showInput || args.showAutomation || args.showContext || args.showStatus)
  );
}

function getLensDraftAttachments(sessionId: string | null): LensComposerDraftAttachment[] {
  return getLensDraftAttachmentsForSession(lensAttachmentDrafts, sessionId);
}

function setLensDraftAttachments(
  sessionId: string,
  attachments: readonly LensComposerDraftAttachment[],
): void {
  setLensDraftAttachmentsForSession(lensAttachmentDrafts, sessionId, attachments);
}

function clearLensDraftAttachments(sessionId: string, revokePreviews = true): void {
  clearLensDraftAttachmentsForSession(lensAttachmentDrafts, sessionId, revokePreviews);
}

function detachLensDraftAttachments(sessionId: string): LensComposerDraftAttachment[] {
  return detachLensDraftAttachmentsForSession(lensAttachmentDrafts, sessionId);
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

  $settingsOpen.subscribe(() => {
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

  bindSmartInputGlobalKeyBindings({
    beginRecording,
    canUseVoice: canUseSmartInputVoice,
    closeFooterTransientUi,
    endRecording,
    getInterruptibleLensSessionId: () => {
      const sessionId = $activeSessionId.get();
      if (
        !sessionId ||
        !isLensActiveSession(sessionId) ||
        !hasInterruptibleLensTurnWork(sessionId)
      ) {
        return null;
      }

      return sessionId;
    },
    hasVisibleInput: () => getAdaptiveFooterLayoutState().showInput,
    isRecording: () => isRecording,
    onLensEscape: (sessionId) => {
      void handleLensEscape(sessionId);
    },
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
    updateFooterReservedHeight();
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

  const dom = createSmartInputDom({
    createToolsStrip: () => createToolButtonsStrip(getToolButtonRenderArgs()),
    onAttachInputChange: (files) => {
      void handleSmartInputSelectedFiles(files);
    },
    onLensEffortChange: () => {
      const sessionId = $activeSessionId.get();
      if (!sessionId || !isLensActiveSession(sessionId)) {
        return;
      }

      setLensQuickSettingsDraft(sessionId, {
        effort: lensEffortSelect?.value ?? null,
      });
    },
    onLensModelChange: () => {
      const sessionId = $activeSessionId.get();
      if (!sessionId || !isLensActiveSession(sessionId)) {
        return;
      }

      setLensQuickSettingsDraft(sessionId, {
        model: lensModelSelect?.value ?? null,
      });
    },
    onLensPermissionChange: () => {
      const sessionId = $activeSessionId.get();
      if (!sessionId || !isLensActiveSession(sessionId)) {
        return;
      }

      setLensQuickSettingsDraft(sessionId, {
        permissionMode: lensPermissionSelect?.value ?? 'manual',
      });
    },
    onLensPlanChange: () => {
      const sessionId = $activeSessionId.get();
      if (!sessionId || !isLensActiveSession(sessionId)) {
        return;
      }

      setLensQuickSettingsDraft(sessionId, {
        planMode: lensPlanSelect?.value ?? 'off',
      });
      syncSmartInputVisibility();
    },
    onPhotoInputChange: (files) => {
      void handleSmartInputSelectedFiles(files);
    },
    onSendClick: () => {
      if (suppressNextSendClick) {
        suppressNextSendClick = false;
        return;
      }

      if (activeTextarea) {
        void sendText(activeTextarea);
      }
    },
    onSendDoubleClick: (event) => {
      if (isMobileViewport()) {
        return;
      }

      event.preventDefault();
      toggleAutoSendEnabled();
    },
    onSendPointerDown: () => {
      if (!isMobileViewport()) {
        return;
      }

      clearSendAutoSendLongPressTimer();
      sendAutoSendLongPressTimer = window.setTimeout(() => {
        toggleAutoSendEnabled();
        suppressNextSendClick = true;
        sendAutoSendLongPressTimer = null;
      }, AUTO_SEND_LONG_PRESS_MS);
    },
    onSendPointerEnd: () => {
      clearSendAutoSendLongPressTimer();
    },
    onTextareaFocus: () => {
      queueFooterReserveSync();
      requestAnimationFrame(() => {
        footerDock?.scrollTo({ top: 0, behavior: 'auto' });
      });
    },
    onTextareaInput: (textarea) => {
      persistDraftForSession($activeSessionId.get(), textarea.value);
      resizeSmartInputTextarea(textarea);
      if (!footerResizeObserver) {
        queueFooterReserveSync();
      }
    },
    onTextareaKeydown: (event, textarea) => {
      if (
        event.key === 'Escape' &&
        !event.shiftKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.metaKey
      ) {
        const sessionId = $activeSessionId.get();
        if (sessionId && isLensActiveSession(sessionId)) {
          event.preventDefault();
          void handleLensEscape(sessionId);
          return;
        }
      }

      if (shouldInsertLineBreakOnEnter(event)) {
        event.preventDefault();
        insertSmartInputLineBreak(textarea);
        return;
      }

      if (shouldSubmitSmartInputOnEnter(event)) {
        event.preventDefault();
        void sendText(textarea);
      }
    },
    onTextareaPaste: (event) => {
      const sessionId = $activeSessionId.get();
      if (!sessionId || !isLensActiveSession(sessionId)) {
        return;
      }

      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length === 0) {
        return;
      }

      event.preventDefault();
      addLensComposerFiles(sessionId, files);
    },
    onToolsTogglePointerDown: (event) => {
      if (!isMobileViewport()) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      suppressNextToolsToggleClick = true;
      setToolsPanelOpen(!toolsPanelOpen);

      const preserveComposerFocus =
        activeTextarea === document.activeElement ||
        document.body.classList.contains('keyboard-visible');
      if (preserveComposerFocus) {
        requestAnimationFrame(() => {
          activeTextarea?.focus({ preventScroll: true });
        });
      }
    },
    onToolsToggleClick: (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (suppressNextToolsToggleClick) {
        suppressNextToolsToggleClick = false;
        return;
      }
      setToolsPanelOpen(!toolsPanelOpen);
    },
    resizeTextarea: resizeSmartInputTextarea,
  });
  dockedBar.appendChild(dom.inputRow);
  footerPrimaryHost.appendChild(dockedBar);

  lensQuickSettingsRow = dom.lensQuickSettingsRow;
  lensQuickSettingsActions = dom.lensQuickSettingsActions;
  lensModelSelect = dom.lensModelSelect;
  lensEffortSelect = dom.lensEffortSelect;
  lensPlanSelect = dom.lensPlanSelect;
  lensPermissionSelect = dom.lensPermissionSelect;
  lensAttachmentHost = dom.lensAttachmentHost;
  activeTextarea = dom.textarea;
  sendBtn = dom.sendBtn;
  toolsToggleBtn = dom.toolsToggleBtn;
  inlineToolHost = dom.inlineToolHost;
  sharedPhotoInput = dom.photoInput;
  sharedAttachInput = dom.attachInput;
  toolsPanel = dom.toolsPanel;
  toolButtonsStrip = dom.toolsStrip;
  toolsPanel.appendChild(toolButtonsStrip);

  touchControllerEl ??= document.getElementById('touch-controller');
  if (touchControllerEl && touchControllerEl.parentElement !== footerContextHost) {
    footerContextHost.appendChild(touchControllerEl);
    touchControllerEl.classList.add('embedded');
  }
}

function openFileInputPicker(input: HTMLInputElement): void {
  showSmartInputFilePicker(input);
}

function getToolButtonRenderArgs(): Parameters<typeof createToolButtonsStrip>[0] {
  return {
    canUseVoice: canUseSmartInputVoice(),
    onAttachClick: (pinOnUse, event) => {
      event.preventDefault();
      event.stopPropagation();
      maybePinToolForActiveSession('attach', pinOnUse);
      if (sharedAttachInput) {
        openFileInputPicker(sharedAttachInput);
      }
    },
    onMicPointerDown: (pinOnUse, event) => {
      event.preventDefault();
      event.stopPropagation();
      maybePinToolForActiveSession('mic', pinOnUse, false);
      beginRecording();
    },
    onMicPointerLeave: () => {
      if (isRecording) {
        endRecording();
      }
    },
    onMicPointerUp: () => {
      endRecording();
    },
    onPhotoClick: (pinOnUse, event) => {
      event.preventDefault();
      event.stopPropagation();
      maybePinToolForActiveSession('photo', pinOnUse);
      if (isTouchPrimaryDevice()) {
        if (sharedPhotoInput) {
          openFileInputPicker(sharedPhotoInput);
        }
        return;
      }

      void captureImageFromWebcam((files) => handleSmartInputSelectedFiles(files));
    },
  };
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
  renderPinnedToolsForSession(toolsInlineInContext ? null : (layoutState.activeSessionId ?? null));
  toolsToggleBtn?.toggleAttribute('hidden', toolsInlineInContext);
  if (toolsInlineInContext) {
    setToolsPanelOpen(false);
  } else {
    setToolsPanelOpen(toolsPanelOpen);
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
  footerStatusHost.dataset.lensCompact = 'false';
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

  const renderedTerminalStatus = renderTerminalStatusRow({
    autoSendEnabled: canUseSmartInputVoice() && autoSendEnabled,
    footerStatusHost,
    isMobile: layoutState.isMobile,
    keysExpanded,
    onToggleKeys: () => {
      keysExpanded = !keysExpanded;
      localStorage.setItem('smartinput-keys-expanded', String(keysExpanded));
      syncSmartInputVisibility();
    },
    touchControlsAvailable: layoutState.touchControlsAvailable,
  });
  footerStatusHost.toggleAttribute('hidden', !renderedTerminalStatus);
}

function renderLensStatusRow(layoutState: AdaptiveFooterLayoutState): void {
  if (
    !footerStatusHost ||
    !lensQuickSettingsRow ||
    !lensQuickSettingsActions ||
    !lensModelSelect ||
    !lensEffortSelect ||
    !lensPlanSelect ||
    !lensPermissionSelect
  ) {
    return;
  }

  const sessionId = layoutState.activeSessionId as string;
  const draft = getLensQuickSettingsDraft(sessionId);
  syncLensQuickSettingsActions(sessionId);
  const useCompactRail = shouldUseCompactLensStatusRail(layoutState);
  footerStatusHost.dataset.lensCompact = useCompactRail ? 'true' : 'false';

  if (!useCompactRail) {
    lensQuickSettingsRow.classList.remove('smart-input-lens-settings-sheet');
    lensQuickSettingsRow.hidden = false;
    footerStatusHost.appendChild(lensQuickSettingsRow);
    return;
  }

  const summaryBtn = document.createElement('button');
  summaryBtn.type = 'button';
  summaryBtn.className = 'adaptive-footer-status-summary adaptive-footer-status-summary-lens';
  summaryBtn.textContent = formatLensQuickSettingsSummary(draft);
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

function shouldUseCompactLensStatusRail(layoutState: AdaptiveFooterLayoutState): boolean {
  if (layoutState.isMobile) {
    return true;
  }

  const availableWidth = Math.round(footerDock?.getBoundingClientRect().width ?? window.innerWidth);
  return availableWidth <= 720;
}

function syncLensQuickSettingsActions(sessionId: string): void {
  if (!lensQuickSettingsActions) {
    return;
  }

  lensQuickSettingsActions.replaceChildren();
  const resumeButton = createLensResumeButton(sessionId, lensResumeConversationHandler);
  lensQuickSettingsActions.hidden = !resumeButton;
  if (resumeButton) {
    lensQuickSettingsActions.appendChild(resumeButton);
  }
}
function setToolsPanelOpen(open: boolean): void {
  if (!toolsPanel || !toolsToggleBtn) {
    return;
  }

  const canOpen = Boolean(toolButtonsStrip) && !toolsToggleBtn.hidden;
  const shouldOpen = open && canOpen;
  toolsPanelOpen = shouldOpen;
  if (toolButtonsStrip && toolButtonsStrip.parentElement !== toolsPanel) {
    toolsPanel.appendChild(toolButtonsStrip);
  }
  toolsPanel.hidden = !shouldOpen;
  toolsToggleBtn.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
  toolsToggleBtn.classList.toggle('open', shouldOpen);
  if (!footerResizeObserver) {
    queueFooterReserveSync();
  }
}

function maybePinToolForActiveSession(
  tool: ToolKind,
  pinOnUse: boolean,
  closePanel: boolean = true,
): void {
  if (!pinOnUse) {
    return;
  }
  const sessionId = $activeSessionId.get();
  if (!sessionId) {
    return;
  }
  const currentTools = sessionPinnedTools.get(sessionId) ?? [];
  if (!currentTools.includes(tool)) {
    sessionPinnedTools.set(sessionId, [...currentTools, tool]);
    renderPinnedToolsForSession(sessionId);
  }
  if (closePanel && toolsPanelOpen) {
    setToolsPanelOpen(false);
  }
}

function renderPinnedToolsForSession(sessionId: string | null): void {
  if (!inlineToolHost) {
    return;
  }
  inlineToolHost.replaceChildren();
  if (!sessionId) {
    inlineToolHost.hidden = true;
    return;
  }
  const pinnedTools = sessionPinnedTools.get(sessionId) ?? [];
  let visibleToolCount = 0;
  for (const tool of pinnedTools) {
    const button = createToolButton(tool, false, getToolButtonRenderArgs());
    if (!button.hidden) {
      visibleToolCount += 1;
    }
    inlineToolHost.appendChild(button);
  }

  inlineToolHost.hidden = visibleToolCount === 0;
  syncVoiceInputAvailability();
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

function renderLensAttachmentDrafts(sessionId: string | null): void {
  renderLensAttachmentDraftView({
    attachments: sessionId ? getLensDraftAttachments(sessionId) : [],
    host: lensAttachmentHost,
    isLensActiveSession,
    onFocusTextarea: () => {
      activeTextarea?.focus({ preventScroll: true });
    },
    onRemoveAttachment: removeLensComposerFile,
    sessionId,
  });
}

function removeLensComposerFile(sessionId: string, attachmentId: string): void {
  const attachments = getLensDraftAttachments(sessionId);
  const nextAttachments: LensComposerDraftAttachment[] = [];
  for (const attachment of attachments) {
    if (attachment.id === attachmentId) {
      releaseLensComposerDraftAttachmentPreviews([attachment]);
      continue;
    }

    nextAttachments.push(attachment);
  }

  setLensDraftAttachments(sessionId, nextAttachments);
  renderLensAttachmentDrafts($activeSessionId.get());
}

function addLensComposerFiles(sessionId: string, files: readonly File[]): void {
  const nextAttachments = [...getLensDraftAttachments(sessionId)];
  let errorMessage: string | null = null;

  for (const file of files) {
    if (isLensComposerImageFile(file) && file.size > MAX_LENS_IMAGE_BYTES) {
      errorMessage = `${t('smartInput.imageTooLarge')}: ${file.name}`;
      continue;
    }

    nextAttachments.push(createLensComposerDraftAttachment(file));
  }

  setLensDraftAttachments(sessionId, nextAttachments);
  renderLensAttachmentDrafts($activeSessionId.get());

  if (errorMessage) {
    showDropToast(errorMessage);
  }
}

async function handleSmartInputSelectedFiles(files: FileList): Promise<void> {
  const sessionId = $activeSessionId.get();
  if (!sessionId || files.length === 0) {
    return;
  }

  if (!isLensActiveSession(sessionId)) {
    await handleFileDrop(files);
    return;
  }

  addLensComposerFiles(sessionId, Array.from(files));
  activeTextarea?.focus({ preventScroll: true });
}

function clearSubmittedSmartInputState(sessionId: string, ta: HTMLTextAreaElement): void {
  ta.value = '';
  persistDraftForSession(sessionId, '');
  clearLensDraftAttachments(sessionId);
  syncDraftForActiveSession();
  renderLensAttachmentDrafts($activeSessionId.get());
  ta.scrollTop = 0;
  resizeSmartInputTextarea(ta);
  if (!footerResizeObserver) {
    queueFooterReserveSync();
  }
  ta.focus();
}

async function sendText(ta: HTMLTextAreaElement): Promise<void> {
  const text = ta.value;
  const sessionId = $activeSessionId.get();
  if (!sessionId) return;

  const lensAttachments = getLensDraftAttachments(sessionId);
  if (!text && lensAttachments.length === 0) {
    return;
  }

  if (!isLensActiveSession(sessionId) || lensAttachments.length === 0) {
    if (!text) {
      return;
    }

    void submitSmartInput(sessionId, text);
    clearSubmittedSmartInputState(sessionId, ta);
    return;
  }

  const attachmentDrafts = detachLensDraftAttachments(sessionId);
  const draftText = text;
  renderLensAttachmentDrafts($activeSessionId.get());

  try {
    const { queuedTurn } = await submitLensComposerDraft({
      sessionId,
      text: draftText,
      attachments: attachmentDrafts,
      uploadFailureMessage: t('smartInput.attachmentUploadFailed'),
      uploadFile,
      createTurnRequest: createLensTurnRequest,
      submitQueuedTurn: submitQueuedLensTurn,
    });

    clearSubmittedSmartInputState(sessionId, ta);

    void queuedTurn
      .then(() => {
        releaseLensComposerDraftAttachmentPreviews(attachmentDrafts);
      })
      .catch((error: unknown) => {
        const shouldRestore =
          (sessionDrafts.get(sessionId) ?? '') === '' &&
          getLensDraftAttachments(sessionId).length === 0;
        if (shouldRestore) {
          persistDraftForSession(sessionId, draftText);
          setLensDraftAttachments(sessionId, attachmentDrafts);
        } else {
          releaseLensComposerDraftAttachmentPreviews(attachmentDrafts);
        }
        syncDraftForActiveSession();
        renderLensAttachmentDrafts($activeSessionId.get());
        showDropToast(
          error instanceof Error && error.message.trim()
            ? error.message
            : t('smartInput.attachmentSendFailed'),
        );
      });
  } catch (error) {
    setLensDraftAttachments(sessionId, attachmentDrafts);
    renderLensAttachmentDrafts($activeSessionId.get());
    showDropToast(
      error instanceof Error && error.message.trim()
        ? error.message
        : t('smartInput.attachmentUploadFailed'),
    );
  }
}

function persistDraftForSession(sessionId: string | null, draftOverride?: string): void {
  persistSessionDraft(sessionDrafts, sessionId, draftOverride ?? activeTextarea?.value ?? '');
}

function applyDraftToTextarea(
  textarea: HTMLTextAreaElement | null,
  sessionId: string | null,
): void {
  applySessionDraftToTextarea(sessionDrafts, textarea, sessionId, resizeSmartInputTextarea);
}
function syncDraftForActiveSession(): void {
  const sessionId = $activeSessionId.get();
  applyDraftToTextarea(activeTextarea, sessionId);
  renderLensAttachmentDrafts(sessionId);
  syncLensQuickSettingsControls();
}

export function removeSmartInputSessionState(sessionId: string): void {
  sessionDrafts.delete(sessionId);
  clearLensDraftAttachments(sessionId);
  sessionPinnedTools.delete(sessionId);
  if ($activeSessionId.get() === sessionId) {
    syncDraftForActiveSession();
    renderPinnedToolsForSession(sessionId);
  }
}
function beginRecording(): void {
  if (!canUseSmartInputVoice()) return;
  if (isRecording) return;
  isRecording = true;
  getMicButtons().forEach((button) => {
    button.classList.add('recording');
  });

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
  getMicButtons().forEach((button) => {
    button.classList.remove('recording');
  });
  void stopTranscription();
}

function canUseSmartInputVoice(): boolean {
  return canUseSmartInputVoiceSupport();
}

function syncVoiceInputAvailability(): void {
  syncVoiceInputAvailabilitySupport({
    footerDock,
    dockedBar,
    sendBtn,
    autoSendEnabled,
    isRecording,
    endRecording,
  });
}

function updateAutoSendVisibility(): void {
  updateAutoSendVisibilitySupport({ dockedBar, sendBtn, autoSendEnabled });
}

function getMicButtons(): HTMLButtonElement[] {
  return getMicButtonsSupport(footerDock);
}

function syncLensQuickSettingsControls(): void {
  syncLensQuickSettingsControlsSupport({
    lensQuickSettingsRow,
    lensQuickSettingsActions,
    lensModelSelect,
    lensEffortSelect,
    lensPlanSelect,
    lensPermissionSelect,
    lensSettingsSummaryBtn,
    dockedBar,
    getVisibilityState: getSmartInputVisibilityState,
    setLensQuickSettingsSheetOpen,
  });
}

function queueFooterReserveSync(): void {
  queueFooterReserveSyncSupport({
    footerResizeQueued,
    setFooterResizeQueued,
    updateFooterReservedHeight: () => {
      updateFooterReservedHeight();
    },
  });
}

function updateFooterReservedHeight(): void {
  updateFooterReservedHeightSupport({
    footerDock,
    activeTextarea,
    lastReservedFooterHeightPx,
    setLastReservedFooterHeightPx,
  });
}

async function submitSmartInput(sessionId: string, text: string): Promise<void> {
  await submitSessionText(sessionId, text);
}
