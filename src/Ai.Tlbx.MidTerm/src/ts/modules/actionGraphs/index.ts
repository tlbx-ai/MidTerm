/**
 * Action Graphs canvas: renders agent-curated graphs (nodes, edges, positions,
 * launch actions) on a pan/zoom surface. The canvas prescribes no use case —
 * it draws what agents publish and executes stored launch specs verbatim.
 */

import { $actionGraphsOpen, $currentSettings, $sessionList } from '../../stores';
import { t } from '../i18n';
import { createLogger } from '../logging';
import { registerBackButtonLayer } from '../navigation/backButtonGuard';
import { closeSettings } from '../settings';
import { isDevMode, onDevModeChanged } from '../sidebar/voiceSection';
import {
  fetchGraph,
  fetchGraphList,
  persistNodePosition,
  runNodeAction,
  type ActionGraph,
  type ActionGraphNode,
} from './graphApi';

interface ActionGraphsViewOptions {
  onSelectSession: (sessionId: string) => void;
}

const log = createLogger('actionGraphs');
const REFRESH_INTERVAL_MS = 5000;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2.5;

let options: ActionGraphsViewOptions | null = null;
let view: HTMLElement | null = null;
let canvas: HTMLElement | null = null;
let stage: HTMLElement | null = null;
let edgesSvg: SVGSVGElement | null = null;
let nodesHost: HTMLElement | null = null;
let emptyHint: HTMLElement | null = null;
let detailPanel: HTMLElement | null = null;
let graphSelect: HTMLSelectElement | null = null;

let currentGraphId: string | null = null;
let currentGraph: ActionGraph | null = null;
let selectedNodeId: string | null = null;
let panX = 40;
let panY = 40;
let zoom = 1;
let refreshTimer: number | null = null;
let refreshAbort: AbortController | null = null;
let releaseBackButtonLayer: (() => void) | null = null;

export function initActionGraphsView(nextOptions: ActionGraphsViewOptions): void {
  options = nextOptions;
  view = document.getElementById('action-graphs-view');
  canvas = document.getElementById('action-graphs-canvas');
  stage = document.getElementById('action-graphs-stage');
  edgesSvg = document.getElementById('action-graphs-edges') as SVGSVGElement | null;
  nodesHost = document.getElementById('action-graphs-nodes');
  emptyHint = document.getElementById('action-graphs-empty');
  detailPanel = document.getElementById('action-graphs-detail');
  graphSelect = document.getElementById('action-graphs-select') as HTMLSelectElement | null;

  document.getElementById('btn-action-graphs')?.addEventListener('click', toggleActionGraphsView);
  document.getElementById('action-graphs-close')?.addEventListener('click', closeActionGraphsView);
  document.getElementById('action-graphs-refresh')?.addEventListener('click', () => {
    void refreshGraphs();
  });
  graphSelect?.addEventListener('change', () => {
    currentGraphId = graphSelect?.value || null;
    selectNode(null);
    void refreshGraphs();
  });
  wireCanvasInteractions();

  $currentSettings.subscribe(syncButtonVisibility);
  onDevModeChanged(syncButtonVisibility);
}

function syncButtonVisibility(): void {
  const enabled = $currentSettings.get()?.actionGraphsEnabled === true || isDevMode();
  document.getElementById('btn-action-graphs')?.classList.toggle('hidden', !enabled);
  if (!enabled && $actionGraphsOpen.get()) {
    closeActionGraphsView();
  }
}

export function toggleActionGraphsView(): void {
  if ($actionGraphsOpen.get()) closeActionGraphsView();
  else openActionGraphsView();
}

export function openActionGraphsView(): void {
  if (!view) return;
  closeSettings();
  $actionGraphsOpen.set(true);
  view.classList.remove('hidden');
  document.getElementById('btn-action-graphs')?.classList.add('active');
  releaseBackButtonLayer ??= registerBackButtonLayer(closeActionGraphsView);
  startRefreshTimer();
  void refreshGraphs();
}

