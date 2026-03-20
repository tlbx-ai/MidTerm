import { t } from '../i18n';
import { createLogger } from '../logging';
import {
  onTabActivated,
  onTabDeactivated,
  setActionButtonActive,
  setLensClickHandler,
  switchTab,
} from '../sessionTabs';
import {
  getSessionAgentVibe,
  type AgentSessionVibeCapability,
  type AgentSessionVibeActivity,
  type AgentSessionVibeHeatSample,
  type AgentSessionVibeLane,
  type AgentSessionVibeResponse,
} from '../../api/client';

const log = createLogger('agentView');

const REFRESH_INTERVAL_MS = 2000;
const TAIL_LINES = 80;
const ACTIVITY_WINDOW_SECONDS = 90;
const ACTIVITY_BELL_LIMIT = 8;

const activePanels = new Map<string, HTMLDivElement>();
const refreshTimers = new Map<string, number>();
const refreshingSessions = new Set<string>();

export function initAgentView(): void {
  setLensClickHandler((sessionId) => {
    switchTab(sessionId, 'agent', { forceHidden: true });
    setActionButtonActive('lens', true);
  });

  onTabActivated('agent', (sessionId, panel) => {
    activePanels.set(sessionId, panel);
    setActionButtonActive('lens', true);
    ensureAgentViewSkeleton(sessionId, panel);
    void refreshAgentView(sessionId);
    startPolling(sessionId);
  });

  onTabDeactivated('agent', (sessionId) => {
    setActionButtonActive('lens', false);
    stopPolling(sessionId);
  });

  log.info(() => 'Agent view initialized');
}

export function destroyAgentView(sessionId: string): void {
  stopPolling(sessionId);
  activePanels.delete(sessionId);
  refreshingSessions.delete(sessionId);
}

function startPolling(sessionId: string): void {
  stopPolling(sessionId);
  const timerId = window.setInterval(() => {
    void refreshAgentView(sessionId);
  }, REFRESH_INTERVAL_MS);
  refreshTimers.set(sessionId, timerId);
}

function stopPolling(sessionId: string): void {
  const timerId = refreshTimers.get(sessionId);
  if (timerId !== undefined) {
    window.clearInterval(timerId);
    refreshTimers.delete(sessionId);
  }
}

