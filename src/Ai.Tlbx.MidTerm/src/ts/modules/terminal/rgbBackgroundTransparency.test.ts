import { describe, expect, it } from 'vitest';

import { applyInlineBackgroundTransparencyToRenderedRows } from './rgbBackgroundTransparency';

class FakeChildren {
  private readonly values: FakeElement[] = [];

  get length(): number {
    return this.values.length;
  }

  add(value: FakeElement): void {
    this.values.push(value);
  }

  item(index: number): FakeElement | null {
    return this.values[index] ?? null;
  }
}

class FakeStyle {
  backgroundColor = '';
}

class FakeElement {
  readonly style = new FakeStyle();
  readonly children = new FakeChildren();

  constructor(
    readonly id: string | null = null,
    readonly className: string | null = null,
  ) {}

  appendChild(child: FakeElement): void {
    this.children.add(child);
  }

  querySelector(selector: string): FakeElement | null {
    if (selector.startsWith('#') && this.id === selector.slice(1)) {
      return this;
    }

    if (selector.startsWith('.') && this.className === selector.slice(1)) {
      return this;
    }

    for (let index = 0; index < this.children.length; index++) {
      const child = this.children.item(index);
      const match = child?.querySelector(selector) ?? null;
      if (match) {
        return match;
      }
    }

    return null;
  }
}

function createRenderedTerminal(): FakeElement {
  const container = new FakeElement();
  const rows = new FakeElement(null, 'xterm-rows');
  container.appendChild(rows);

  const firstRow = new FakeElement();
  const firstCell = new FakeElement('first');
  firstCell.style.backgroundColor = 'rgb(16, 24, 32)';
  firstRow.appendChild(firstCell);
  rows.appendChild(firstRow);

  const secondRow = new FakeElement();
  const secondCell = new FakeElement('second');
  secondCell.style.backgroundColor = 'rgba(200, 100, 50, 0.5)';
  secondRow.appendChild(secondCell);
  rows.appendChild(secondRow);

  const thirdRow = new FakeElement();
  const thirdCell = new FakeElement('third');
  thirdCell.style.backgroundColor = 'rgb(1, 2, 3)';
  thirdRow.appendChild(thirdCell);
  rows.appendChild(thirdRow);

  return container;
}

describe('rgbBackgroundTransparency', () => {
  it('applies the requested alpha to inline terminal cell backgrounds', () => {
    const container = createRenderedTerminal();
    const first = container.querySelector<HTMLElement>('#first');
    const second = container.querySelector<HTMLElement>('#second');

    applyInlineBackgroundTransparencyToRenderedRows(container, 0, 1, 0.4);

    expect(first?.style.backgroundColor).toBe('rgba(16, 24, 32, 0.400)');
    expect(second?.style.backgroundColor).toBe('rgba(200, 100, 50, 0.200)');
  });

  it('reuses the original color when the alpha changes instead of compounding', () => {
    const container = createRenderedTerminal();
    const first = container.querySelector<HTMLElement>('#first');

    applyInlineBackgroundTransparencyToRenderedRows(container, 0, 0, 0.4);
    applyInlineBackgroundTransparencyToRenderedRows(container, 0, 0, 0.7);

    expect(first?.style.backgroundColor).toBe('rgba(16, 24, 32, 0.700)');
  });

  it('restores opaque inline backgrounds when transparency is disabled', () => {
    const container = createRenderedTerminal();
    const first = container.querySelector<HTMLElement>('#first');
    const third = container.querySelector<HTMLElement>('#third');

    applyInlineBackgroundTransparencyToRenderedRows(container, 0, 2, 0.35);
    applyInlineBackgroundTransparencyToRenderedRows(container, 0, 2, 1);

    expect(first?.style.backgroundColor).toBe('rgb(16, 24, 32)');
    expect(third?.style.backgroundColor).toBe('rgb(1, 2, 3)');
  });
});
