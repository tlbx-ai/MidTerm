import { $voiceServerPassword } from '../../stores';
import { t } from '../i18n';
import {
  getLensQuickSettingsDraft,
  getLensQuickSettingsEffective,
  getLensQuickSettingsProvider,
} from '../lens/quickSettings';
import { getLensModelOptions } from '../lens/modelOptions';
import { isDevMode } from '../sidebar/voiceSection';
import {
  ADAPTIVE_FOOTER_RESERVED_HEIGHT_CHANGED_EVENT,
  calculateAdaptiveFooterReservedHeight,
} from './layout';
import { shouldShowLensQuickSettings, type SmartInputVisibilityState } from './visibility';
import {
  formatLensQuickSettingsSummary,
  setLensQuickSettingsDropdownOptions,
} from './smartInputView';
import { getCollapsedSmartInputTextareaHeight } from './smartInputMetrics';

export function canUseSmartInputVoice(): boolean {
  return isDevMode() && Boolean($voiceServerPassword.get());
}

export function getMicButtons(footerDock: HTMLDivElement | null): HTMLButtonElement[] {
  return footerDock
    ? Array.from(footerDock.querySelectorAll<HTMLButtonElement>('.smart-input-mic-btn'))
    : [];
}

export function updateAutoSendVisibility(args: {
  dockedBar: HTMLDivElement | null;
  sendBtn: HTMLButtonElement | null;
  autoSendEnabled: boolean;
}): void {
  const active = args.autoSendEnabled && canUseSmartInputVoice();
  args.dockedBar?.classList.toggle('autosend-active', active);
  args.sendBtn?.classList.toggle('autosend-latched', active);
  if (args.sendBtn) {
    args.sendBtn.setAttribute('data-autosend', active ? 'true' : 'false');
    args.sendBtn.title = active ? t('smartInput.autoSendOnHint') : t('smartInput.sendGestureHint');
  }
}

export function syncVoiceInputAvailability(args: {
  footerDock: HTMLDivElement | null;
  dockedBar: HTMLDivElement | null;
  sendBtn: HTMLButtonElement | null;
  autoSendEnabled: boolean;
  isRecording: boolean;
  endRecording: () => void;
}): void {
  const enabled = canUseSmartInputVoice();
  getMicButtons(args.footerDock).forEach((button) => {
    button.hidden = !enabled;
  });

  if (!enabled && args.isRecording) {
    args.endRecording();
  }

  updateAutoSendVisibility({
    dockedBar: args.dockedBar,
    sendBtn: args.sendBtn,
    autoSendEnabled: args.autoSendEnabled,
  });
}

export function shouldIgnoreFooterTransientUiDocumentClick(target: Node): boolean {
  return (
    target instanceof HTMLElement && Boolean(target.closest('.provider-resume-picker-overlay'))
  );
}

