import { describe, expect, it } from 'vitest';

import {
  allocateSmartInputComposerReferenceOrdinal,
  createSmartInputComposerDraft,
  deleteSmartInputComposerBackward,
  deleteSmartInputComposerForward,
  getSmartInputComposerReferenceIds,
  getSmartInputComposerText,
  insertSmartInputComposerReference,
  insertSmartInputComposerReferences,
  insertSmartInputComposerText,
  normalizeSmartInputComposerSelection,
  pruneSmartInputComposerReferences,
  removeSmartInputComposerReference,
  replaceSmartInputComposerText,
} from './smartInputComposerDraft';

const resolveReference = (referenceId: string) => {
  const tokenText =
    referenceId === 'img-1'
      ? '[Image 1]'
      : referenceId === 'img-2'
        ? '[Image 2]'
        : referenceId === 'file-1'
          ? '[File 1]'
          : null;
  return tokenText
    ? {
        referenceId,
        kind: referenceId.startsWith('img-') ? 'image' : 'file',
        label: tokenText.slice(1, -1),
        tokenText,
      }
    : null;
};

describe('smartInputComposerDraft', () => {
  it('inserts an atomic inline reference into the rendered draft text', () => {
    const draft = createSmartInputComposerDraft('Please compare  and  today.');
    const first = insertSmartInputComposerReference(
      draft,
      { start: 15, end: 15 },
      'img-1',
      resolveReference,
    );
    const second = insertSmartInputComposerReference(
      first.draft,
      { start: first.selection.start + 5, end: first.selection.end + 5 },
      'img-2',
      resolveReference,
    );

    expect(getSmartInputComposerText(second.draft, resolveReference)).toBe(
      'Please compare [Image 1] and [Image 2] today.',
    );
    expect(getSmartInputComposerReferenceIds(second.draft)).toEqual(['img-1', 'img-2']);
  });

  it('inserts multiple references with spacing when a paste adds more than one image', () => {
    const result = insertSmartInputComposerReferences(
      createSmartInputComposerDraft('Look at '),
      { start: 8, end: 8 },
      ['img-1', 'img-2'],
      resolveReference,
    );

    expect(getSmartInputComposerText(result.draft, resolveReference)).toBe(
      'Look at [Image 1] [Image 2]',
    );
  });

  it('expands partial selections to whole inline references', () => {
    const base = insertSmartInputComposerReference(
      createSmartInputComposerDraft('A  B'),
      { start: 2, end: 2 },
      'img-1',
      resolveReference,
    ).draft;

    expect(
      normalizeSmartInputComposerSelection(base, { start: 4, end: 7 }, resolveReference),
    ).toEqual({ start: 2, end: 11 });
  });

  it('deletes a whole inline reference on backspace', () => {
    const base = insertSmartInputComposerReference(
      createSmartInputComposerDraft('See '),
      { start: 4, end: 4 },
      'img-1',
      resolveReference,
    ).draft;

    const result = deleteSmartInputComposerBackward(base, { start: 13, end: 13 }, resolveReference);

    expect(getSmartInputComposerText(result.draft, resolveReference)).toBe('See ');
    expect(result.removedReferenceIds).toEqual(['img-1']);
    expect(result.selection).toEqual({ start: 4, end: 4 });
  });

  it('deletes a whole inline reference on delete', () => {
    const base = insertSmartInputComposerReference(
      createSmartInputComposerDraft('See '),
      { start: 4, end: 4 },
      'img-1',
      resolveReference,
    ).draft;

    const result = deleteSmartInputComposerForward(base, { start: 4, end: 4 }, resolveReference);

    expect(getSmartInputComposerText(result.draft, resolveReference)).toBe('See ');
    expect(result.removedReferenceIds).toEqual(['img-1']);
  });

  it('removes orphaned references when their backing attachment disappears', () => {
    const withReference = insertSmartInputComposerReference(
      createSmartInputComposerDraft('See '),
      { start: 4, end: 4 },
      'img-1',
      resolveReference,
    ).draft;

    const pruned = pruneSmartInputComposerReferences(withReference, new Set<string>());

    expect(getSmartInputComposerText(pruned, resolveReference)).toBe('See ');
    expect(getSmartInputComposerReferenceIds(pruned)).toEqual([]);
  });

  it('can remove a specific inline reference without touching surrounding text', () => {
    const draft = insertSmartInputComposerReference(
      createSmartInputComposerDraft('A  B'),
      { start: 2, end: 2 },
      'img-1',
      resolveReference,
    ).draft;

    expect(
      getSmartInputComposerText(
        removeSmartInputComposerReference(draft, 'img-1'),
        resolveReference,
      ),
    ).toBe('A  B');
  });

  it('tracks future reference ordinals without renumbering older references', () => {
    const draft = createSmartInputComposerDraft();
    expect(allocateSmartInputComposerReferenceOrdinal(draft, 'image')).toBe(1);
    expect(allocateSmartInputComposerReferenceOrdinal(draft, 'image')).toBe(2);
    expect(allocateSmartInputComposerReferenceOrdinal(draft, 'file')).toBe(1);
  });

  it('replaces the rendered draft text while preserving future ordinal allocation', () => {
    const draft = createSmartInputComposerDraft('Hello');
    allocateSmartInputComposerReferenceOrdinal(draft, 'image');
    const replaced = replaceSmartInputComposerText(draft, 'World');

    expect(getSmartInputComposerText(replaced, resolveReference)).toBe('World');
    expect(allocateSmartInputComposerReferenceOrdinal(replaced, 'image')).toBe(2);
  });

  it('inserts regular text through the same draft model used for references', () => {
    const base = insertSmartInputComposerReference(
      createSmartInputComposerDraft('A B'),
      { start: 2, end: 2 },
      'img-1',
      resolveReference,
    ).draft;
    const result = insertSmartInputComposerText(
      base,
      { start: 13, end: 13 },
      '!',
      resolveReference,
    );

    expect(getSmartInputComposerText(result.draft, resolveReference)).toBe('A [Image 1]B!');
  });
});