function ensureAgentViewSkeleton(sessionId: string, panel: HTMLDivElement): void {
  if (panel.dataset.agentViewReady === 'true') {
    return;
  }

  panel.dataset.agentViewReady = 'true';
  panel.classList.add('agent-view-panel');
  panel.innerHTML = `
    <section class="agent-view">
      <div class="agent-view-hero">
        <div class="agent-view-copy">
          <div class="agent-view-eyebrow">${t('agentView.eyebrow')}</div>
          <h2 class="agent-view-title" data-agent-field="title"></h2>
          <p class="agent-view-subtitle" data-agent-field="subtitle"></p>
        </div>
        <div class="agent-view-actions">
          <button type="button" class="agent-view-btn" data-agent-action="refresh">${t('agentView.refresh')}</button>
          <button type="button" class="agent-view-btn agent-view-btn-primary" data-agent-action="terminal">${t('agentView.openTerminal')}</button>
        </div>
      </div>
      <div class="agent-view-chip-row" data-agent-field="chips"></div>
      <div class="agent-view-grid">
        <div class="agent-view-column">
          <article class="agent-card-grid">
            <section class="agent-card">
              <div class="agent-card-label">${t('agentView.state')}</div>
              <div class="agent-card-value" data-agent-field="state"></div>
              <div class="agent-card-meta" data-agent-field="state-meta"></div>
            </section>
            <section class="agent-card">
              <div class="agent-card-label">${t('agentView.activity')}</div>
              <div class="agent-card-value" data-agent-field="rate"></div>
              <div class="agent-card-meta" data-agent-field="activity-meta"></div>
            </section>
            <section class="agent-card">
              <div class="agent-card-label">${t('agentView.lastOutput')}</div>
              <div class="agent-card-value" data-agent-field="last-output"></div>
              <div class="agent-card-meta" data-agent-field="last-output-meta"></div>
            </section>
            <section class="agent-card">
              <div class="agent-card-label">${t('agentView.bells')}</div>
              <div class="agent-card-value" data-agent-field="bells"></div>
              <div class="agent-card-meta" data-agent-field="bells-meta"></div>
            </section>
          </article>
          <section class="agent-card agent-card-wide">
            <div class="agent-card-header">
              <div>
                <div class="agent-card-label">${t('agentView.heatTimeline')}</div>
                <div class="agent-card-meta">${t('agentView.heatTimelineMeta')}</div>
              </div>
            </div>
            <div class="agent-heatmap" data-agent-field="heatmap"></div>
          </section>
          <section class="agent-card agent-card-wide">
            <div class="agent-card-header">
              <div>
                <div class="agent-card-label">${t('agentView.timeline')}</div>
                <div class="agent-card-meta">${t('agentView.timelineMeta')}</div>
              </div>
            </div>
            <div class="agent-activity-list" data-agent-field="activities"></div>
          </section>
          <section class="agent-card agent-card-wide">
            <div class="agent-card-header">
              <div>
                <div class="agent-card-label">${t('agentView.lane')}</div>
                <div class="agent-card-meta">${t('agentView.laneMeta')}</div>
              </div>
            </div>
            <div class="agent-lane-head">
              <div class="agent-lane-label" data-agent-field="lane-label"></div>
              <span class="agent-chip" data-agent-field="lane-chip"></span>
            </div>
            <p class="agent-transport-copy" data-agent-field="lane-detail"></p>
            <div class="agent-capability-list" data-agent-field="capabilities"></div>
          </section>
          <section class="agent-card agent-card-wide">
            <div class="agent-card-label">${t('agentView.transport')}</div>
            <div class="agent-card-meta">${t('agentView.transportMeta')}</div>
            <p class="agent-transport-copy" data-agent-field="transport"></p>
          </section>
        </div>
        <section class="agent-card agent-card-wide agent-output-card">
          <div class="agent-card-header">
            <div>
              <div class="agent-card-label">${t('agentView.recentOutput')}</div>
              <div class="agent-card-meta">${t('agentView.recentOutputMeta')}</div>
            </div>
          </div>
          <pre class="agent-output" data-agent-field="tail"></pre>
        </section>
      </div>
    </section>
  `;

  const refreshButton = panel.querySelector<HTMLButtonElement>('[data-agent-action="refresh"]');
  refreshButton?.addEventListener('click', () => {
    void refreshAgentView(sessionId);
  });

  const terminalButton = panel.querySelector<HTMLButtonElement>('[data-agent-action="terminal"]');
  terminalButton?.addEventListener('click', () => {
    switchTab(sessionId, 'terminal');
  });
}

async function refreshAgentView(sessionId: string): Promise<void> {
  if (refreshingSessions.has(sessionId)) {
    return;
  }

  const panel = activePanels.get(sessionId);
  if (!panel) {
    return;
  }

  refreshingSessions.add(sessionId);
  try {
    const vibe = await getSessionAgentVibe(
      sessionId,
      TAIL_LINES,
      ACTIVITY_WINDOW_SECONDS,
      ACTIVITY_BELL_LIMIT,
    );
    renderAgentView(panel, sessionId, vibe);
  } catch (error) {
    log.warn(() => `Failed to refresh agent view for ${sessionId}: ${String(error)}`);
    renderUnavailable(panel, t('agentView.loadError'));
  } finally {
    refreshingSessions.delete(sessionId);
  }
}