export function closeActionGraphsView(): void {
  if (!view) return;
  $actionGraphsOpen.set(false);
  view.classList.add('hidden');
  document.getElementById('btn-action-graphs')?.classList.remove('active');
  releaseBackButtonLayer?.();
  releaseBackButtonLayer = null;
  stopRefreshTimer();
}

function startRefreshTimer(): void {
  stopRefreshTimer();
  refreshTimer = window.setInterval(() => {
    void refreshGraphs();
  }, REFRESH_INTERVAL_MS);
}

function stopRefreshTimer(): void {
  if (refreshTimer !== null) {
    window.clearInterval(refreshTimer);
    refreshTimer = null;
  }
  refreshAbort?.abort();
  refreshAbort = null;
}

async function refreshGraphs(): Promise<void> {
  if (!$actionGraphsOpen.get()) return;
  refreshAbort?.abort();
  const abort = new AbortController();
  refreshAbort = abort;

  try {
    const graphList = await fetchGraphList(abort.signal);
    renderGraphSelect(graphList.map((graph) => ({ id: graph.id, name: graph.name })));
    if (graphList.length === 0) {
      currentGraphId = null;
      currentGraph = null;
      renderGraph();
      return;
    }

    if (!currentGraphId || !graphList.some((graph) => graph.id === currentGraphId)) {
      const firstGraphId = graphList[0]?.id;
      if (!firstGraphId) return;
      currentGraphId = firstGraphId;
      if (graphSelect) graphSelect.value = currentGraphId;
    }

    currentGraph = await fetchGraph(currentGraphId, abort.signal);
    renderGraph();
  } catch (error) {
    if (!abort.signal.aborted) {
      log.warn(() => `Graph refresh failed: ${String(error)}`);
    }
  }
}

function renderGraphSelect(graphs: Array<{ id: string; name: string }>): void {
  if (!graphSelect) return;
  const previous = graphSelect.value;
  graphSelect.replaceChildren();
  for (const graph of graphs) {
    const option = document.createElement('option');
    option.value = graph.id;
    option.textContent = graph.name;
    graphSelect.appendChild(option);
  }
  if (graphs.some((graph) => graph.id === previous)) {
    graphSelect.value = previous;
  }
  graphSelect.classList.toggle('hidden', graphs.length === 0);
}

function renderGraph(): void {
  if (!nodesHost || !edgesSvg || !emptyHint) return;

  applyStageTransform();
  nodesHost.replaceChildren();
  edgesSvg.replaceChildren();

  const graph = currentGraph;
  emptyHint.classList.toggle('hidden', graph !== null && graph.nodes.length > 0);
  if (!graph) {
    renderDetail();
    return;
  }

  const runningSessions = new Set(
    $sessionList
      .get()
      .filter((session) => session.isRunning)
      .map((session) => session.id),
  );

  for (const node of graph.nodes) {
    nodesHost.appendChild(buildNodeCard(node, runningSessions));
  }
  renderEdges(graph);
  renderDetail();
}

function buildNodeCard(node: ActionGraphNode, runningSessions: Set<string>): HTMLElement {
  const card = document.createElement('div');
  card.className = 'ag-node';
  card.dataset.nodeId = node.id;
  card.dataset.kind = node.kind;
  card.style.left = `${node.x}px`;
  card.style.top = `${node.y}px`;
  if (node.width) card.style.width = `${node.width}px`;
  if (node.color) card.style.setProperty('--ag-node-accent', node.color);
  if (node.id === selectedNodeId) card.classList.add('selected');

  const header = document.createElement('div');
  header.className = 'ag-node-top';
  const kind = document.createElement('span');
  kind.className = 'ag-node-kind';
  kind.textContent = node.kind;
  header.appendChild(kind);
  if (node.sessionId && runningSessions.has(node.sessionId)) {
    const live = document.createElement('span');
    live.className = 'ag-node-live';
    live.title = node.sessionId;
    header.appendChild(live);
  }
  if (node.actions.length > 0) {
    const actions = document.createElement('span');
    actions.className = 'ag-node-actions-badge';
    actions.textContent = `▶${node.actions.length}`;
    header.appendChild(actions);
  }
  card.appendChild(header);

  const title = document.createElement('div');
  title.className = 'ag-node-title';
  title.textContent = node.title;
  card.appendChild(title);

  if (node.state) {
    const state = document.createElement('div');
    state.className = 'ag-node-state';
    state.textContent = node.state;
    card.appendChild(state);
  }
  if (node.date) {
    const date = document.createElement('div');
    date.className = 'ag-node-date';
    date.textContent = formatDate(node.date);
    card.appendChild(date);
  }
  return card;
}

