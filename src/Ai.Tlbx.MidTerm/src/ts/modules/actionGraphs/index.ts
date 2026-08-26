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
import { reconcileKeyedChildren } from '../../utils/domReconcile';
import { isActionGraphsAvailable } from './availability';
import { disambiguateGraphLabels } from './graphLabels';
import {
  bindSession,
  createEdge,
  createGraph,
  createScope,
  deleteEdge,
  deleteGraph,
  deleteNode,
  fetchGraph,
  fetchGraphList,
  fetchScopes,
  organizeGraph,
  persistNodePosition,
  runGraphRefresh,
  runNodeAction,
  saveGraphRefresh,
  type ActionGraph,
  type ActionGraphNode,
  type ActionGraphScope,
} from './graphApi';
import { renderNodeEditor } from './nodeEditor';
import { graphBounds, nodeSearchText, nodeSize } from './graphGeometry';
import { renderGraphEdges } from './edgeRenderer';
import { createInteractionRenderScheduler } from './viewportRenderScheduler';

interface ActionGraphsViewOptions {
  onSelectSession: (sessionId: string) => void;
}

const log = createLogger('actionGraphs');
const REFRESH_INTERVAL_MS = 5000;
const MIN_ZOOM = 0.04;
const MAX_ZOOM = 4;
const VIEWPORT_OVERSCAN_PX = 420;
const COMPACT_ZOOM = 0.52;
const MAX_VISIBLE_NODES = 1_200;
const MAX_VISIBLE_EDGES = 2_500;

let options: ActionGraphsViewOptions | null = null;
let view: HTMLElement | null = null;
let canvas: HTMLElement | null = null;
let stage: HTMLElement | null = null;
let edgesSvg: SVGSVGElement | null = null;
let nodesHost: HTMLElement | null = null;
let emptyHint: HTMLElement | null = null;
let detailPanel: HTMLElement | null = null;
let graphSelect: HTMLSelectElement | null = null;
let minimap: HTMLCanvasElement | null = null;
let zoomHud: HTMLElement | null = null;
let graphStats: HTMLElement | null = null;
let attentionButton: HTMLButtonElement | null = null;
let hiddenButton: HTMLButtonElement | null = null;

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
let lastFitGraphId: string | null = null;
let renderFrame: number | null = null;
let searchQuery = '';
let visibleNodeIds = new Set<string>();
let showHidden = false;
let attentionCursor = 0;
let edgeRenderKey = '';
const interactionRenderer = createInteractionRenderScheduler(
  window,
  commitStageTransform,
  scheduleViewportRender,
);

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
  minimap = document.getElementById('ag-minimap') as HTMLCanvasElement | null;
  zoomHud = document.getElementById('ag-zoom-hud');
  graphStats = document.getElementById('ag-graph-stats');
  attentionButton = document.getElementById('ag-attention') as HTMLButtonElement | null;
  hiddenButton = document.getElementById('ag-show-hidden') as HTMLButtonElement | null;

  document.getElementById('btn-action-graphs')?.addEventListener('click', toggleActionGraphsView);
  document.getElementById('action-graphs-close')?.addEventListener('click', closeActionGraphsView);
  document.getElementById('ag-fit')?.addEventListener('click', fitView);
  document.getElementById('ag-organize')?.addEventListener('click', () => {
    if (!currentGraphId || !currentGraph) return;
    const graphId = currentGraphId;
    void organizeGraph(graphId, currentGraph.revision)
      .then((graph) => {
        currentGraph = graph;
        lastFitGraphId = null;
        renderGraph();
      })
      .catch((error: unknown) => {
        log.warn(() => `Graph organization conflicted or failed: ${String(error)}`);
        void refreshGraphs();
      });
  });
  graphSelect?.addEventListener('change', () => {
    currentGraphId = graphSelect?.value || null;
    selectNode(null);
    void refreshGraphs();
  });
  document.getElementById('ag-search')?.addEventListener('input', (event) => {
    searchQuery = (event.currentTarget as HTMLInputElement).value.trim().toLocaleLowerCase();
    scheduleViewportRender();
  });
  minimap?.addEventListener('pointerdown', navigateFromMinimap);
  attentionButton?.addEventListener('click', focusNextAttentionNode);
  hiddenButton?.addEventListener('click', () => {
    showHidden = !showHidden;
    hiddenButton?.classList.toggle('active', showHidden);
    lastFitGraphId = null;
    renderGraph();
  });
  wireHeaderControls();
  wireCanvasInteractions();

  $currentSettings.subscribe(syncButtonVisibility);
}

