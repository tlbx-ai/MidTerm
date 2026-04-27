import { describe, expect, it } from 'vitest';
import { reconcileKeyedChildren } from './domReconcile';

class FakeElement {
  readonly dataset: Record<string, string> = {};
  readonly children: FakeElement[] = [];
  parent: FakeElement | null = null;
  textContent = '';

  constructor(readonly name: string) {}

  insertBefore(child: FakeElement, before: FakeElement | null): FakeElement {
    child.remove();
    const index = before ? this.children.indexOf(before) : -1;
    child.parent = this;
    if (index >= 0) {
      this.children.splice(index, 0, child);
    } else {
      this.children.push(child);
    }
    return child;
  }

  remove(): void {
    if (!this.parent) {
      return;
    }

    const index = this.parent.children.indexOf(this);
    if (index >= 0) {
      this.parent.children.splice(index, 1);
    }
    this.parent = null;
  }
}

interface Item {
  id: string;
  label: string;
}

function asElement(element: FakeElement): HTMLElement {
  return element as unknown as HTMLElement;
}

function childrenOf(parent: FakeElement): FakeElement[] {
  return parent.children;
}

describe('reconcileKeyedChildren', () => {
  it('patches existing keyed children without replacing their nodes', () => {
    const parent = new FakeElement('parent');
    const created: FakeElement[] = [];

    reconcileKeyedChildren(asElement(parent), [{ id: 'a', label: 'Alpha' }], {
      key: (item) => item.id,
      create: (item) => {
        const element = new FakeElement(item.id);
        created.push(element);
        return asElement(element);
      },
      patch: (element, item) => {
        element.textContent = item.label;
      },
    });

    const original = childrenOf(parent)[0];
    reconcileKeyedChildren(asElement(parent), [{ id: 'a', label: 'Updated' }], {
      key: (item) => item.id,
      create: (item) => asElement(new FakeElement(item.id)),
      patch: (element, item) => {
        element.textContent = item.label;
      },
    });

    expect(childrenOf(parent)[0]).toBe(original);
    expect(childrenOf(parent)[0]?.textContent).toBe('Updated');
    expect(created).toHaveLength(1);
  });

  it('moves existing keyed children when order changes', () => {
    const parent = new FakeElement('parent');
    const view = {
      key: (item: Item) => item.id,
      create: (item: Item) => asElement(new FakeElement(item.id)),
      patch: (element: HTMLElement, item: Item) => {
        element.textContent = item.label;
      },
    };

    reconcileKeyedChildren(
      asElement(parent),
      [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
      view,
    );
    const firstA = childrenOf(parent)[0];
    const firstB = childrenOf(parent)[1];

    reconcileKeyedChildren(
      asElement(parent),
      [
        { id: 'b', label: 'B' },
        { id: 'a', label: 'A' },
      ],
      view,
    );

    expect(childrenOf(parent)).toEqual([firstB, firstA]);
  });

  it('destroys removed keyed children', () => {
    const parent = new FakeElement('parent');
    const destroyed: string[] = [];
    const view = {
      key: (item: Item) => item.id,
      create: (item: Item) => asElement(new FakeElement(item.id)),
      patch: (element: HTMLElement, item: Item) => {
        element.textContent = item.label;
      },
      destroy: (element: HTMLElement) => {
        destroyed.push(element.textContent ?? '');
      },
    };

    reconcileKeyedChildren(
      asElement(parent),
      [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
      view,
    );
    reconcileKeyedChildren(asElement(parent), [{ id: 'b', label: 'B' }], view);

    expect(destroyed).toEqual(['A']);
    expect(childrenOf(parent).map((child) => child.name)).toEqual(['b']);
  });

  it('rejects duplicate desired keys', () => {
    const parent = new FakeElement('parent');

    expect(() =>
      reconcileKeyedChildren(
        asElement(parent),
        [
          { id: 'a', label: 'A' },
          { id: 'a', label: 'Again' },
        ],
        {
          key: (item) => item.id,
          create: (item) => asElement(new FakeElement(item.id)),
          patch: () => {},
        },
      ),
    ).toThrow('Duplicate keyed DOM child: a');
  });
});

