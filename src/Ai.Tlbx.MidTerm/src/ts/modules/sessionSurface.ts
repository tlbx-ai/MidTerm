import { t } from './i18n';

export type SessionSurfaceMode = 'terminal' | 'agent';
export type SessionAgentProfile = 'codex' | 'claude' | null;

export interface SessionSurfaceLike {
  lensOnly?: boolean | null;
  agentControlled?: boolean | null;
  hasLensHistory?: boolean | null;
  profileHint?: string | null;
  supervisor?: {
    profile?: string | null;
  } | null;
}

export function isInteractiveAgentProfile(profile: string | null | undefined): boolean {
  return (
    profile === 'codex' ||
    profile === 'claude' ||
    profile === 'open-code' ||
    profile === 'generic-ai'
  );
}

export function normalizeAgentProfile(profile: string | null | undefined): SessionAgentProfile {
  return profile === 'codex' || profile === 'claude' ? profile : null;
}

export function resolveSessionAgentProfile(
  session: SessionSurfaceLike | null | undefined,
): SessionAgentProfile {
  return normalizeAgentProfile(session?.profileHint ?? session?.supervisor?.profile);
}

export function isAgentSurfaceSession(
  session: SessionSurfaceLike | null | undefined,
  options?: { lensForcedVisible?: boolean },
): boolean {
  if (options?.lensForcedVisible === true) {
    return true;
  }

  return (
    session?.lensOnly === true ||
    session?.agentControlled === true ||
    session?.hasLensHistory === true ||
    isInteractiveAgentProfile(session?.profileHint ?? session?.supervisor?.profile)
  );
}

export function resolveSessionSurfaceMode(
  session: SessionSurfaceLike | null | undefined,
  options?: { lensForcedVisible?: boolean },
): SessionSurfaceMode {
  return isAgentSurfaceSession(session, options) ? 'agent' : 'terminal';
}

export function getAgentSurfaceLabel(session: SessionSurfaceLike | null | undefined): string {
  const profile = resolveSessionAgentProfile(session);
  if (profile === 'codex') {
    return t('sessionLauncher.codexTitle');
  }

  if (profile === 'claude') {
    return t('sessionLauncher.claudeTitle');
  }

  return t('sessionTabs.agent');
}

export function getPrimarySurfaceLabel(
  session: SessionSurfaceLike | null | undefined,
  options?: { lensForcedVisible?: boolean },
): string {
  return resolveSessionSurfaceMode(session, options) === 'agent'
    ? getAgentSurfaceLabel(session)
    : t('session.terminal');
}
