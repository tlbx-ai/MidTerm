import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getCollapsedSmartInputTextareaHeight,
  resizeSmartInputTextarea,
} from './smartInputMetrics';

interface FakeTextarea {
  dataset: Record<string, string | undefined>;
  scrollHeight: number;
  style: {
    fontSize: string;
    height: string;
    lineHeight: string;
    minHeight: string;
    overflowY: string;
    removeProperty: (name: string) => void;
    setProperty: (name: string, value: string) => void;
  };
}

function createTextarea(scrollHeight: number): HTMLTextAreaElement {
  const style: FakeTextarea['style'] = {
    fontSize: '16px',
    height: '',
    lineHeight: '18px',
    minHeight: '44px',
    overflowY: '',
    removeProperty(name: string) {
      if (name === 'min-height') {
        this.minHeight = '';
      }
      if (name === 'height') {
        this.height = '';
      }
    },
    setProperty(name: string, value: string) {
      if (name === 'min-height') {
        this.minHeight = value;
      }
      if (name === 'height') {
        this.height = value;
      }
    },
  };

  return {
    dataset: {},
    scrollHeight,
    style,
  } as HTMLTextAreaElement;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('smartInputMetrics', () => {
  it('pins the rendered box with an inline min-height while caching the collapsed size', () => {
    const textarea = createTextarea(100);
    vi.stubGlobal('getComputedStyle', (target: HTMLTextAreaElement) =>
      ({
        borderBottomWidth: '1px',
        borderTopWidth: '1px',
        fontSize: target.style.fontSize || '16px',
        lineHeight: target.style.lineHeight || '18px',
        minHeight: target.style.minHeight || '44px',
        paddingBottom: '10px',
        paddingTop: '10px',
      }) as CSSStyleDeclaration,
    );

    resizeSmartInputTextarea(textarea);

    expect(textarea.style.height).toBe('102px');
    expect(textarea.style.minHeight).toBe('102px');
    expect(textarea.dataset.midtermCollapsedHeightPx).toBe('44');
    expect(getCollapsedSmartInputTextareaHeight(textarea)).toBe(44);
    expect(textarea.style.overflowY).toBe('hidden');
  });

  it('caps the visible height and enables scrolling once content exceeds the overlay limit', () => {
    const textarea = createTextarea(320);
    vi.stubGlobal('getComputedStyle', (target: HTMLTextAreaElement) =>
      ({
        borderBottomWidth: '1px',
        borderTopWidth: '1px',
        fontSize: target.style.fontSize || '16px',
        lineHeight: target.style.lineHeight || '18px',
        minHeight: target.style.minHeight || '44px',
        paddingBottom: '10px',
        paddingTop: '10px',
      }) as CSSStyleDeclaration,
    );

    resizeSmartInputTextarea(textarea);

    expect(textarea.style.height).toBe('166px');
    expect(textarea.style.minHeight).toBe('166px');
    expect(textarea.style.overflowY).toBe('auto');
    expect(getCollapsedSmartInputTextareaHeight(textarea)).toBe(44);
  });
});