function renderUnavailable(panel: HTMLDivElement, message: string): void {
  const title = panel.querySelector<HTMLElement>('[data-agent-field="title"]');
  const subtitle = panel.querySelector<HTMLElement>('[data-agent-field="subtitle"]');
  const tail = panel.querySelector<HTMLElement>('[data-agent-field="tail"]');
  const chips = panel.querySelector<HTMLElement>('[data-agent-field="chips"]');
  const transport = panel.querySelector<HTMLElement>('[data-agent-field="transport"]');
  const laneLabel = panel.querySelector<HTMLElement>('[data-agent-field="lane-label"]');
  const laneChip = panel.querySelector<HTMLElement>('[data-agent-field="lane-chip"]');
  const laneDetail = panel.querySelector<HTMLElement>('[data-agent-field="lane-detail"]');
  const capabilities = panel.querySelector<HTMLElement>('[data-agent-field="capabilities"]');
  const heatmap = panel.querySelector<HTMLElement>('[data-agent-field="heatmap"]');
  const activities = panel.querySelector<HTMLElement>('[data-agent-field="activities"]');

  if (title) {
    title.textContent = t('agentView.unavailableTitle');
  }
  if (subtitle) {
    subtitle.textContent = message;
  }
  if (tail) {
    tail.textContent = message;
  }
  if (chips) {
    chips.replaceChildren();
  }
  if (transport) {
    transport.textContent = message;
  }
  if (laneLabel) {
    laneLabel.textContent = t('agentView.unavailableTitle');
  }
  if (laneChip) {
    laneChip.className = 'agent-chip';
    laneChip.textContent = '';
  }
  if (laneDetail) {
    laneDetail.textContent = message;
  }
  if (capabilities) {
    capabilities.replaceChildren();
  }
  if (heatmap) {
    heatmap.replaceChildren();
  }
  if (activities) {
    activities.replaceChildren();
  }
}

function renderAgentView(
  panel: HTMLDivElement,
  sessionId: string,
  vibe: AgentSessionVibeResponse,
): void {
  const title = panel.querySelector<HTMLElement>('[data-agent-field="title"]');
  const subtitle = panel.querySelector<HTMLElement>('[data-agent-field="subtitle"]');
  const chips = panel.querySelector<HTMLElement>('[data-agent-field="chips"]');
  const transport = panel.querySelector<HTMLElement>('[data-agent-field="transport"]');
  const tailEl = panel.querySelector<HTMLElement>('[data-agent-field="tail"]');

  if (title) {
    title.textContent = vibe.header.title;
  }

  if (subtitle) {
    subtitle.textContent = vibe.header.subtitle;
  }

  if (chips) {
    renderChips(chips, vibe.header.chips);
  }

  renderLane(panel, vibe.lane);
  renderCapabilities(panel, vibe.capabilities);

  setText(panel, 'state', vibe.overview.stateValue);
  setText(panel, 'state-meta', vibe.overview.stateMeta);
  setText(panel, 'rate', vibe.overview.activityValue);
  setText(panel, 'activity-meta', vibe.overview.activityMeta);
  setText(panel, 'last-output', vibe.overview.lastOutputValue);
  setText(panel, 'last-output-meta', vibe.overview.lastOutputMeta);
  setText(panel, 'bells', vibe.overview.bellsValue);
  setText(panel, 'bells-meta', vibe.overview.bellsMeta);

  renderHeatmap(panel, vibe.heatmap);
  renderActivities(panel, vibe.activities);

  if (transport) {
    transport.textContent = vibe.header.transportSummary;
  }

  if (tailEl) {
    tailEl.textContent =
      vibe.terminal.tailText.trim().length > 0
        ? vibe.terminal.tailText.trimEnd()
        : vibe.terminal.emptyMessage;
  }

  const terminalButton = panel.querySelector<HTMLButtonElement>('[data-agent-action="terminal"]');
  if (terminalButton) {
    terminalButton.dataset.sessionId = sessionId;
  }
}

function setText(panel: HTMLDivElement, field: string, value: string): void {
  const element = panel.querySelector<HTMLElement>(`[data-agent-field="${field}"]`);
  if (element) {
    element.textContent = value;
  }
}

function renderChips(
  container: HTMLElement,
  chips: AgentSessionVibeResponse['header']['chips'],
): void {
  const fragment = document.createDocumentFragment();
  for (const chip of chips) {
    const node = document.createElement('span');
    node.className = `agent-chip agent-chip-${chip.tone.replace(/[^a-z0-9-]/gi, '-')}`;
    node.textContent = chip.text;
    fragment.appendChild(node);
  }

  container.replaceChildren(fragment);
}

