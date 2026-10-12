import { describe, expect, it } from 'vitest';
import { FileSelection } from './selection';

describe('file selection', () => {
  it('selects a range from its stable anchor and toggles individual items', () => {
    const selection = new FileSelection(),
      order = ['a', 'b', 'c', 'd'];
    selection.select('b', order);
    selection.select('d', order, false, true);
    expect([...selection.paths]).toEqual(['b', 'c', 'd']);
    selection.select('c', order, true);
    expect([...selection.paths]).toEqual(['b', 'd']);
    selection.select('a', order, true);
    expect([...selection.paths]).toEqual(['b', 'd', 'a']);
  });
  it('retains only entries still present and restores a presentation snapshot', () => {
    const selection = new FileSelection();
    selection.restore(['b', 'c']);
    selection.retain(['a', 'c']);
    expect([...selection.paths]).toEqual(['c']);
    selection.select('a', ['a', 'c'], false, true);
    expect([...selection.paths]).toEqual(['a']);
  });
  it('adds a reversed Ctrl+Shift range without dropping another selected file', () => {
    const selection = new FileSelection(),
      order = ['a', 'b', 'c', 'd', 'e'];
    selection.select('a', order);
    selection.select('e', order, true);
    selection.select('c', order, true, true);
    expect([...selection.paths].sort()).toEqual(['a', 'c', 'd', 'e']);
  });
  it('restores the last selection anchor independently of Set insertion order', () => {
    const selection = new FileSelection(),
      order = ['a', 'b', 'c', 'd'];
    selection.select('b', order);
    selection.select('d', order, true);
    const restored = new FileSelection();
    restored.restore([...selection.paths], selection.anchorPath);
    restored.select('c', order, false, true);
    expect([...restored.paths]).toEqual(['c', 'd']);
  });
});
