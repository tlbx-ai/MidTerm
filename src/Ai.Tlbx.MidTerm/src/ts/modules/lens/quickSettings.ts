import type {
  LensAttachmentReference,
  LensQuickSettingsSummary,
  MidTermSettingsPublic,
  LensTurnRequest,
} from '../../api/types';
import * as stores from '../../stores';

export const LENS_QUICK_SETTINGS_CHANGED_EVENT = 'midterm:lens-quick-settings-changed';

export interface LensQuickSettingsChangedEventDetail {
  sessionId: string;
  provider: string | null;
  effective: LensQuickSettingsSummary;
  draft: LensQuickSettingsSummary;
  draftDirty: boolean;
  source: 'seed' | 'sync' | 'draft' | 'remove';
}

interface LensQuickSettingsSessionState {
  provider: string | null;
  effective: LensQuickSettingsSummary;
  draft: LensQuickSettingsSummary;
  draftDirty: boolean;
}

interface LensSessionProviderHint {
  profileHint?: string | null;
  foregroundName?: string | null;
}

type LensPlanMode = LensQuickSettingsSummary['planMode'];
type LensPermissionMode = LensQuickSettingsSummary['permissionMode'];

const QUICK_SETTINGS_PROVIDER_STORAGE_PREFIX = 'midterm:lens-quick-settings:provider:';
const DEFAULT_PLAN_MODE: LensPlanMode = 'off';
const DEFAULT_PERMISSION_MODE: LensPermissionMode = 'manual';
const sessionStates = new Map<string, LensQuickSettingsSessionState>();

function getOptionalStoreExport(key: string): unknown {
  if (!Reflect.has(stores, key)) {
    return undefined;
  }

  return Reflect.get(stores, key);
}

function normalizeOptionalValue(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizePlanMode(value: string | null | undefined): LensPlanMode {
  return value?.trim().toLowerCase() === 'on' ? 'on' : 'off';
}

function normalizePermissionMode(value: string | null | undefined): LensPermissionMode {
  return value?.trim().toLowerCase() === 'auto' ? 'auto' : 'manual';
}

function cloneQuickSettings(settings: LensQuickSettingsSummary): LensQuickSettingsSummary {
  return {
    model: settings.model ?? null,
    effort: settings.effort ?? null,
    planMode: normalizePlanMode(settings.planMode),
    permissionMode: normalizePermissionMode(settings.permissionMode),
  };
}

function dispatchQuickSettingsChange(
  sessionId: string,
  state: LensQuickSettingsSessionState,
  source: LensQuickSettingsChangedEventDetail['source'],
): void {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') {
    return;
  }

  window.dispatchEvent(
    new CustomEvent<LensQuickSettingsChangedEventDetail>(LENS_QUICK_SETTINGS_CHANGED_EVENT, {
      detail: {
        sessionId,
        provider: state.provider,
        effective: cloneQuickSettings(state.effective),
        draft: cloneQuickSettings(state.draft),
        draftDirty: state.draftDirty,
        source,
      },
    }),
  );
}

function readProviderStickyQuickSettings(
  provider: string | null,
): Partial<LensQuickSettingsSummary> {
  if (!provider || typeof localStorage === 'undefined') {
    return {};
  }

  try {
    const raw = localStorage.getItem(`${QUICK_SETTINGS_PROVIDER_STORAGE_PREFIX}${provider}`);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Partial<LensQuickSettingsSummary>)
      : {};
  } catch {
    return {};
  }
}

function writeProviderStickyQuickSettings(
  provider: string | null,
  settings: LensQuickSettingsSummary,
): void {
  if (!provider || typeof localStorage === 'undefined') {
    return;
  }

  try {
    localStorage.setItem(
      `${QUICK_SETTINGS_PROVIDER_STORAGE_PREFIX}${provider}`,
      JSON.stringify(cloneQuickSettings(settings)),
    );
  } catch {
    // Ignore quota/storage failures and keep the in-memory session draft.
  }
}

function resolveSessionProvider(sessionId: string | null | undefined): string | null {
  if (!sessionId) {
    return null;
  }

  const getSession = getOptionalStoreExport('getSession') as
    | ((sessionId: string) => LensSessionProviderHint | null)
    | undefined;
  const session = getSession?.(sessionId);
  const hinted =
    typeof session?.profileHint === 'string' && session.profileHint.trim().length > 0
      ? session.profileHint
      : session?.foregroundName;
  if (!hinted) {
    return null;
  }

  const normalized = hinted.trim().toLowerCase();
  return normalized === 'codex' || normalized === 'claude' ? normalized : null;
}

function resolveDefaultPermissionMode(provider: string | null): LensPermissionMode {
  const currentSettingsStore = getOptionalStoreExport('$currentSettings') as
    | { get?: () => MidTermSettingsPublic | null }
    | undefined;
  const settings =
    currentSettingsStore && typeof currentSettingsStore.get === 'function'
      ? currentSettingsStore.get()
      : null;
  if (!settings) {
    return DEFAULT_PERMISSION_MODE;
  }

  if (provider === 'codex') {
    return settings.codexYoloDefault ? 'auto' : 'manual';
  }

  if (provider === 'claude') {
    return settings.claudeDangerouslySkipPermissionsDefault ? 'auto' : 'manual';
  }

  return DEFAULT_PERMISSION_MODE;
}

