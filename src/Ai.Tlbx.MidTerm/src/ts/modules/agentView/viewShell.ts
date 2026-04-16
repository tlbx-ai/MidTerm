import { t } from '../i18n';
import { normalizeLensProvider, resolveLensLayoutMode } from './activationHelpers';
import type { LensDebugScenarioName } from './debugScenario';

export const LENS_DEBUG_SCENARIO_NAMES: readonly LensDebugScenarioName[] = [
  'mixed',
  'tables',
  'long',
  'workflow',
];

function lensText(key: string, fallback: string): string {
  const translated = t(key);
  if (!translated || translated === key) {
    return fallback;
  }

  return translated;
}

export function normalizeLensDebugScenarioName(scenario: string): LensDebugScenarioName {
  return LENS_DEBUG_SCENARIO_NAMES.includes(scenario as LensDebugScenarioName)
    ? (scenario as LensDebugScenarioName)
    : 'mixed';
}

export function ensureAgentViewSkeleton(
  sessionId: string,
  panel: HTMLDivElement,
  onEscape: (sessionId: string) => void,
): void {
  syncAgentViewPresentation(panel);
  if (panel.dataset.agentViewReady !== 'true') {
    panel.dataset.agentViewReady = 'true';
    panel.classList.add('agent-view-panel');
    panel.innerHTML = `
      <section class="agent-view">
        <div class="agent-chat-shell">
          <div class="agent-runtime-stats" data-agent-field="runtime-stats" hidden></div>
          <div class="agent-virtualizer-debug" data-agent-field="virtualizer-debug" hidden></div>
          <div class="agent-history-shell">
            <div class="agent-history" data-agent-field="history" tabindex="0"></div>
            <div
              class="agent-history-progress-nav"
              data-agent-field="history-progress-nav"
              role="scrollbar"
              data-ready="false"
              tabindex="-1"
              aria-label="${lensText('lens.history.indexScroll', 'History navigation scrollbar')}"
              aria-disabled="true"
              aria-valuemin="1"
              aria-valuemax="1"
              aria-valuenow="1"
            >
              <div class="agent-history-progress-track" data-agent-field="history-progress-track"></div>
              <div class="agent-history-progress-thumb" data-agent-field="history-progress-thumb"></div>
            </div>
          </div>
          <button type="button" class="agent-scroll-to-bottom" data-agent-field="scroll-to-bottom" hidden>${lensText('lens.scrollToBottom', 'Back to bottom')}</button>
          <section class="agent-composer-shell" data-agent-field="composer-shell" hidden>
            <div class="agent-composer-interruption" data-agent-field="composer-interruption" hidden></div>
            <div class="agent-composer-host" data-agent-field="composer-host"></div>
          </section>
        </div>
      </section>
    `;
  } else {
    repairAgentViewSkeleton(panel);
  }

  if (panel.dataset.agentViewEscapeBound === 'true') {
    return;
  }

  panel.dataset.agentViewEscapeBound = 'true';
  panel.addEventListener('keydown', (event) => {
    if (
      event.key !== 'Escape' ||
      event.shiftKey ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey
    ) {
      return;
    }

    event.preventDefault();
    onEscape(sessionId);
  });
}