export function syncLensQuickSettingsControls(args: {
  lensQuickSettingsRow: HTMLDivElement | null;
  lensQuickSettingsActions: HTMLDivElement | null;
  lensModelSelect: HTMLSelectElement | null;
  lensEffortSelect: HTMLSelectElement | null;
  lensPlanSelect: HTMLSelectElement | null;
  lensPermissionSelect: HTMLSelectElement | null;
  lensSettingsSummaryBtn: HTMLButtonElement | null;
  dockedBar: HTMLDivElement | null;
  getVisibilityState: () => SmartInputVisibilityState;
  setLensQuickSettingsSheetOpen: (open: boolean) => void;
}): void {
  const {
    lensQuickSettingsRow,
    lensQuickSettingsActions,
    lensModelSelect,
    lensEffortSelect,
    lensPlanSelect,
    lensPermissionSelect,
    lensSettingsSummaryBtn,
    dockedBar,
  } = args;
  if (
    !lensQuickSettingsRow ||
    !lensQuickSettingsActions ||
    !lensModelSelect ||
    !lensEffortSelect ||
    !lensPlanSelect ||
    !lensPermissionSelect
  ) {
    return;
  }

  const visibilityState = args.getVisibilityState();
  if (!shouldShowLensQuickSettings(visibilityState)) {
    if (dockedBar) {
      dockedBar.dataset.lensSession = 'false';
    }
    lensQuickSettingsRow.hidden = true;
    lensQuickSettingsActions.replaceChildren();
    lensQuickSettingsActions.hidden = true;
    delete lensQuickSettingsRow.dataset.provider;
    args.setLensQuickSettingsSheetOpen(false);
    return;
  }

  const sessionId = visibilityState.activeSessionId as string;
  const provider = getLensQuickSettingsProvider(sessionId);
  const draft = getLensQuickSettingsDraft(sessionId);
  const effective = getLensQuickSettingsEffective(sessionId);
  if (dockedBar) {
    dockedBar.dataset.lensSession = 'true';
  }
  lensQuickSettingsRow.dataset.provider = provider ?? '';

  setLensQuickSettingsDropdownOptions(
    lensModelSelect,
    getLensModelOptions({
      provider,
      currentValues: [draft.model, effective.model],
    }),
  );

  syncLensQuickSettingSelect(lensModelSelect, draft.model ?? '');
  syncLensQuickSettingSelect(lensEffortSelect, draft.effort ?? '');
  syncLensQuickSettingSelect(lensPlanSelect, draft.planMode);
  syncLensQuickSettingSelect(lensPermissionSelect, draft.permissionMode);

  if (lensSettingsSummaryBtn) {
    lensSettingsSummaryBtn.textContent = formatLensQuickSettingsSummary(draft);
    lensSettingsSummaryBtn.dataset.planMode = draft.planMode;
  }
}

function syncLensQuickSettingSelect(select: HTMLSelectElement, nextValue: string): void {
  if (select.value === nextValue) {
    return;
  }

  select.value = nextValue;
  select.dispatchEvent(new Event('midterm:sync'));
}

export function queueFooterReserveSync(args: {
  footerResizeQueued: boolean;
  setFooterResizeQueued: (queued: boolean) => void;
  updateFooterReservedHeight: () => void;
}): void {
  if (args.footerResizeQueued) {
    return;
  }

  args.setFooterResizeQueued(true);
  requestAnimationFrame(() => {
    args.setFooterResizeQueued(false);
    args.updateFooterReservedHeight();
  });
}

export function updateFooterReservedHeight(args: {
  footerDock: HTMLDivElement | null;
  activeTextarea: HTMLTextAreaElement | null;
  composerExpanded: boolean;
  lastReservedFooterHeightPx: number;
  setLastReservedFooterHeightPx: (value: number) => void;
}): void {
  const root = document.documentElement;
  if (!args.footerDock || args.footerDock.hidden || args.composerExpanded) {
    setAdaptiveFooterReservedHeight(
      root,
      0,
      args.lastReservedFooterHeightPx,
      args.setLastReservedFooterHeightPx,
    );
    return;
  }

  const textareaHeight = args.activeTextarea?.offsetHeight ?? null;
  const collapsedTextareaHeight = args.activeTextarea
    ? getCollapsedSmartInputTextareaHeight(args.activeTextarea)
    : null;
  const reserveHeight = calculateAdaptiveFooterReservedHeight({
    dockHeight: args.footerDock.offsetHeight,
    textareaHeight,
    collapsedTextareaHeight,
  });

  setAdaptiveFooterReservedHeight(
    root,
    reserveHeight,
    args.lastReservedFooterHeightPx,
    args.setLastReservedFooterHeightPx,
  );
}

function setAdaptiveFooterReservedHeight(
  root: HTMLElement,
  reserveHeight: number,
  lastReservedFooterHeightPx: number,
  setLastReservedFooterHeightPx: (value: number) => void,
): void {
  const normalizedReserveHeight = Math.max(0, Math.round(reserveHeight));
  root.style.setProperty(
    '--adaptive-footer-reserved-height',
    `${String(normalizedReserveHeight)}px`,
  );

  if (lastReservedFooterHeightPx === normalizedReserveHeight) {
    return;
  }

  setLastReservedFooterHeightPx(normalizedReserveHeight);
  window.dispatchEvent(
    new CustomEvent(ADAPTIVE_FOOTER_RESERVED_HEIGHT_CHANGED_EVENT, {
      detail: { reservedHeightPx: normalizedReserveHeight },
    }),
  );
}
