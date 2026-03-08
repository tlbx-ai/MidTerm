import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  syncInlineTextInputWrappers,
  updateInlineTextInputWrapperState,
} from './inlineInputState';

class MockClassList {
  private readonly _classes = new Set<string>();

  public add(...names: string[]): void {
    names.forEach((name) => this._classes.add(name));
  }

  public remove(...names: string[]): void {
    names.forEach((name) => this._classes.delete(name));
  }

  public toggle(name: string, force?: boolean): boolean {
    if (force === true) {
      this._classes.add(name);
      return true;
    }

    if (force === false) {
      this._classes.delete(name);
      return false;
    }

    if (this._classes.has(name)) {
      this._classes.delete(name);
      return false;
    }

    this._classes.add(name);
    return true;
  }

  public contains(name: string): boolean {
    return this._classes.has(name);
  }
}

class MockHTMLElement {
  public readonly classList = new MockClassList();
  public readonly dataset: Record<string, string> = {};
  public querySelector(_selector: string): unknown {
    return null;
  }
}

class MockHTMLInputElement extends MockHTMLElement {
  public value = '';
  public closest(_selector: string): unknown {
    return null;
  }
}

const originalHTMLElement = globalThis.HTMLElement;
const originalHTMLInputElement = globalThis.HTMLInputElement;

beforeAll(() => {
  Object.assign(globalThis, {
    HTMLElement: MockHTMLElement,
    HTMLInputElement: MockHTMLInputElement,
  });
});

afterAll(() => {
  Object.assign(globalThis, {
    HTMLElement: originalHTMLElement,
    HTMLInputElement: originalHTMLInputElement,
  });
});

describe('inlineInputState', () => {
  it('syncs wrappers to the current saved values and clears unsaved state', () => {
    const input = new MockHTMLInputElement();
    input.value = '18';

    const wrapper = new MockHTMLElement();
    wrapper.classList.add('unsaved');
    wrapper.querySelector = () => input;

    const root = {
      querySelectorAll: () => [wrapper],
    } as ParentNode;

    syncInlineTextInputWrappers(root);

    expect(wrapper.classList.contains('unsaved')).toBe(false);
    expect(wrapper.dataset.savedValue).toBe('18');
  });

  it('toggles unsaved state against the last saved value', () => {
    const wrapper = new MockHTMLElement();
    wrapper.dataset.savedValue = '14';

    const input = new MockHTMLInputElement();
    input.value = '16';
    input.closest = () => wrapper;

    updateInlineTextInputWrapperState(input);
    expect(wrapper.classList.contains('unsaved')).toBe(true);

    input.value = '14';
    updateInlineTextInputWrapperState(input);
    expect(wrapper.classList.contains('unsaved')).toBe(false);
  });
});
