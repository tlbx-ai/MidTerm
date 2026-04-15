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
            <div class="agent-history" data-agent-field="history"></div>
            <div
              class="agent-history-index-scroll"
              data-agent-field="history-index-scroll"
              aria-label="${lensText('lens.history.indexScroll', 'History navigation scrollbar')}"
            >
              <div class="agent-history-index-scroll-sizer" data-agent-field="history-index-scroll-sizer"></div>
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

function repairAgentViewSkeleton(panel: HTMLDivElement): void {
  const history = panel.querySelector<HTMLDivElement>('[data-agent-field="history"]');
  const composerShell = panel.querySelector<HTMLElement>('[data-agent-field="composer-shell"]');
  if (!history || !composerShell) {
    return;
  }

  let historyShell = panel.querySelector<HTMLDivElement>('.agent-history-shell');
  if (!historyShell) {
    historyShell = document.createElement('div');
    historyShell.className = 'agent-history-shell';
    history.parentNode?.insertBefore(historyShell, history);
    historyShell.append(history);
  }

  let indexScrollHost = panel.querySelector<HTMLDivElement>(
    '[data-agent-field="history-index-scroll"]',
  );
  if (!indexScrollHost) {
    indexScrollHost = document.createElement('div');
    indexScrollHost.className = 'agent-history-index-scroll';
    indexScrollHost.dataset.agentField = 'history-index-scroll';
    indexScrollHost.setAttribute(
      'aria-label',
      lensText('lens.history.indexScroll', 'History navigation scrollbar'),
    );
    historyShell.append(indexScrollHost);
  }

  if (!panel.querySelector('[data-agent-field="history-index-scroll-sizer"]')) {
    const sizer = document.createElement('div');
    sizer.className = 'agent-history-index-scroll-sizer';
    sizer.dataset.agentField = 'history-index-scroll-sizer';
    indexScrollHost.append(sizer);
  }

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

function syncAgentViewPresentation(
  panel: HTMLDivElement,
  provider: string | null | undefined = null,
): void {
  panel.dataset.lensProvider = normalizeLensProvider(provider);
  panel.dataset.lensLayout = resolveLensLayoutMode(provider);
}