function renderEdges(graph: ActionGraph): void {
  if (!edgesSvg || !nodesHost) return;
  const centers = new Map<string, { x: number; y: number }>();
  for (const element of nodesHost.querySelectorAll<HTMLElement>('.ag-node')) {
    const nodeId = element.dataset.nodeId;
    if (!nodeId) continue;
    centers.set(nodeId, {
      x: element.offsetLeft + element.offsetWidth / 2,
      y: element.offsetTop + element.offsetHeight / 2,
    });
  }

  for (const edge of graph.edges) {
    const from = centers.get(edge.fromId);
    const to = centers.get(edge.toId);
    if (!from || !to) continue;

    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', String(from.x));
    line.setAttribute('y1', String(from.y));
    line.setAttribute('x2', String(to.x));
    line.setAttribute('y2', String(to.y));
    line.setAttribute('class', 'ag-edge');
    edgesSvg.appendChild(line);

    if (edge.label) {
      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('x', String((from.x + to.x) / 2));
      label.setAttribute('y', String((from.y + to.y) / 2 - 6));
      label.setAttribute('class', 'ag-edge-label');
      label.textContent = edge.label;
      edgesSvg.appendChild(label);
    }
  }
}

function applyStageTransform(): void {
  if (!stage) return;
  stage.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
}

function wireCanvasInteractions(): void {
  if (!canvas) return;

  let mode: 'none' | 'pan' | 'node' = 'none';
  let dragNodeId: string | null = null;
  let dragNodeEl: HTMLElement | null = null;
  let moved = false;
  let startClientX = 0;
  let startClientY = 0;
  let startPanX = 0;
  let startPanY = 0;
  let startNodeX = 0;
  let startNodeY = 0;

  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const nodeEl = (event.target as HTMLElement).closest<HTMLElement>('.ag-node');
    moved = false;
    startClientX = event.clientX;
    startClientY = event.clientY;
    if (nodeEl?.dataset.nodeId) {
      mode = 'node';
      dragNodeId = nodeEl.dataset.nodeId;
      dragNodeEl = nodeEl;
      startNodeX = nodeEl.offsetLeft;
      startNodeY = nodeEl.offsetTop;
    } else {
      mode = 'pan';
      startPanX = panX;
      startPanY = panY;
    }
    canvas?.setPointerCapture(event.pointerId);
  });

  canvas.addEventListener('pointermove', (event) => {
    if (mode === 'none') return;
    const deltaX = event.clientX - startClientX;
    const deltaY = event.clientY - startClientY;
    if (!moved && Math.abs(deltaX) + Math.abs(deltaY) > 4) {
      moved = true;
    }
    if (!moved) return;

    if (mode === 'pan') {
      panX = startPanX + deltaX;
      panY = startPanY + deltaY;
      applyStageTransform();
    } else if (dragNodeEl) {
      dragNodeEl.style.left = `${startNodeX + deltaX / zoom}px`;
      dragNodeEl.style.top = `${startNodeY + deltaY / zoom}px`;
      if (currentGraph) renderEdges(currentGraph);
    }
  });

  const finish = (): void => {
    if (mode === 'node' && dragNodeId) {
      if (moved && dragNodeEl && currentGraphId) {
        const x = dragNodeEl.offsetLeft;
        const y = dragNodeEl.offsetTop;
        const node = currentGraph?.nodes.find((candidate) => candidate.id === dragNodeId);
        if (node) {
          node.x = x;
          node.y = y;
        }
        void persistNodePosition(currentGraphId, dragNodeId, x, y);
      } else if (!moved) {
        selectNode(dragNodeId);
      }
    }
    mode = 'none';
    dragNodeId = null;
    dragNodeEl = null;
  };

  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);

  const wheelHost = canvas;
  wheelHost.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      const rect = wheelHost.getBoundingClientRect();
      const cursorX = event.clientX - rect.left;
      const cursorY = event.clientY - rect.top;
      const nextZoom = Math.min(
        MAX_ZOOM,
        Math.max(MIN_ZOOM, zoom * Math.exp(-event.deltaY * 0.001)),
      );
      panX = cursorX - ((cursorX - panX) / zoom) * nextZoom;
      panY = cursorY - ((cursorY - panY) / zoom) * nextZoom;
      zoom = nextZoom;
      applyStageTransform();
    },
    { passive: false },
  );
}

