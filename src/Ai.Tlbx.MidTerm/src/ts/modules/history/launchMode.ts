import { t } from '../i18n';

export type HistoryLaunchMode = 'terminal' | 'lens';
export type HistoryLensProfile = 'codex' | 'claude';

export interface HistoryModeEntry {
  launchMode?: string | null;
  profile?: string | null;
}

export interface HistoryModeSessionLike {
  lensOnly?: boolean | null;
  profileHint?: string | null;
  supervisor?: {
    profile?: string | null;
  } | null;
}

export function normalizeHistoryLaunchMode(mode: string | null | undefined): HistoryLaunchMode {
  return mode === 'lens' ? 'lens' : 'terminal';
}

export function normalizeHistoryLensProfile(
  profile: string | null | undefined,
): HistoryLensProfile | null {
  return profile === 'codex' || profile === 'claude' ? profile : null;
}

export function isLensHistoryEntry(entry: HistoryModeEntry): boolean {
  return (
    normalizeHistoryLaunchMode(entry.launchMode) === 'lens' &&
    normalizeHistoryLensProfile(entry.profile) !== null
  );
}

export function resolveSessionHistoryMode(session: HistoryModeSessionLike): {
  launchMode: HistoryLaunchMode;
  profile: HistoryLensProfile | null;
} {
  if (session.lensOnly === true) {
    const profile = normalizeHistoryLensProfile(session.profileHint ?? session.supervisor?.profile);
    if (profile) {
      return {
        launchMode: 'lens',
        profile,
      };
    }
  }

  return {
    launchMode: 'terminal',
    profile: null,
  };
}

export function getHistoryModeDisplayText(entry: HistoryModeEntry): string {
  if (!isLensHistoryEntry(entry)) {
    return t('session.terminal');
  }

  const profile = normalizeHistoryLensProfile(entry.profile);
  const providerText =
    profile === 'claude' ? t('sessionLauncher.claudeTitle') : t('sessionLauncher.codexTitle');
  return `${t('sessionTabs.agent')} · ${providerText}`;
}