function syncButtonVisibility(): void {
  const enabled = isActionGraphsAvailable($currentSettings.get());
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
  cancelViewportRender();
  currentGraph = null;
  currentGraphId = null;
  lastFitGraphId = null;
  selectedNodeId = null;
  searchQuery = '';
  showHidden = false;
  attentionCursor = 0;
  hiddenButton?.classList.remove('active');
  const searchInput = document.getElementById('ag-search') as HTMLInputElement | null;
  if (searchInput) searchInput.value = '';
  visibleNodeIds.clear();
  edgeRenderKey = '';
  nodesHost?.replaceChildren();
  edgesSvg?.replaceChildren();
  detailPanel?.replaceChildren();
  detailPanel?.classList.add('hidden');
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
    const selectedGraphId = resolveGraphId(graphList.map((graph) => graph.id));
    if (!selectedGraphId) {
      currentGraphId = null;
      currentGraph = null;
      renderGraph();
      return;
    }
    currentGraphId = selectedGraphId;
    if (graphSelect) graphSelect.value = selectedGraphId;
    const selectedSummary = graphList.find((graph) => graph.id === selectedGraphId);
    if (isLoadedGraphCurrent(selectedGraphId, selectedSummary?.revision)) {
      scheduleViewportRender();
      return;
    }
    const nextGraph = await fetchGraph(selectedGraphId, abort.signal);
    const graphChanged =
      currentGraph?.id !== nextGraph.id || currentGraph.revision !== nextGraph.revision;
    currentGraph = nextGraph;
    syncRefreshControls();
    if (graphChanged) {
      renderGraph();
    } else {
      scheduleViewportRender();
    }
  } catch (error) {
    if (!abort.signal.aborted) {
      log.warn(() => `Graph refresh failed: ${String(error)}`);
    }
  }
}

function resolveGraphId(graphIds: readonly string[]): string | null {
  if (currentGraphId && graphIds.includes(currentGraphId)) return currentGraphId;
  return graphIds[0] ?? null;
}

