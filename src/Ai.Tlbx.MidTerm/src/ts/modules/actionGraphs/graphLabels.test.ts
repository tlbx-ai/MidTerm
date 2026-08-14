import { describe, expect, it } from 'vitest';
import { disambiguateGraphLabels } from './graphLabels';

describe('Action Graph labels', () => {
  it('adds ids only when display names collide', () => {
    expect(
      disambiguateGraphLabels([
        { id: 'work', name: 'Handlungsstränge' },
        { id: 'private', name: 'handlungsstränge' },
        { id: 'ops', name: 'Operations' },
      ]),
    ).toEqual([
      { id: 'work', name: 'Handlungsstränge', label: 'Handlungsstränge (work)' },
      { id: 'private', name: 'handlungsstränge', label: 'handlungsstränge (private)' },
      { id: 'ops', name: 'Operations', label: 'Operations' },
    ]);
  });
});