function normalizeQuickSettings(
  settings: Partial<LensQuickSettingsSummary> | null | undefined,
  provider: string | null,
): LensQuickSettingsSummary {
  return {
    model: normalizeOptionalValue(settings?.model),
    effort: normalizeOptionalValue(settings?.effort),
    planMode: normalizePlanMode(settings?.planMode ?? DEFAULT_PLAN_MODE),
    permissionMode: normalizePermissionMode(
      settings?.permissionMode ?? resolveDefaultPermissionMode(provider),
    ),
  };
}

function getOrCreateSessionState(sessionId: string): LensQuickSettingsSessionState {
  const existing = sessionStates.get(sessionId);
  if (existing) {
    return existing;
  }

  const provider = resolveSessionProvider(sessionId);
  const seeded = normalizeQuickSettings(readProviderStickyQuickSettings(provider), provider);
  const created: LensQuickSettingsSessionState = {
    provider,
    effective: cloneQuickSettings(seeded),
    draft: cloneQuickSettings(seeded),
    draftDirty: false,
  };
  sessionStates.set(sessionId, created);
  return created;
}

function ensureProviderSeeded(
  state: LensQuickSettingsSessionState,
  provider: string | null,
): LensQuickSettingsSessionState {
  if (state.provider === provider) {
    return state;
  }

  const providerSeed = normalizeQuickSettings(readProviderStickyQuickSettings(provider), provider);
  const nextEffective = normalizeQuickSettings(state.effective, provider);
  const nextDraft = state.draftDirty
    ? normalizeQuickSettings(state.draft, provider)
    : cloneQuickSettings(
        providerSeed.model !== null ||
          providerSeed.effort !== null ||
          providerSeed.planMode !== DEFAULT_PLAN_MODE ||
          providerSeed.permissionMode !== resolveDefaultPermissionMode(provider)
          ? providerSeed
          : nextEffective,
      );
  state.provider = provider;
  state.effective = nextEffective;
  state.draft = nextDraft;
  return state;
}

export function getLensQuickSettingsDraft(sessionId: string): LensQuickSettingsSummary {
  const state = ensureProviderSeeded(
    getOrCreateSessionState(sessionId),
    resolveSessionProvider(sessionId),
  );
  return cloneQuickSettings(state.draft);
}

export function getLensQuickSettingsEffective(sessionId: string): LensQuickSettingsSummary {
  const state = ensureProviderSeeded(
    getOrCreateSessionState(sessionId),
    resolveSessionProvider(sessionId),
  );
  return cloneQuickSettings(state.effective);
}

export function getLensQuickSettingsProvider(sessionId: string): string | null {
  const state = ensureProviderSeeded(
    getOrCreateSessionState(sessionId),
    resolveSessionProvider(sessionId),
  );
  return state.provider;
}

export function setLensQuickSettingsDraft(
  sessionId: string,
  patch: Partial<LensQuickSettingsSummary>,
): void {
  const state = ensureProviderSeeded(
    getOrCreateSessionState(sessionId),
    resolveSessionProvider(sessionId),
  );
  state.draft = normalizeQuickSettings({ ...state.draft, ...patch }, state.provider);
  state.draftDirty = true;
  writeProviderStickyQuickSettings(state.provider, state.draft);
  dispatchQuickSettingsChange(sessionId, state, 'draft');
}

export function syncLensQuickSettingsFromSnapshot(
  sessionId: string,
  provider: string | null | undefined,
  quickSettings: Partial<LensQuickSettingsSummary> | null | undefined,
): void {
  const state = ensureProviderSeeded(
    getOrCreateSessionState(sessionId),
    provider ?? resolveSessionProvider(sessionId),
  );
  state.effective = normalizeQuickSettings(quickSettings, state.provider);
  if (!state.draftDirty) {
    state.draft = cloneQuickSettings(state.effective);
  }
  writeProviderStickyQuickSettings(state.provider, state.effective);
  dispatchQuickSettingsChange(sessionId, state, 'sync');
}

export function acceptLensQuickSettings(
  sessionId: string,
  provider: string | null | undefined,
  quickSettings: Partial<LensQuickSettingsSummary> | null | undefined,
): void {
  const state = ensureProviderSeeded(
    getOrCreateSessionState(sessionId),
    provider ?? resolveSessionProvider(sessionId),
  );
  state.effective = normalizeQuickSettings(quickSettings, state.provider);
  state.draft = cloneQuickSettings(state.effective);
  state.draftDirty = false;
  writeProviderStickyQuickSettings(state.provider, state.effective);
  dispatchQuickSettingsChange(sessionId, state, 'sync');
}

export function removeLensQuickSettingsSessionState(sessionId: string): void {
  const state = sessionStates.get(sessionId);
  if (!state) {
    return;
  }

  sessionStates.delete(sessionId);
  dispatchQuickSettingsChange(sessionId, state, 'remove');
}

export function createLensTurnRequestWithQuickSettings(
  sessionId: string,
  text: string,
  attachments: LensAttachmentReference[] = [],
): LensTurnRequest {
  const quickSettings = getLensQuickSettingsDraft(sessionId);
  return {
    text,
    model: quickSettings.model ?? null,
    effort: quickSettings.effort ?? null,
    planMode: quickSettings.planMode,
    permissionMode: quickSettings.permissionMode,
    attachments,
  };
}
