import type { ActionGraphNode } from './graphApi';

export function nodeSearchText(node: ActionGraphNode): string {
  return [node.title, node.kind, node.state, node.project, node.path, node.host]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase();
}

export function nodeSize(node: ActionGraphNode): { width: number; height: number } {
  return {
    width: node.width ?? (node.kind === 'frame' ? 360 : 224),
    height: node.height ?? (node.kind === 'frame' ? 240 : 92),
  };
}

export function graphBounds(nodes: readonly ActionGraphNode[]): {
  left: number;
  top: number;
  width: number;
  height: number;
} {
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const node of nodes) {
    const size = nodeSize(node);
    left = Math.min(left, node.x);
    top = Math.min(top, node.y);
    right = Math.max(right, node.x + size.width);
    bottom = Math.max(bottom, node.y + size.height);
  }
  if (!Number.isFinite(left)) return { left: 0, top: 0, width: 0, height: 0 };
  return { left, top, width: right - left, height: bottom - top };
}
