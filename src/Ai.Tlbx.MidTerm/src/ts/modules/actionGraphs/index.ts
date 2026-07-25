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
  createEdge,
  createGraph,
  createScope,
  deleteEdge,
  deleteGraph,
  deleteNode,
  fetchGraph,
  fetchGraphList,
  fetchScopes,
  persistNodePosition,
  runNodeAction,
  type ActionGraph,
  type ActionGraphNode,
  type ActionGraphScope,
} from './graphApi';
import { renderNodeEditor } from './nodeEditor';

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
let scopes: ActionGraphScope[] = [];
let activeScopeId = 'default';
let editorOpen = false;
let connectFromId: string | null = null;
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
  wireHeaderControls();
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
  if (editorOpen) return;
  refreshAbort?.abort();
  const abort = new AbortController();
  refreshAbort = abort;

  try {
    scopes = await fetchScopes(abort.signal);
    if (!scopes.some((scope) => scope.id === activeScopeId)) {
      activeScopeId = 'default';
    }
    renderScopeSelect();

    const allGraphs = await fetchGraphList(abort.signal);
    const graphList = allGraphs.filter((graph) => graph.scopeId === activeScopeId);
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

function renderScopeSelect(): void {
  const scopeSelect = document.getElementById('action-graphs-scope') as HTMLSelectElement | null;
  if (!scopeSelect) return;
  scopeSelect.replaceChildren();
  for (const scope of scopes) {
    const option = document.createElement('option');
    option.value = scope.id;
    option.textContent = scope.name;
    scopeSelect.appendChild(option);
  }
  scopeSelect.value = activeScopeId;
  // Most users never leave the default scope; keep the selector quiet until a second scope exists.
  scopeSelect.classList.toggle('hidden', scopes.length <= 1);
}

function wireHeaderControls(): void {
  const scopeSelect = document.getElementById('action-graphs-scope') as HTMLSelectElement | null;
  scopeSelect?.addEventListener('change', () => {
    activeScopeId = scopeSelect.value;
    currentGraphId = null;
    selectNode(null);
    void refreshGraphs();
  });

  document.getElementById('ag-new-node')?.addEventListener('click', () => {
    if (!currentGraphId || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    openEditor(null, {
      x: Math.round((rect.width / 2 - panX) / zoom - 100),
      y: Math.round((rect.height / 2 - panY) / zoom - 40),
    });
  });

  const managePanel = document.getElementById('ag-manage-panel');
  document.getElementById('ag-manage')?.addEventListener('click', () => {
    managePanel?.classList.toggle('hidden');
  });

  document.getElementById('ag-create-graph')?.addEventListener('click', () => {
    const input = document.getElementById('ag-new-graph-name') as HTMLInputElement | null;
    const name = input?.value.trim();
    if (!name) return;
    const id = slugify(name);
    void createGraph(id, name, activeScopeId)
      .then(() => {
        if (input) input.value = '';
        currentGraphId = id;
        managePanel?.classList.add('hidden');
        void refreshGraphs();
      })
      .catch((error: unknown) => {
        log.warn(() => `Graph create failed: ${String(error)}`);
      });
  });

  document.getElementById('ag-create-scope')?.addEventListener('click', () => {
    const input = document.getElementById('ag-new-scope-name') as HTMLInputElement | null;
    const name = input?.value.trim();
    if (!name) return;
    const id = slugify(name);
    void createScope(id, name)
      .then(() => {
        if (input) input.value = '';
        activeScopeId = id;
        currentGraphId = null;
        managePanel?.classList.add('hidden');
        void refreshGraphs();
      })
      .catch((error: unknown) => {
        log.warn(() => `Scope create failed: ${String(error)}`);
      });
  });

  const deleteButton = document.getElementById('ag-delete-graph');
  deleteButton?.addEventListener('click', () => {
    if (!currentGraphId) return;
    if (deleteButton.dataset.confirm !== 'armed') {
      deleteButton.dataset.confirm = 'armed';
      deleteButton.textContent = t('actionGraphs.deleteGraphConfirm');
      window.setTimeout(() => {
        deleteButton.dataset.confirm = '';
        deleteButton.textContent = t('actionGraphs.deleteGraph');
      }, 3000);
      return;
    }
    deleteButton.dataset.confirm = '';
    deleteButton.textContent = t('actionGraphs.deleteGraph');
    void deleteGraph(currentGraphId)
      .then(() => {
        currentGraphId = null;
        selectNode(null);
        managePanel?.classList.add('hidden');
        void refreshGraphs();
      })
      .catch((error: unknown) => {
        log.warn(() => `Graph delete failed: ${String(error)}`);
      });
  });
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || `g${Date.now().toString(36)}`;
}

function openEditor(node: ActionGraphNode | null, position: { x: number; y: number } | null): void {
  if (!detailPanel || !currentGraphId) return;
  editorOpen = true;
  connectFromId = null;
  detailPanel.classList.remove('hidden');
  renderNodeEditor(detailPanel, {
    graphId: currentGraphId,
    node,
    position,
    onSaved: () => {
      editorOpen = false;
      void refreshGraphs();
    },
    onCancel: () => {
      editorOpen = false;
      renderDetail();
    },
  });
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

  // Frames paint first so they sit behind the cards they group.
  const ordered = [...graph.nodes].sort(
    (a, b) => Number(b.kind === 'frame') - Number(a.kind === 'frame'),
  );
  for (const node of ordered) {
    nodesHost.appendChild(buildNodeCard(node, runningSessions));
  }
  renderEdges(graph);
  renderDetail();
}

function buildNodeCard(node: ActionGraphNode, runningSessions: Set<string>): HTMLElement {
  if (node.kind === 'frame') {
    return buildFrameCard(node);
  }
  const card = document.createElement('div');
  card.className = 'ag-node';
  card.dataset.nodeId = node.id;
  card.dataset.kind = node.kind;
  card.style.left = `${node.x}px`;
  card.style.top = `${node.y}px`;
  if (node.width) card.style.width = `${node.width}px`;
  if (node.height) card.style.height = `${node.height}px`;
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

/**
 * Frames are calm background regions used to group cards. The region itself is
 * click-through (panning and card drag keep working inside it); only the title
 * chip is interactive for selecting and moving the frame.
 */
function buildFrameCard(node: ActionGraphNode): HTMLElement {
  const frame = document.createElement('div');
  frame.className = 'ag-node ag-frame';
  frame.dataset.nodeId = node.id;
  frame.dataset.kind = node.kind;
  frame.style.left = `${node.x}px`;
  frame.style.top = `${node.y}px`;
  frame.style.width = `${node.width ?? 360}px`;
  frame.style.height = `${node.height ?? 240}px`;
  if (node.color) frame.style.setProperty('--ag-node-accent', node.color);
  if (node.id === selectedNodeId) frame.classList.add('selected');

  const chip = document.createElement('div');
  chip.className = 'ag-frame-title';
  chip.textContent = node.title;
  frame.appendChild(chip);
  return frame;
}

interface EdgeRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Anchor the edge on the facing card sides so curves flow between cards instead of piercing them. */
function edgeEndpoints(
  from: EdgeRect,
  to: EdgeRect,
): { x1: number; y1: number; x2: number; y2: number; horizontal: boolean } {
  const fromCx = from.left + from.width / 2;
  const fromCy = from.top + from.height / 2;
  const toCx = to.left + to.width / 2;
  const toCy = to.top + to.height / 2;
  if (Math.abs(toCx - fromCx) >= Math.abs(toCy - fromCy)) {
    const fromRight = toCx >= fromCx;
    return {
      x1: fromRight ? from.left + from.width : from.left,
      y1: fromCy,
      x2: fromRight ? to.left : to.left + to.width,
      y2: toCy,
      horizontal: true,
    };
  }
  const fromBelow = toCy >= fromCy;
  return {
    x1: fromCx,
    y1: fromBelow ? from.top + from.height : from.top,
    x2: toCx,
    y2: fromBelow ? to.top : to.top + to.height,
    horizontal: false,
  };
}

function buildArrowMarker(): SVGElement {
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
  marker.setAttribute('id', 'ag-arrow');
  marker.setAttribute('viewBox', '0 0 10 10');
  marker.setAttribute('refX', '9');
  marker.setAttribute('refY', '5');
  marker.setAttribute('markerWidth', '6');
  marker.setAttribute('markerHeight', '6');
  marker.setAttribute('orient', 'auto-start-reverse');
  const tip = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  tip.setAttribute('d', 'M 0 1 L 9 5 L 0 9 z');
  tip.setAttribute('class', 'ag-edge-arrow');
  marker.appendChild(tip);
  defs.appendChild(marker);
  return defs;
}

function renderEdges(graph: ActionGraph): void {
  if (!edgesSvg || !nodesHost) return;
  // Also called per pointermove while dragging — must always start from an empty layer.
  edgesSvg.replaceChildren();
  const rects = new Map<string, EdgeRect>();
  for (const element of nodesHost.querySelectorAll<HTMLElement>('.ag-node')) {
    const nodeId = element.dataset.nodeId;
    if (!nodeId) continue;
    rects.set(nodeId, {
      left: element.offsetLeft,
      top: element.offsetTop,
      width: element.offsetWidth,
      height: element.offsetHeight,
    });
  }

  edgesSvg.appendChild(buildArrowMarker());

  for (const edge of graph.edges) {
    const from = rects.get(edge.fromId);
    const to = rects.get(edge.toId);
    if (!from || !to) continue;

    const { x1, y1, x2, y2, horizontal } = edgeEndpoints(from, to);
    const bend = Math.max(36, (horizontal ? Math.abs(x2 - x1) : Math.abs(y2 - y1)) / 2);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const controls = horizontal
      ? `${x1 + Math.sign(x2 - x1) * bend} ${y1}, ${x2 - Math.sign(x2 - x1) * bend} ${y2}`
      : `${x1} ${y1 + Math.sign(y2 - y1) * bend}, ${x2} ${y2 - Math.sign(y2 - y1) * bend}`;
    path.setAttribute('d', `M ${x1} ${y1} C ${controls}, ${x2} ${y2}`);
    path.setAttribute('class', 'ag-edge');
    path.setAttribute('marker-end', 'url(#ag-arrow)');
    edgesSvg.appendChild(path);

    if (edge.label) {
      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('x', String((x1 + x2) / 2));
      label.setAttribute('y', String((y1 + y2) / 2 - 5));
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
  let suppressNextClick = false;
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
    if (moved) {
      suppressNextClick = true;
    }
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

  // Selection also works from plain click events (keyboard activation and
  // browser automation dispatch click without a pointer sequence).
  canvas.addEventListener('click', (event) => {
    if (suppressNextClick) {
      suppressNextClick = false;
      return;
    }
    const nodeEl = (event.target as HTMLElement).closest<HTMLElement>('.ag-node');
    const nodeId = nodeEl?.dataset.nodeId;
    if (connectFromId) {
      const fromId = connectFromId;
      connectFromId = null;
      canvas?.classList.remove('ag-connecting');
      if (nodeId && nodeId !== fromId && currentGraphId) {
        void createEdge(currentGraphId, fromId, nodeId)
          .then(() => refreshGraphs())
          .catch((error: unknown) => {
            log.warn(() => `Edge create failed: ${String(error)}`);
          });
      }
      return;
    }
    if (nodeId) {
      selectNode(nodeId);
    }
  });

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
  if (!detailPanel || editorOpen) return;
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
    // Sandboxed srcdoc documents default to a light color-scheme, which makes Chromium
    // paint an opaque white canvas — carry the host theme background in explicitly.
    const bgColor =
      rootStyle.getPropertyValue('--bg-settings-opaque').trim() ||
      rootStyle.getPropertyValue('--bg-settings').trim();
    frame.srcdoc = `<style>body{margin:0;padding:2px;font:13px/1.5 system-ui,sans-serif;color:${textColor};background:${bgColor};word-break:break-word}a{color:${linkColor}}p{margin:0 0 8px}p:last-child{margin-bottom:0}</style>${node.html}`;
    detailPanel.appendChild(frame);
  }

  detailPanel.appendChild(buildDetailEditRow(node));
  const edgeList = buildDetailEdgeList(node);
  if (edgeList) {
    detailPanel.appendChild(edgeList);
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

function buildDetailEditRow(node: ActionGraphNode): HTMLElement {
  const editRow = document.createElement('div');
  editRow.className = 'ag-detail-edit-row';
  const editButton = document.createElement('button');
  editButton.type = 'button';
  editButton.textContent = t('actionGraphs.edit');
  editButton.addEventListener('click', () => {
    openEditor(node, null);
  });
  const connectButton = document.createElement('button');
  connectButton.type = 'button';
  connectButton.textContent = t('actionGraphs.connect');
  connectButton.title = t('actionGraphs.connectHint');
  connectButton.addEventListener('click', () => {
    connectFromId = node.id;
    canvas?.classList.add('ag-connecting');
  });
  const deleteNodeButton = document.createElement('button');
  deleteNodeButton.type = 'button';
  deleteNodeButton.className = 'ag-detail-delete';
  deleteNodeButton.textContent = t('actionGraphs.deleteNode');
  deleteNodeButton.addEventListener('click', () => {
    if (deleteNodeButton.dataset.confirm !== 'armed') {
      deleteNodeButton.dataset.confirm = 'armed';
      deleteNodeButton.textContent = t('actionGraphs.deleteNodeConfirm');
      window.setTimeout(() => {
        deleteNodeButton.dataset.confirm = '';
        deleteNodeButton.textContent = t('actionGraphs.deleteNode');
      }, 3000);
      return;
    }
    if (!currentGraphId) return;
    void deleteNode(currentGraphId, node.id)
      .then(() => {
        selectNode(null);
        void refreshGraphs();
      })
      .catch((error: unknown) => {
        log.warn(() => `Node delete failed: ${String(error)}`);
      });
  });
  editRow.append(editButton, connectButton, deleteNodeButton);
  return editRow;
}

function buildDetailEdgeList(node: ActionGraphNode): HTMLElement | null {
  const connectedEdges = (currentGraph?.edges ?? []).filter(
    (edge) => edge.fromId === node.id || edge.toId === node.id,
  );
  if (connectedEdges.length === 0) {
    return null;
  }

  const edgeList = document.createElement('ul');
  edgeList.className = 'ag-detail-edges';
  for (const edge of connectedEdges) {
    const item = document.createElement('li');
    const otherId = edge.fromId === node.id ? edge.toId : edge.fromId;
    const other = currentGraph?.nodes.find((candidate) => candidate.id === otherId);
    const direction = edge.fromId === node.id ? '→' : '←';
    const text = document.createElement('span');
    text.textContent = `${direction} ${other?.title ?? otherId}${edge.label ? ` (${edge.label})` : ''}`;
    const removeEdge = document.createElement('button');
    removeEdge.type = 'button';
    removeEdge.textContent = '×';
    removeEdge.title = t('actionGraphs.removeEdge');
    removeEdge.addEventListener('click', () => {
      if (!currentGraphId) return;
      void deleteEdge(currentGraphId, edge.id)
        .then(() => refreshGraphs())
        .catch((error: unknown) => {
          log.warn(() => `Edge delete failed: ${String(error)}`);
        });
    });
    item.append(text, removeEdge);
    edgeList.appendChild(item);
  }
  return edgeList;
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
  if (Number.isNaN(parsed.getTime())) return value;
  const datePart = parsed.toLocaleDateString(undefined, {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
  });
  if (parsed.getHours() === 0 && parsed.getMinutes() === 0) return datePart;
  const timePart = parsed.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `${datePart} ${timePart}`;
}