/* eslint-disable complexity -- repairs both legacy and current Lens shells in place for upgrade safety. */
function repairAgentViewSkeleton(panel: HTMLDivElement): void {
  const history = panel.querySelector<HTMLDivElement>('[data-agent-field="history"]');
  const composerShell = panel.querySelector<HTMLElement>('[data-agent-field="composer-shell"]');
  if (!history || !composerShell) {
    return;
  }

  if (typeof history.hasAttribute !== 'function' || !history.hasAttribute('tabindex')) {
    history.tabIndex = 0;
  }

  let historyShell = panel.querySelector<HTMLDivElement>('.agent-history-shell');
  if (!historyShell) {
    historyShell = document.createElement('div');
    historyShell.className = 'agent-history-shell';
    history.parentNode?.insertBefore(historyShell, history);
    historyShell.append(history);
  }

  const legacyIndexScrollHost = panel.querySelector<HTMLDivElement>(
    '[data-agent-field="history-index-scroll"]',
  );
  const legacyIndexScrollSizer = panel.querySelector<HTMLDivElement>(
    '[data-agent-field="history-index-scroll-sizer"]',
  );
  if (legacyIndexScrollSizer) {
    if (typeof legacyIndexScrollSizer.remove === 'function') {
      legacyIndexScrollSizer.remove();
    } else {
      legacyIndexScrollSizer.parentNode?.removeChild(legacyIndexScrollSizer);
    }
  }

  let progressNav = panel.querySelector<HTMLDivElement>(
    '[data-agent-field="history-progress-nav"]',
  );
  if (!progressNav) {
    progressNav = document.createElement('div');
    progressNav.className = 'agent-history-progress-nav';
    progressNav.dataset.agentField = 'history-progress-nav';
    progressNav.dataset.ready = 'false';
    progressNav.tabIndex = -1;
    progressNav.setAttribute('role', 'scrollbar');
    progressNav.setAttribute(
      'aria-label',
      lensText('lens.history.indexScroll', 'History navigation scrollbar'),
    );
    progressNav.setAttribute('aria-disabled', 'true');
    progressNav.setAttribute('aria-valuemin', '1');
    progressNav.setAttribute('aria-valuemax', '1');
    progressNav.setAttribute('aria-valuenow', '1');
    if (legacyIndexScrollHost) {
      if (typeof legacyIndexScrollHost.replaceWith === 'function') {
        legacyIndexScrollHost.replaceWith(progressNav);
      } else {
        legacyIndexScrollHost.parentNode?.insertBefore(progressNav, legacyIndexScrollHost);
        legacyIndexScrollHost.parentNode?.removeChild(legacyIndexScrollHost);
      }
    } else {
      historyShell.append(progressNav);
    }
  } else if (legacyIndexScrollHost) {
    if (typeof legacyIndexScrollHost.remove === 'function') {
      legacyIndexScrollHost.remove();
    } else {
      legacyIndexScrollHost.parentNode?.removeChild(legacyIndexScrollHost);
    }
  }

  if (!panel.querySelector('[data-agent-field="history-progress-track"]')) {
    const track = document.createElement('div');
    track.className = 'agent-history-progress-track';
    track.dataset.agentField = 'history-progress-track';
    progressNav.append(track);
  }

  if (!panel.querySelector('[data-agent-field="history-progress-thumb"]')) {
    const thumb = document.createElement('div');
    thumb.className = 'agent-history-progress-thumb';
    thumb.dataset.agentField = 'history-progress-thumb';
    progressNav.append(thumb);
  }

  if (typeof progressNav.removeAttribute === 'function') {
    progressNav.removeAttribute('hidden');
  }
  progressNav.hidden = false;
  progressNav.dataset.ready = history.childNodes.length > 0 ? 'true' : 'false';
  progressNav.tabIndex = history.childNodes.length > 0 ? 0 : -1;
  progressNav.setAttribute('aria-disabled', history.childNodes.length > 0 ? 'false' : 'true');

  if (!panel.querySelector('[data-agent-field="scroll-to-bottom"]')) {
    const scrollButton = document.createElement('button');
    scrollButton.type = 'button';
    scrollButton.className = 'agent-scroll-to-bottom';
    scrollButton.dataset.agentField = 'scroll-to-bottom';
    scrollButton.hidden = true;
    scrollButton.textContent = lensText('lens.scrollToBottom', 'Back to bottom');
    composerShell.parentNode?.insertBefore(scrollButton, composerShell);
  }
}
/* eslint-enable complexity */

function syncAgentViewPresentation(
  panel: HTMLDivElement,
  provider: string | null | undefined = null,
): void {
  panel.dataset.lensProvider = normalizeLensProvider(provider);
  panel.dataset.lensLayout = resolveLensLayoutMode(provider);
}
