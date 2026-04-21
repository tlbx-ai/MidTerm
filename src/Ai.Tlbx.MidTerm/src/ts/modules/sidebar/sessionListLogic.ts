import type { Session } from '../../types';

export type SessionControlMode = 'human' | 'agent';

export interface SessionGroup {
  key: SessionControlMode;
  label: string;
  sessions: Session[];
  collapsed: boolean;
  showHeader: boolean;
  attentionCount: number;
}

export interface SessionGroupingOptions {
  humanLabel?: string;
  agentLabel?: string;
  isCollapsed?: (group: SessionControlMode) => boolean;
}

export interface SessionForegroundInfo {
  name?: string | null;
  displayName?: string | null;
  cwd?: string | null;
  commandLine?: string | null;
}

const DEFAULT_HUMAN_LABEL = 'Human controlled';
const DEFAULT_AGENT_LABEL = 'Agent controlled';

export function shouldShowAgentControlAction(controlMode: SessionControlMode): boolean {
  return controlMode === 'agent';
}

export function normalizeSessionFilterValue(value: string | null | undefined): string {
  return (value ?? '').trim();
}

function getSessionFilterTerms(query: string): string[] {
  const normalizedQuery = normalizeSessionFilterValue(query).toLowerCase();
  return normalizedQuery === '' ? [] : normalizedQuery.split(/\s+/);
}

function buildSessionFilterHaystack(
  session: Session,
  foregroundInfo: SessionForegroundInfo | null | undefined,
): string {
  return [
    session.name,
    session.terminalTitle,
    session.shellType,
    session.currentDirectory,
    foregroundInfo?.name,
    foregroundInfo?.displayName,
    foregroundInfo?.cwd,
    foregroundInfo?.commandLine,
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join('\n')
    .toLowerCase();
}

export function filterSessionsByQuery(
  sessions: Session[],
  query: string,
  getForegroundInfo: (sessionId: string) => SessionForegroundInfo | null | undefined = () => null,
): Session[] {
  const terms = getSessionFilterTerms(query);
  if (terms.length === 0) {
    return sessions;
  }

  return sessions.filter((session) => {
    const haystack = buildSessionFilterHaystack(session, getForegroundInfo(session.id));
    return terms.every((term) => haystack.includes(term));
  });
}

export function isAgentControlled(session: Session | null | undefined): boolean {
  return session?.agentControlled === true;
}

export function getSessionControlMode(session: Session): SessionControlMode {
  return isAgentControlled(session) ? 'agent' : 'human';
}

export function getSupervisorState(session: Session): string {
  return session.supervisor?.state ?? 'unknown';
}

function getAttentionScore(session: Session): number {
  return session.supervisor?.attentionScore ?? 0;
}

export function needsAttention(session: Session): boolean {
  return session.supervisor?.needsAttention === true;
}

export function getSupervisorBadgeLabel(session: Session): string | null {
  const state = getSupervisorState(session);
  return state === 'unknown'
    ? null
    : state
        .replace(/^busy-turn$/, 'busy')
        .replace(/^idle-prompt$/, 'idle')
        .replace(/-/g, ' ')
        .toUpperCase();
}

export function groupSessionsByController(
  sessions: Session[],
  options: SessionGroupingOptions = {},
): SessionGroup[] {
  const humanSessions = sessions.filter((session) => getSessionControlMode(session) === 'human');
  const agentSessions = sessions
    .filter((session) => getSessionControlMode(session) === 'agent')
    .sort((a, b) => {
      const attentionDelta = Number(needsAttention(b)) - Number(needsAttention(a));
      if (attentionDelta !== 0) return attentionDelta;
      const scoreDelta = getAttentionScore(b) - getAttentionScore(a);
      if (scoreDelta !== 0) return scoreDelta;
      return a.order - b.order;
    });
  const groups: SessionGroup[] = [];
  const showHeaders = agentSessions.length > 0;
  const isCollapsed = options.isCollapsed ?? (() => false);

  if (humanSessions.length > 0) {
    groups.push({
      key: 'human',
      label: options.humanLabel ?? DEFAULT_HUMAN_LABEL,
      sessions: humanSessions,
      collapsed: isCollapsed('human'),
      showHeader: showHeaders,
      attentionCount: 0,
    });
  }

  if (agentSessions.length > 0) {
    groups.push({
      key: 'agent',
      label: options.agentLabel ?? DEFAULT_AGENT_LABEL,
      sessions: agentSessions,
      collapsed: isCollapsed('agent'),
      showHeader: showHeaders,
      attentionCount: agentSessions.filter((session) => needsAttention(session)).length,
    });
  }

  return groups;
}

export function syncSessionItemActiveStates(
  root: ParentNode,
  activeId: string | null,
): HTMLElement | null {
  root.querySelectorAll<HTMLElement>('.session-item.active').forEach((item) => {
    item.classList.remove('active');
    item.setAttribute('aria-current', 'false');
  });

  if (!activeId) {
    return null;
  }

  const activeItem = root.querySelector<HTMLElement>(
    `.session-item[data-session-id="${activeId}"]`,
  );
  if (!activeItem) {
    return null;
  }

  activeItem.classList.add('active');
  activeItem.setAttribute('aria-current', 'true');
  return activeItem;
}