function renderLane(panel: HTMLDivElement, lane: AgentSessionVibeLane): void {
  setText(panel, 'lane-label', lane.label);
  setText(panel, 'lane-detail', lane.detail);

  const chip = panel.querySelector<HTMLElement>('[data-agent-field="lane-chip"]');
  if (!chip) {
    return;
  }

  chip.className = `agent-chip agent-chip-${lane.tone.replace(/[^a-z0-9-]/gi, '-')}`;
  chip.textContent = lane.label;
}

function renderCapabilities(
  panel: HTMLDivElement,
  capabilities: AgentSessionVibeCapability[],
): void {
  const container = panel.querySelector<HTMLElement>('[data-agent-field="capabilities"]');
  if (!container) {
    return;
  }

  if (capabilities.length === 0) {
    container.replaceChildren();
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const capability of capabilities) {
    const item = document.createElement('article');
    item.className = 'agent-capability-item';

    const head = document.createElement('div');
    head.className = 'agent-capability-head';

    const label = document.createElement('div');
    label.className = 'agent-capability-label';
    label.textContent = capability.label;

    const status = document.createElement('span');
    status.className = `agent-chip agent-chip-${capability.status.replace(/[^a-z0-9-]/gi, '-')}`;
    status.textContent = capability.statusLabel;

    head.appendChild(label);
    head.appendChild(status);
    item.appendChild(head);

    const detail = document.createElement('div');
    detail.className = 'agent-capability-detail';
    detail.textContent = capability.detail;
    item.appendChild(detail);

    fragment.appendChild(item);
  }

  container.replaceChildren(fragment);
}

function renderHeatmap(panel: HTMLDivElement, heatmap: AgentSessionVibeHeatSample[]): void {
  const container = panel.querySelector<HTMLElement>('[data-agent-field="heatmap"]');
  if (!container) {
    return;
  }

  const samples = heatmap.slice(-24);
  const maxHeat = Math.max(...samples.map((sample) => sample.heat), 0.01);
  const fragment = document.createDocumentFragment();

  for (const sample of samples) {
    const bar = document.createElement('span');
    const ratio = Math.max(sample.heat / maxHeat, 0.08);
    bar.className = 'agent-heatmap-bar';
    bar.style.setProperty('--agent-heat-height', ratio.toFixed(3));
    bar.title = `${formatAbsoluteTime(sample.timestamp)} • ${formatBytes(sample.bytes)}/s`;
    fragment.appendChild(bar);
  }

  if (samples.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'agent-heatmap-empty';
    empty.textContent = t('agentView.noHeat');
    container.replaceChildren(empty);
    return;
  }

  container.replaceChildren(fragment);
}

function renderActivities(panel: HTMLDivElement, activities: AgentSessionVibeActivity[]): void {
  const container = panel.querySelector<HTMLElement>('[data-agent-field="activities"]');
  if (!container) {
    return;
  }

  if (activities.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'agent-activity-empty';
    empty.textContent = t('agentView.noTimeline');
    container.replaceChildren(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const activity of activities.slice(0, 8)) {
    const item = document.createElement('article');
    item.className = `agent-activity-item agent-activity-${activity.tone.replace(/[^a-z0-9-]/gi, '-')}`;

    const meta = document.createElement('div');
    meta.className = 'agent-activity-meta';
    meta.textContent = `${activity.kind} • ${formatTimestamp(activity.createdAt)}`;

    const summary = document.createElement('div');
    summary.className = 'agent-activity-summary';
    summary.textContent = activity.summary;

    item.appendChild(meta);
    item.appendChild(summary);

    if (activity.detail) {
      const detail = document.createElement('div');
      detail.className = 'agent-activity-detail';
      detail.textContent = activity.detail;
      item.appendChild(detail);
    }

    fragment.appendChild(item);
  }

  container.replaceChildren(fragment);
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return t('agentView.unknownTime');
  }

  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatAbsoluteTime(value: string): string {
  return formatTimestamp(value);
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }

  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }

  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
