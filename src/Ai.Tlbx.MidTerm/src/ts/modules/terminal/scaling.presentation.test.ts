import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalState } from '../../types';
import {
  isTerminalVisible,
  remeasureTerminalCells,
  refreshTerminalRenderer,
} from './presentationRefresh';

describe('presentationRefresh', () => {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;

  beforeEach(() => {
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }) as typeof requestAnimationFrame;
  });

  afterEach(() => {
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  });

  it('detects terminal visibility from connection, hidden state, and client rects', () => {
    const container = {
      isConnected: true,
      offsetWidth: 640,
      classList: {
        contains: () => false,
      },
      getClientRects: () => [{ width: 640, height: 480 }],
    };

    expect(isTerminalVisible({ container } as Pick<TerminalState, 'container'>)).toBe(true);

    const hiddenContainer = {
      ...container,
      classList: {
        contains: (name: string) => name === 'hidden',
      },
    };

    expect(
      isTerminalVisible({ container: hiddenContainer } as Pick<TerminalState, 'container'>),
    ).toBe(false);
  });

  it('forces a renderer remeasure and redraw for visible terminals', () => {
    const container = {
      isConnected: true,
      offsetWidth: 640,
      classList: {
        contains: () => false,
      },
      getClientRects: () => [{ width: 640, height: 480 }],
    };

    const measure = vi.fn();
    const clear = vi.fn();
    const handleResize = vi.fn();
    const clearTextureAtlas = vi.fn();
    const refresh = vi.fn();

    const state = {
      terminal: {
        cols: 80,
        rows: 24,
        clearTextureAtlas,
        refresh,
        _core: {
          _charSizeService: { measure },
          _renderService: { clear, handleResize },
        },
      },
      fitAddon: {},
      container,
      serverCols: 80,
      serverRows: 24,
      opened: true,
      pendingVisualRefresh: false,
    } as unknown as TerminalState;

    refreshTerminalRenderer(state);

    expect(measure).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledOnce();
    expect(handleResize).toHaveBeenCalledWith(80, 24);
    expect(clearTextureAtlas).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledWith(0, 23);
  });

  it('can remeasure terminal cells without clearing the WebGL glyph atlas', () => {
    const container = {
      isConnected: true,
      offsetWidth: 640,
      classList: {
        contains: () => false,
      },
      getClientRects: () => [{ width: 640, height: 480 }],
    };

    const measure = vi.fn();
    const clearTextureAtlas = vi.fn();
    const refresh = vi.fn();

    const state = {
      terminal: {
        cols: 80,
        rows: 24,
        clearTextureAtlas,
        refresh,
        _core: {
          _charSizeService: { measure },
        },
      },
      fitAddon: {} as never,
      container,
      serverCols: 80,
      serverRows: 24,
      opened: true,
      pendingVisualRefresh: false,
    } as unknown as TerminalState;

    remeasureTerminalCells(state);

    expect(measure).toHaveBeenCalledOnce();
    expect(clearTextureAtlas).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('still refreshes safely when private xterm services are missing', () => {
    const container = {
      isConnected: true,
      offsetWidth: 640,
      classList: {
        contains: () => false,
      },
      getClientRects: () => [{ width: 640, height: 480 }],
    };

    const clearTextureAtlas = vi.fn();
    const refresh = vi.fn();
    const state = {
      terminal: {
        cols: 80,
        rows: 24,
        clearTextureAtlas,
        refresh,
      },
      fitAddon: {},
      container,
      serverCols: 80,
      serverRows: 24,
      opened: true,
      pendingVisualRefresh: false,
    } as unknown as TerminalState;

    refreshTerminalRenderer(state);

    expect(clearTextureAtlas).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledWith(0, 23);
  });
});
