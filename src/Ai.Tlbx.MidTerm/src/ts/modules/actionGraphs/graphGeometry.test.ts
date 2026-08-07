import { describe, expect, it } from 'vitest';
import type { ActionGraphNode } from './graphApi';
import { graphBounds, nodeSearchText, nodeSize } from './graphGeometry';

function node(
  fields: Partial<ActionGraphNode> & Pick<ActionGraphNode, 'id' | 'title'>,
): ActionGraphNode {
  return {
    kind: 'identity',
    x: 0,
    y: 0,
    pinned: false,
    attention: false,
    hidden: false,
    actions: [],
    sessions: [],
    source: 'agent',
    updatedAt: '2026-07-28T00:00:00Z',
    revision: 1,
    ...fields,
  };
}

describe('Action Graph geometry', () => {
  it('measures negative coordinates and typed node sizes', () => {
    const nodes = [
      node({ id: 'a', title: 'A', x: -100, y: -50 }),
      node({ id: 'b', title: 'B', kind: 'frame', x: 300, y: 200 }),
    ];

    expect(nodeSize(nodes[0]!)).toEqual({ width: 224, height: 92 });
    expect(graphBounds(nodes)).toEqual({ left: -100, top: -50, width: 760, height: 490 });
  });

  it('builds agent-search text without interpreting state', () => {
    const item = node({
      id: 'work',
      title: 'Deploy API',
      state: 'Needs approval',
      project: 'TLBX',
      path: 'Q:/repos/tlbx',
    });

    expect(nodeSearchText(item)).toBe('deploy api identity needs approval tlbx q:/repos/tlbx');
  });
});
