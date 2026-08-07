import type { ActionGraph } from './graphApi';

interface EdgeRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface EdgeEndpoints {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  horizontal: boolean;
}

interface RenderGraphEdgesOptions {
  edgesSvg: SVGSVGElement;
  nodesHost: HTMLElement;
  graph: ActionGraph;
  visibleNodeIds: ReadonlySet<string>;
  compact: boolean;
  maxVisibleEdges: number;
  previousRenderKey: string;
}

/** Anchor curves on facing card sides instead of piercing the cards. */
function edgeEndpoints(from: EdgeRect, to: EdgeRect): EdgeEndpoints {
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

function collectNodeRects(nodesHost: HTMLElement): Map<string, EdgeRect> {
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
  return rects;
}

function appendEdge(
  edgesSvg: SVGSVGElement,
  edge: ActionGraph['edges'][number],
  from: EdgeRect,
  to: EdgeRect,
): void {
  const { x1, y1, x2, y2, horizontal } = edgeEndpoints(from, to);
  const distance = horizontal ? Math.abs(x2 - x1) : Math.abs(y2 - y1);
  const bend = Math.max(36, distance / 2);
  const controls = horizontal
    ? `${x1 + Math.sign(x2 - x1) * bend} ${y1}, ${x2 - Math.sign(x2 - x1) * bend} ${y2}`
    : `${x1} ${y1 + Math.sign(y2 - y1) * bend}, ${x2} ${y2 - Math.sign(y2 - y1) * bend}`;
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', `M ${x1} ${y1} C ${controls}, ${x2} ${y2}`);
  path.setAttribute('class', 'ag-edge');
  path.setAttribute('marker-end', 'url(#ag-arrow)');
  edgesSvg.appendChild(path);
  if (!edge.label) return;
  const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  label.setAttribute('x', String((x1 + x2) / 2));
  label.setAttribute('y', String((y1 + y2) / 2 - 5));
  label.setAttribute('class', 'ag-edge-label');
  label.textContent = edge.label;
  edgesSvg.appendChild(label);
}

export function renderGraphEdges(options: RenderGraphEdgesOptions): string {
  const {
    edgesSvg,
    nodesHost,
    graph,
    visibleNodeIds,
    compact,
    maxVisibleEdges,
    previousRenderKey,
  } = options;
  const nextRenderKey = `${graph.revision}:${compact ? 1 : 0}:${[...visibleNodeIds].join(',')}`;
  if (previousRenderKey === nextRenderKey) return previousRenderKey;
  edgesSvg.replaceChildren(buildArrowMarker());
  const rects = collectNodeRects(nodesHost);
  let renderedEdges = 0;
  for (const edge of graph.edges) {
    if (renderedEdges >= maxVisibleEdges) break;
    if (!visibleNodeIds.has(edge.fromId) || !visibleNodeIds.has(edge.toId)) continue;
    const from = rects.get(edge.fromId);
    const to = rects.get(edge.toId);
    if (!from || !to) continue;
    appendEdge(edgesSvg, edge, from, to);
    renderedEdges++;
  }
  return nextRenderKey;
}
