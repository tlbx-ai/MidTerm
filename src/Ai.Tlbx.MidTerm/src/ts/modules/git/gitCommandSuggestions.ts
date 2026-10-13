import type { Session } from '../../types';
import { t } from '../i18n';
import { escapeHtml } from '../../utils';
import { $sessions } from '../../stores';
import { sessionTerminals } from '../../state';
import { getProcessState } from '../process';
export function renderCommandSuggestions(
  suggestions: Array<{ label: string; command: string }>,
  sessionId: string,
): string {
  if (suggestions.length === 0)
    return `<p class="git-panel-hint">${t('git.commandShellUnsupported')}</p>`;
  const insertAllowed = canInsertCommand(sessionId);
  return `<section class="git-command-section">
    <div class="git-command-section-title">Suggested terminal commands</div>
    <div class="git-command-list">
      ${suggestions
        .map(
          (suggestion) => `<div class="git-command-row">
            <div class="git-command-copy">
              <div class="git-command-label">${escapeHtml(suggestion.label)}</div>
              <code class="git-command-text">${escapeHtml(suggestion.command)}</code>
            </div>
            <div class="git-command-actions">
              <button class="git-action-button" data-action="copy-command" data-command="${escapeHtml(suggestion.command)}" title="${t('git.copyCommand')}" type="button">${t('git.copy')}</button>
              <button class="git-action-button" data-action="insert-command" data-command="${escapeHtml(suggestion.command)}" title="${t(insertAllowed ? 'git.insertHint' : 'git.insertShellOnly')}"${insertAllowed ? '' : ' disabled'} type="button">${t('git.insert')}</button>
            </div>
            <div class="git-action-status" role="status" aria-live="polite"></div>
          </div>`,
        )
        .join('')}
    </div>
  </section>`;
}

export function canInsertCommand(sessionId: string): boolean {
  const session = $sessions.get()[sessionId];
  if (
    !session ||
    !session.isRunning ||
    session.appServerControlOnly ||
    !sessionTerminals.has(sessionId)
  )
    return false;
  return isSessionShellForeground(sessionId, session);
}

function isSessionShellForeground(sessionId: string, session: Session): boolean {
  const process = getProcessState(sessionId);
  const foreground = process.foregroundName ?? session.foregroundName;
  const foregroundPid = process.foregroundPid ?? session.foregroundPid;
  const name = foreground?.replace(/\.exe$/i, '').toLowerCase();
  const shell = session.shellType;
  const expected = shell === 'Pwsh' ? 'pwsh' : shell.toLowerCase();
  return (
    (foregroundPid == null && name === undefined) ||
    (foregroundPid === session.pid && (name === 'shell' || name === expected))
  );
}
