import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequestActionBlock } from './historyRequestDom';

vi.mock('../../api/client', () => ({
  approveAppServerControlRequest: vi.fn(),
  declineAppServerControlRequest: vi.fn(),
  resolveAppServerControlUserInput: vi.fn(),
}));
vi.mock('../../utils/devErrorDialog', () => ({ showDevErrorDialog: vi.fn() }));

// The project uses a node test environment. This small DOM double keeps the
// real form's event handlers and draft/submit logic under test.
class Element {
  children: Element[] = [];
  parent: Element | null = null;
  className = '';
  textContent = '';
  type = '';
  name = '';
  value = '';
  checked = false;
  disabled = false;
  listeners = new Map<string, Array<(event: any) => void>>();
  constructor(readonly tag: string) {}
  appendChild(child: Element): Element {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  append(...children: Element[]): void {
    children.forEach((child) => this.appendChild(child));
  }
  setAttribute(): void {}
  addEventListener(type: string, listener: (event: any) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  fire(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ preventDefault() {} });
    this.parent?.fire(type);
  }
  all(): Element[] {
    return this.children.flatMap((child) => [child, ...child.all()]);
  }
  querySelectorAll(selector: string): Element[] {
    return this.all().filter((element) => {
      if (selector.startsWith('.')) return element.className.split(' ').includes(selector.slice(1));
      if (selector.startsWith('button'))
        return element.tag === 'button' && element.type === 'submit';
      if (selector.startsWith('input')) {
        const name = /name="([^"]+)"/.exec(selector)?.[1];
        return (
          element.tag === 'input' &&
          (!name || element.name === name) &&
          (!selector.includes(':checked') || element.checked)
        );
      }
      return element.tag === selector;
    });
  }
  querySelector(selector: string): Element | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

function form(multiSelect: boolean, custom: boolean, options = true) {
  const state: any = {
    requestDraftAnswersById: {},
    requestQuestionIndexById: {},
    requestBusyIds: new Set(),
  };
  const render = vi.fn();
  const request: any = {
    requestId: 'native-question',
    kind: 'interview',
    state: 'open',
    questions: [
      {
        id: 'color',
        header: 'Color',
        question: 'Choose a color',
        multiSelect,
        allowCustomAnswer: custom,
        options: options
          ? [
              { label: 'Blue', value: 'native-blue', description: 'Ocean' },
              { label: 'Green', value: 'native-green', description: 'Grass' },
            ]
          : [],
      },
    ],
  };
  const root = createRequestActionBlock({
    busy: false,
    deps: {
      getState: () => state,
      renderCurrentAgentView: render,
      refreshAppServerControlSnapshot: async () => {},
      logWarn: () => {},
    },
    appServerControlText: (_key, fallback) => fallback,
    appServerControlFormat: (_key, fallback) => fallback,
    request,
    sessionId: 'fixture',
    state,
    surface: 'composer',
  }) as unknown as Element;
  return {
    root,
    state,
    render,
    answers: () => state.requestDraftAnswersById['native-question'].color,
  };
}

beforeEach(() => {
  vi.stubGlobal('document', { createElement: (tag: string) => new Element(tag) });
  vi.stubGlobal('CSS', { escape: (value: string) => value });
});
afterEach(() => vi.unstubAllGlobals());

describe('native question custom answers', () => {
  it('keeps the focused text input and enables submission while typing a free answer', () => {
    const { root, answers, render } = form(false, true, false);
    const input = root.querySelector('.agent-request-input')!;
    const submit = root.querySelector('button[type="submit"]')!;
    expect(submit.disabled).toBe(true);
    input.value = 'Violet';
    input.fire('input');
    expect(answers()).toEqual(['Violet']);
    expect(submit.disabled).toBe(false);
    expect(root.querySelector('.agent-request-input')).toBe(input);
    expect(render).not.toHaveBeenCalled();
  });

  it('preserves both native multi-select values and a custom answer across choice edits', () => {
    const { root, answers, render } = form(true, true);
    const choices = root.querySelectorAll('input[name="color"]');
    const custom = root.querySelector('.agent-request-custom-input')!;
    choices[0]!.checked = true;
    choices[0]!.fire('change');
    custom.value = 'Violet';
    custom.fire('input');
    expect(answers()).toEqual(['native-blue', 'Violet']);
    choices[1]!.checked = true;
    choices[1]!.fire('change');
    expect(answers()).toEqual(['native-blue', 'native-green', 'Violet']);
    // Typing itself must not replace the form and steal focus.
    expect(render).toHaveBeenCalledTimes(2);
  });

  it('makes a custom single answer mutually exclusive with native choices', () => {
    const { root, answers } = form(false, true);
    const choice = root.querySelectorAll('input[name="color"]')[0]!;
    const custom = root.querySelector('.agent-request-custom-input')!;
    choice.checked = true;
    choice.fire('change');
    custom.value = 'Violet';
    custom.fire('input');
    expect(choice.checked).toBe(false);
    expect(answers()).toEqual(['Violet']);
    choice.checked = true;
    choice.fire('change');
    expect(custom.value).toBe('');
    expect(answers()).toEqual(['native-blue']);
  });

  it('does not offer an invented custom field when the native question forbids it', () => {
    const { root } = form(false, false);
    expect(root.querySelector('.agent-request-custom-input')).toBeNull();
  });
});