function isLoadedGraphCurrent(graphId: string, revision: number | undefined): boolean {
  return currentGraph?.id === graphId && currentGraph.revision === revision;
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

  document.getElementById('ag-save-refresh')?.addEventListener('click', () => {
    if (!currentGraphId) return;
    const spec = {
      refreshCommand: refreshInput('ag-refresh-command'),
      refreshCwd: refreshInput('ag-refresh-cwd'),
      refreshPrompt: refreshInput('ag-refresh-prompt'),
    };
    void saveGraphRefresh(
      currentGraphId,
      currentGraph ? { ...spec, expectedRevision: currentGraph.revision } : spec,
    ).then(() => refreshGraphs());
  });

  const syncButton = document.getElementById('ag-sync') as HTMLButtonElement | null;
  syncButton?.addEventListener('click', () => {
    if (!currentGraph?.refreshCommand) return;
    syncButton.disabled = true;
    void runGraphRefresh(currentGraph, $currentSettings.get()?.actionGraphsDefaultCwd)
      .then((sessionId) => {
        syncButton.disabled = false;
        closeActionGraphsView();
        options?.onSelectSession(sessionId);
      })
      .catch((error: unknown) => {
        log.warn(() => `Graph refresh launch failed: ${String(error)}`);
        syncButton.disabled = false;
      });
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
    void deleteGraph(currentGraphId, currentGraph?.revision)
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
  for (const graph of disambiguateGraphLabels(graphs)) {
    const option = document.createElement('option');
    option.value = graph.id;
    option.textContent = graph.label;
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

  const graph = currentGraph;
  emptyHint.classList.toggle('hidden', graph !== null && graph.nodes.length > 0);
  if (!graph) {
    nodesHost.replaceChildren();
    edgesSvg.replaceChildren();
    visibleNodeIds.clear();
    edgeRenderKey = '';
    updateGraphStats(0);
    drawMinimap();
    renderDetail();
    return;
  }
  renderDetail();

  if (graph.nodes.length > 0 && currentGraphId !== lastFitGraphId) {
    lastFitGraphId = currentGraphId;
    fitView();
  } else {
    scheduleViewportRender();
  }
}

function refreshInput(id: string): string {
  return (document.getElementById(id) as HTMLInputElement | null)?.value.trim() ?? '';
}

/** Mirror the loaded graph's refresh spec into the manage inputs and Sync button. */
function syncRefreshControls(): void {
  const setValue = (id: string, value: string | null | undefined): void => {
    const input = document.getElementById(id) as HTMLInputElement | null;
    if (input && document.activeElement !== input) input.value = value ?? '';
  };
  setValue('ag-refresh-command', currentGraph?.refreshCommand);
  setValue('ag-refresh-cwd', currentGraph?.refreshCwd);
  setValue('ag-refresh-prompt', currentGraph?.refreshPrompt);
  document
    .getElementById('ag-sync')
    ?.classList.toggle('hidden', !currentGraph?.refreshCommand?.trim());
}

/** Fit the whole board into the visible canvas while honoring negative coordinates. */
function fitView(): void {
  if (!canvas || !currentGraph || currentGraph.nodes.length === 0) return;
  const bounds = graphBounds(currentGraph.nodes.filter((node) => showHidden || !node.hidden));
  if (bounds.width <= 0 || bounds.height <= 0) return;
  const pad = 32;
  zoom = Math.max(
    MIN_ZOOM,
    Math.min(
      (canvas.clientWidth - pad * 2) / bounds.width,
      (canvas.clientHeight - pad * 2) / bounds.height,
      1,
    ),
  );
  panX = pad - bounds.left * zoom;
  panY = pad - bounds.top * zoom;
  applyStageTransform();
  scheduleViewportRender();
}

function buildNodeCard(node: ActionGraphNode, runningSessions: Set<string>): HTMLElement {
  const card = document.createElement('div');
  patchNodeCard(card, node, runningSessions);
  return card;
}

function patchNodeCard(
  card: HTMLElement,
  node: ActionGraphNode,
  runningSessions: Set<string>,
): void {
  const isFrame = node.kind === 'frame';
  const runningKey = sessionIds(node)
    .filter((id) => runningSessions.has(id))
    .sort()
    .join(',');
  const renderKey = [
    node.revision,
    node.id === selectedNodeId ? 1 : 0,
    zoom < COMPACT_ZOOM && !isFrame ? 1 : 0,
    runningKey,
  ].join(':');
  if (card.dataset.renderKey === renderKey) return;
  card.dataset.renderKey = renderKey;
  ensureNodeCardShape(card, isFrame);
  card.dataset.nodeId = node.id;
  card.dataset.kind = node.kind;
  card.style.left = `${node.x}px`;
  card.style.top = `${node.y}px`;
  card.style.width = `${node.width ?? (isFrame ? 360 : 224)}px`;
  card.style.height = node.height ? `${node.height}px` : isFrame ? '240px' : '';
  applyNodeColor(card, node.color);
  card.classList.toggle('selected', node.id === selectedNodeId);
  card.classList.toggle('ag-node-pinned', node.pinned);
  card.classList.toggle('ag-node-attention', node.attention);
  card.classList.toggle('ag-node-hidden-revealed', node.hidden);
  card.classList.toggle('ag-node-compact', zoom < COMPACT_ZOOM && !isFrame);

  if (isFrame) {
    patchFrameCard(card, node);
    return;
  }
  patchLeafCard(card, node, runningSessions);
}

function ensureNodeCardShape(card: HTMLElement, isFrame: boolean): void {
  if (card.classList.contains('ag-frame') === isFrame && card.childElementCount > 0) return;
  card.replaceChildren();
  card.className = isFrame ? 'ag-node ag-frame' : 'ag-node';
  if (isFrame) {
    const chip = document.createElement('div');
    chip.className = 'ag-frame-title';
    card.appendChild(chip);
    return;
  }
  const header = document.createElement('div');
  header.className = 'ag-node-top';
  const kind = document.createElement('span');
  kind.className = 'ag-node-kind';
  const live = document.createElement('span');
  live.className = 'ag-node-live hidden';
  const actions = document.createElement('span');
  actions.className = 'ag-node-actions-badge';
  header.append(kind, live, actions);
  const title = document.createElement('div');
  title.className = 'ag-node-title';
  const state = document.createElement('div');
  state.className = 'ag-node-state';
  const date = document.createElement('div');
  date.className = 'ag-node-date';
  card.append(header, title, state, date);
}

function applyNodeColor(card: HTMLElement, color: string | null | undefined): void {
  if (color) card.style.setProperty('--ag-node-accent', color);
  else card.style.removeProperty('--ag-node-accent');
}

function patchFrameCard(card: HTMLElement, node: ActionGraphNode): void {
  const chip = card.querySelector<HTMLElement>('.ag-frame-title');
  if (chip) chip.textContent = node.title;
}

function patchLeafCard(
  card: HTMLElement,
  node: ActionGraphNode,
  runningSessions: Set<string>,
): void {
  const kind = card.querySelector<HTMLElement>('.ag-node-kind');
  if (kind) kind.textContent = node.kind;
  const title = card.querySelector<HTMLElement>('.ag-node-title');
  if (title) title.textContent = node.title;
  const state = card.querySelector<HTMLElement>('.ag-node-state');
  if (state) {
    state.textContent = node.state ?? '';
    state.classList.toggle('hidden', !node.state);
  }
  const date = card.querySelector<HTMLElement>('.ag-node-date');
  if (date) {
    date.textContent = node.date ? formatDate(node.date) : '';
    date.classList.toggle('hidden', !node.date);
  }
  const boundSessionIds = sessionIds(node);
  const running = boundSessionIds.filter((id) => runningSessions.has(id));
  const live = card.querySelector<HTMLElement>('.ag-node-live');
  if (live) {
    live.classList.toggle('hidden', running.length === 0);
    live.title = running.join(', ');
  }
  const actions = card.querySelector<HTMLElement>('.ag-node-actions-badge');
  if (actions) {
    const parts: string[] = [];
    if (boundSessionIds.length > 0) parts.push(`◉${boundSessionIds.length}`);
    if (node.actions.length > 0) parts.push(`▶${node.actions.length}`);
    actions.textContent = parts.join(' ');
  }
}

function renderEdges(graph: ActionGraph): void {
  if (!edgesSvg || !nodesHost) return;
  edgeRenderKey = renderGraphEdges({
    edgesSvg,
    nodesHost,
    graph,
    visibleNodeIds,
    compact: zoom < COMPACT_ZOOM,
    maxVisibleEdges: MAX_VISIBLE_EDGES,
    previousRenderKey: edgeRenderKey,
  });
}

function scheduleViewportRender(): void {
  if (!$actionGraphsOpen.get() || renderFrame !== null) return;
  renderFrame = window.requestAnimationFrame(() => {
    renderFrame = null;
    renderViewport();
  });
}

function cancelViewportRender(): void {
  if (renderFrame !== null) {
    window.cancelAnimationFrame(renderFrame);
    renderFrame = null;
  }
  interactionRenderer.cancel();
}

function renderViewport(): void {
  if (!canvas || !nodesHost || !edgesSvg || !currentGraph) return;
  const graph = currentGraph;
  const viewport = worldViewport();
  const centerX = (viewport.left + viewport.right) / 2;
  const centerY = (viewport.top + viewport.bottom) / 2;
  const matching = graph.nodes.filter((node) => nodeVisible(node, viewport));
  if (matching.length > MAX_VISIBLE_NODES) {
    matching.sort((a, b) => {
      if (a.id === selectedNodeId) return -1;
      if (b.id === selectedNodeId) return 1;
      if (a.attention !== b.attention) return a.attention ? -1 : 1;
      const aDistance = Math.abs(a.x - centerX) + Math.abs(a.y - centerY);
      const bDistance = Math.abs(b.x - centerX) + Math.abs(b.y - centerY);
      return aDistance - bDistance;
    });
  }
  const visible = matching.slice(0, MAX_VISIBLE_NODES);
  visibleNodeIds = new Set(visible.map((node) => node.id));

  const runningSessions = new Set(
    $sessionList
      .get()
      .filter((session) => session.isRunning)
      .map((session) => session.id),
  );
  reconcileKeyedChildren(nodesHost, visible, {
    key: (node) => node.id,
    create: (node) => buildNodeCard(node, runningSessions),
    patch: (element, node) => {
      patchNodeCard(element, node, runningSessions);
    },
  });
  renderEdges(graph);
  updateGraphStats(visible.length);
  drawMinimap();
  if (zoomHud) zoomHud.textContent = `${Math.round(zoom * 100)}%`;
}

interface WorldViewport {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function worldViewport(): WorldViewport {
  if (!canvas) return { left: 0, top: 0, right: 0, bottom: 0 };
  const overscan = VIEWPORT_OVERSCAN_PX / zoom;
  return {
    left: -panX / zoom - overscan,
    top: -panY / zoom - overscan,
    right: (canvas.clientWidth - panX) / zoom + overscan,
    bottom: (canvas.clientHeight - panY) / zoom + overscan,
  };
}

function nodeVisible(node: ActionGraphNode, viewport: WorldViewport): boolean {
  if (node.hidden && !showHidden) return false;
  if (!visibleAtZoom(node)) return false;
  if (searchQuery && !nodeSearchText(node).includes(searchQuery)) return false;
  const { width, height } = nodeSize(node);
  return (
    node.x + width >= viewport.left &&
    node.x <= viewport.right &&
    node.y + height >= viewport.top &&
    node.y <= viewport.bottom
  );
}

function visibleAtZoom(node: ActionGraphNode): boolean {
  if (node.attention) return true;
  if (node.minZoom !== null && node.minZoom !== undefined && zoom < node.minZoom) return false;
  if (node.maxZoom !== null && node.maxZoom !== undefined && zoom > node.maxZoom) return false;
  return true;
}

function updateGraphStats(visibleCount: number): void {
  const graph = currentGraph;
  if (graphStats) {
    graphStats.textContent = graph
      ? `${visibleCount}/${graph.nodes.length} nodes · ${graph.edges.length} edges · r${graph.revision}`
      : '';
  }
  const attentionCount = graph?.nodes.filter((node) => node.attention && !node.hidden).length ?? 0;
  const hiddenCount = graph?.nodes.filter((node) => node.hidden).length ?? 0;
  if (attentionButton) {
    attentionButton.textContent = `${attentionCount} ${t('actionGraphs.attention')}`;
    attentionButton.classList.toggle('hidden', attentionCount === 0);
  }
  if (hiddenButton) {
    hiddenButton.textContent = `${hiddenCount} ${t('actionGraphs.hidden')}`;
    hiddenButton.classList.toggle('hidden', hiddenCount === 0);
  }
}

function sessionIds(node: ActionGraphNode): string[] {
  const ids = new Set(node.sessions.map((binding) => binding.sessionId));
  if (node.sessionId) ids.add(node.sessionId);
  return [...ids];
}

function drawMinimap(): void {
  if (!minimap || !canvas) return;
  const context = minimap.getContext('2d');
  if (!context) return;
  const ratio = window.devicePixelRatio || 1;
  const width = minimap.clientWidth;
  const height = minimap.clientHeight;
  if (
    minimap.width !== Math.round(width * ratio) ||
    minimap.height !== Math.round(height * ratio)
  ) {
    minimap.width = Math.round(width * ratio);
    minimap.height = Math.round(height * ratio);
  }
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  const graph = currentGraph;
  if (!graph || graph.nodes.length === 0) return;
  const displayedNodes = graph.nodes.filter((node) => showHidden || !node.hidden);
  const bounds = graphBounds(displayedNodes);
  const scale = Math.min(width / Math.max(bounds.width, 1), height / Math.max(bounds.height, 1));
  const offsetX = (width - bounds.width * scale) / 2 - bounds.left * scale;
  const offsetY = (height - bounds.height * scale) / 2 - bounds.top * scale;
  const rootStyle = getComputedStyle(document.documentElement);
  const defaultColor = rootStyle.getPropertyValue('--text-muted').trim();
  const attentionColor = rootStyle.getPropertyValue('--accent-gold').trim();
  context.globalAlpha = 0.55;
  for (const node of displayedNodes) {
    const size = nodeSize(node);
    context.fillStyle = node.attention ? attentionColor : defaultColor;
    context.fillRect(
      offsetX + node.x * scale,
      offsetY + node.y * scale,
      Math.max(1, size.width * scale),
      Math.max(1, size.height * scale),
    );
  }
  const viewport = worldViewport();
  context.globalAlpha = 1;
  context.strokeStyle = getComputedStyle(document.documentElement)
    .getPropertyValue('--accent-blue')
    .trim();
  context.lineWidth = 1.5;
  context.strokeRect(
    offsetX + viewport.left * scale,
    offsetY + viewport.top * scale,
    (viewport.right - viewport.left) * scale,
    (viewport.bottom - viewport.top) * scale,
  );
}

function focusNextAttentionNode(): void {
  if (!canvas || !currentGraph) return;
  const nodes = currentGraph.nodes.filter((node) => node.attention && !node.hidden);
  if (nodes.length === 0) return;
  const node = nodes[attentionCursor % nodes.length];
  if (!node) return;
  attentionCursor++;
  const size = nodeSize(node);
  zoom = Math.max(zoom, 0.72);
  panX = canvas.clientWidth / 2 - (node.x + size.width / 2) * zoom;
  panY = canvas.clientHeight / 2 - (node.y + size.height / 2) * zoom;
  applyStageTransform();
  selectNode(node.id);
}

function navigateFromMinimap(event: PointerEvent): void {
  if (!minimap || !canvas || !currentGraph || currentGraph.nodes.length === 0) return;
  event.preventDefault();
  const bounds = graphBounds(currentGraph.nodes);
  const rect = minimap.getBoundingClientRect();
  const scale = Math.min(
    rect.width / Math.max(bounds.width, 1),
    rect.height / Math.max(bounds.height, 1),
  );
  const offsetX = (rect.width - bounds.width * scale) / 2 - bounds.left * scale;
  const offsetY = (rect.height - bounds.height * scale) / 2 - bounds.top * scale;
  const worldX = (event.clientX - rect.left - offsetX) / scale;
  const worldY = (event.clientY - rect.top - offsetY) / scale;
  panX = canvas.clientWidth / 2 - worldX * zoom;
  panY = canvas.clientHeight / 2 - worldY * zoom;
  applyStageTransform();
}

function commitStageTransform(): void {
  if (!stage || !canvas) return;
  stage.style.transform = `translate3d(${panX}px, ${panY}px, 0) scale(${zoom})`;
  if (zoomHud) zoomHud.textContent = `${Math.round(zoom * 100)}%`;
}

function applyStageTransform(): void {
  interactionRenderer.cancel();
  commitStageTransform();
  scheduleViewportRender();
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
      interactionRenderer.schedule();
    } else if (dragNodeEl) {
      dragNodeEl.style.left = `${startNodeX + deltaX / zoom}px`;
      dragNodeEl.style.top = `${startNodeY + deltaY / zoom}px`;
      edgeRenderKey = '';
      scheduleViewportRender();
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
          const expectedRevision = node.revision;
          void persistNodePosition(currentGraphId, dragNodeId, x, y, expectedRevision)
            .then((updated) => {
              Object.assign(node, updated);
              if (currentGraph) currentGraph.revision++;
              scheduleViewportRender();
            })
            .catch((error: unknown) => {
              log.warn(() => `Node move conflicted or failed: ${String(error)}`);
              void refreshGraphs();
            });
        }
      } else if (!moved) {
        selectNode(dragNodeId);
      }
    }
    if (mode === 'pan') {
      interactionRenderer.finish();
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
        void createEdge(currentGraphId, fromId, nodeId, currentGraph?.revision)
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
      interactionRenderer.schedule();
    },
    { passive: false },
  );
}