function selectNode(nodeId: string | null): void {
  selectedNodeId = nodeId;
  for (const element of nodesHost?.querySelectorAll<HTMLElement>('.ag-node') ?? []) {
    element.classList.toggle('selected', element.dataset.nodeId === nodeId);
  }
  renderDetail();
}

function renderDetail(): void {
  if (!detailPanel) return;
  const node = currentGraph?.nodes.find((candidate) => candidate.id === selectedNodeId) ?? null;
  detailPanel.classList.toggle('hidden', node === null);
  detailPanel.replaceChildren();
  if (!node) return;

  const header = document.createElement('header');
  const title = document.createElement('h2');
  title.textContent = node.title;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'ag-detail-close';
  close.textContent = '×';
  close.setAttribute('aria-label', t('actionGraphs.close'));
  close.addEventListener('click', () => {
    selectNode(null);
  });
  header.append(title, close);
  detailPanel.appendChild(header);

  const meta = document.createElement('dl');
  meta.className = 'ag-detail-meta';
  appendMeta(meta, 'actionGraphs.kind', node.kind);
  appendMeta(meta, 'actionGraphs.state', node.state);
  appendMeta(meta, 'actionGraphs.updated', formatDate(node.updatedAt));
  appendMeta(meta, 'actionGraphs.date', node.date ? formatDate(node.date) : null);
  appendMeta(meta, 'actionGraphs.project', node.project);
  appendMeta(meta, 'actionGraphs.path', node.path ?? node.host);
  detailPanel.appendChild(meta);

  if (node.url) {
    const link = document.createElement('a');
    link.href = node.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.className = 'ag-detail-link';
    link.textContent = node.url;
    detailPanel.appendChild(link);
  }

  if (node.html) {
    const frame = document.createElement('iframe');
    frame.className = 'ag-detail-html';
    frame.setAttribute('sandbox', '');
    const rootStyle = getComputedStyle(document.documentElement);
    const textColor = rootStyle.getPropertyValue('--text-secondary').trim();
    const linkColor = rootStyle.getPropertyValue('--accent-blue').trim();
    frame.srcdoc = `<style>body{margin:0;font:13px/1.5 system-ui,sans-serif;color:${textColor};background:transparent;word-break:break-word}a{color:${linkColor}}</style>${node.html}`;
    detailPanel.appendChild(frame);
  }

  const actions = document.createElement('div');
  actions.className = 'ag-detail-actions';
  if (node.actions.length === 0) {
    const none = document.createElement('p');
    none.className = 'ag-detail-noactions';
    none.textContent = t('actionGraphs.noActions');
    actions.appendChild(none);
  }
  for (const action of node.actions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ag-detail-run';
    button.textContent = `▶ ${action.label}`;
    if (action.prompt) button.title = action.prompt;
    button.addEventListener('click', () => {
      button.disabled = true;
      void runNodeAction(node.title, action)
        .then((sessionId) => {
          closeActionGraphsView();
          options?.onSelectSession(sessionId);
        })
        .catch((error: unknown) => {
          log.warn(() => `Action launch failed: ${String(error)}`);
          button.disabled = false;
        });
    });
    actions.appendChild(button);
  }
  detailPanel.appendChild(actions);
}

function appendMeta(
  list: HTMLDListElement,
  labelKey: string,
  value: string | null | undefined,
): void {
  if (!value) return;
  const term = document.createElement('dt');
  term.textContent = t(labelKey);
  const detail = document.createElement('dd');
  detail.textContent = value;
  list.append(term, detail);
}

function formatDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}
