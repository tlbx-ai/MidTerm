import type { Session } from '../../types';
import { dom } from '../../state';
import { getSessionDisplayInfo } from './sessionList';

export function syncSidebarSessionDisplayText(session: Session): boolean {
  const host = dom.sessionList;
  if (!host) {
    return false;
  }

  const items = Array.from(
    host.querySelectorAll<HTMLElement>('.session-item[data-session-id]'),
  ).filter((item) => item.dataset.sessionId === session.id);

  if (items.length === 0) {
    return true;
  }

  const displayInfo = getSessionDisplayInfo(session);
  for (const item of items) {
    const title = item.querySelector<HTMLElement>('.session-title');
    const titleRow = item.querySelector<HTMLElement>('.session-title-row');
    if (!title || !titleRow) {
      return false;
    }

    if (title.textContent !== displayInfo.primary) {
      title.textContent = displayInfo.primary;
    }

    let subtitle = item.querySelector<HTMLElement>('.session-subtitle');
    if (displayInfo.secondary) {
      if (!subtitle) {
        subtitle = document.createElement('div');
        subtitle.className = 'session-subtitle';
        titleRow.appendChild(subtitle);
      }
      if (subtitle.textContent !== displayInfo.secondary) {
        subtitle.textContent = displayInfo.secondary;
      }
    } else {
      subtitle?.remove();
    }
  }

  return true;
}

export function syncSidebarActiveSessionState(activeSessionId: string | null): boolean {
  const host = dom.sessionList;
  if (!host) {
    return false;
  }

  const items = host.querySelectorAll<HTMLElement>('.session-item[data-session-id]');
  for (const item of items) {
    const isActive = item.dataset.sessionId === activeSessionId;
    item.classList.toggle('active', isActive);
    item.setAttribute('aria-current', isActive ? 'true' : 'false');
  }

  return true;
}
