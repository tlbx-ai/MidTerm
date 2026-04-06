import { t } from '../i18n';
import { buildTerminalFontStack, getConfiguredTerminalFontFamily } from '../terminal/fontConfig';
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
  if (panel.dataset.agentViewReady === 'true') {
    return;
  }

  panel.dataset.agentViewReady = 'true';
  panel.classList.add('agent-view-panel');
  panel.innerHTML = `
    <section class="agent-view">
      <div class="agent-chat-shell">
        <div class="agent-runtime-stats" data-agent-field="runtime-stats" hidden></div>
        <div class="agent-history" data-agent-field="history"></div>
        <button type="button" class="agent-scroll-to-bottom" data-agent-field="scroll-to-bottom" hidden>${lensText('lens.scrollToBottom', 'Back to bottom')}</button>
        <section class="agent-composer-shell" data-agent-field="composer-shell" hidden>
          <div class="agent-composer-interruption" data-agent-field="composer-interruption" hidden></div>
          <div class="agent-composer-host" data-agent-field="composer-host"></div>
        </section>
      </div>
    </section>
  `;

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

function syncAgentViewPresentation(
  panel: HTMLDivElement,
  provider: string | null | undefined = null,
): void {
  const style = (panel as unknown as { style?: CSSStyleDeclaration | null }).style;
  if (!style || typeof style.setProperty !== 'function') {
    panel.dataset.lensProvider = normalizeLensProvider(provider);
    panel.dataset.lensLayout = resolveLensLayoutMode(provider);
    return;
  }

  const fontFamily = buildAgentViewFontFamily();
  if (fontFamily) {
    style.setProperty('--agent-font-family', fontFamily);
  } else {
    style.removeProperty('--agent-font-family');
  }

  panel.dataset.lensProvider = normalizeLensProvider(provider);
  panel.dataset.lensLayout = resolveLensLayoutMode(provider);
}

function buildAgentViewFontFamily(): string | null {
  const terminalFontFamily = getConfiguredTerminalFontFamily();
  const fontStack = buildTerminalFontStack(terminalFontFamily);
  return fontStack.trim() ? fontStack : null;
}