function selectNode(nodeId: string | null): void {
  selectedNodeId = nodeId;
  scheduleViewportRender();
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
  appendMeta(meta, 'actionGraphs.revision', String(node.revision));
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

  appendDetailSessions(detailPanel, node);
  detailPanel.appendChild(buildDetailActions(node));
}

function appendDetailSessions(panel: HTMLElement, node: ActionGraphNode): void {
  const boundSessions = sessionIds(node);
  if (boundSessions.length === 0) return;
  const sessions = document.createElement('div');
  sessions.className = 'ag-detail-sessions';
  for (const sessionId of boundSessions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ag-detail-session';
    button.textContent = `◉ ${sessionId}`;
    button.title = t('actionGraphs.openSession');
    button.addEventListener('click', () => {
      closeActionGraphsView();
      options?.onSelectSession(sessionId);
    });
    sessions.appendChild(button);
  }
  panel.appendChild(sessions);
}

function buildDetailActions(node: ActionGraphNode): HTMLElement {
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
      if (!currentGraphId) return;
      const graphId = currentGraphId;
      void runNodeAction(graphId, node, action, $currentSettings.get()?.actionGraphsDefaultCwd)
        .then((sessionId) => {
          // The executable leaf and the observable terminal are one durable unit.
          return bindSession(graphId, node.id, sessionId, action.id || action.label).then(() => {
            closeActionGraphsView();
            options?.onSelectSession(sessionId);
          });
        })
        .catch((error: unknown) => {
          log.warn(() => `Action launch failed: ${String(error)}`);
          button.disabled = false;
        });
    });
    actions.appendChild(button);
  }
  return actions;
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
    void deleteNode(currentGraphId, node.id, node.revision, currentGraph?.revision)
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
      void deleteEdge(currentGraphId, edge.id, currentGraph?.revision)
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
