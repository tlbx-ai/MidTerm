import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getCollapsedSmartInputTextareaHeight,
  resizeSmartInputTextarea,
} from './smartInputMetrics';

interface FakeTextarea {
  clientHeight: number;
  dataset: Record<string, string | undefined>;
  scrollHeight: number;
  scrollTop: number;
  style: {
    cssText?: string;
    fontSize: string;
    height: string;
    lineHeight: string;
    minHeight: string;
    overflowY: string;
    setPropertyValue?: Record<string, string>;
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
    setPropertyValue: {},
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
        return;
      }
      if (name === 'height') {
        this.height = value;
        return;
      }
      this.setPropertyValue![name] = value;
    },
  };

  return {
    clientHeight: 0,
    dataset: {},
    scrollHeight,
    scrollTop: 0,
    style,
  } as HTMLTextAreaElement;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('smartInputMetrics', () => {
  it('pins the rendered box with an inline min-height while caching the collapsed size', () => {
    const textarea = createTextarea(100);
    vi.stubGlobal(
      'getComputedStyle',
      (target: HTMLTextAreaElement) =>
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
    expect(
      (textarea.style as FakeTextarea['style']).setPropertyValue?.[
        '--smart-input-textarea-rendered-height'
      ],
    ).toBe('102px');
  });

  it('caps the visible height and enables scrolling once content exceeds the overlay limit', () => {
    const textarea = createTextarea(320);
    vi.stubGlobal(
      'getComputedStyle',
      (target: HTMLTextAreaElement) =>
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

  it('preserves the current internal scroll offset while the composer stays overflowed', () => {
    const textarea = createTextarea(320);
    textarea.clientHeight = 166;
    textarea.scrollTop = 72;
    vi.stubGlobal(
      'getComputedStyle',
      (target: HTMLTextAreaElement) =>
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
    expect(textarea.style.overflowY).toBe('auto');
    expect(textarea.scrollTop).toBe(72);
  });

  it('keeps collapsed prompts pinned to the control height without overflow', () => {
    const textarea = createTextarea(26);
    vi.stubGlobal(
      'getComputedStyle',
      (target: HTMLTextAreaElement) =>
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

    expect(textarea.style.height).toBe('44px');
    expect(textarea.style.minHeight).toBe('44px');
    expect(
      (textarea.style as FakeTextarea['style']).setPropertyValue?.[
        '--smart-input-textarea-rendered-height'
      ],
    ).toBe('44px');
  });
});
