import { describe, expect, it } from 'vitest';
import {
  createInteractionRenderScheduler,
  type InteractionRenderHost,
} from './viewportRenderScheduler';

function fakeHost(): InteractionRenderHost & {
  frames: Map<number, FrameRequestCallback>;
  timers: Map<number, () => void>;
} {
  let nextId = 1;
  const frames = new Map<number, FrameRequestCallback>();
  const timers = new Map<number, () => void>();
  return {
    frames,
    timers,
    requestAnimationFrame: (callback) => {
      const id = nextId++;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame: (id) => {
      frames.delete(id);
    },
    setTimeout: (callback) => {
      const id = nextId++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
    },
  };
}

describe('Action Graph interaction renderer', () => {
  it('coalesces transforms and reconciles once after the gesture settles', () => {
    const host = fakeHost();
    let commits = 0;
    let reconciles = 0;
    const scheduler = createInteractionRenderScheduler(
      host,
      () => commits++,
      () => reconciles++,
    );

    scheduler.schedule();
    scheduler.schedule();

    expect(host.frames.size).toBe(1);
    expect(host.timers.size).toBe(1);
    host.frames.values().next().value?.(0);
    host.timers.values().next().value?.();
    expect(commits).toBe(2);
    expect(reconciles).toBe(1);
  });

  it('finishes immediately and cancels pending work', () => {
    const host = fakeHost();
    let commits = 0;
    let reconciles = 0;
    const scheduler = createInteractionRenderScheduler(
      host,
      () => commits++,
      () => reconciles++,
    );

    scheduler.schedule();
    scheduler.finish();

    expect(host.frames.size).toBe(0);
    expect(host.timers.size).toBe(0);
    expect(commits).toBe(1);
    expect(reconciles).toBe(1);
  });
});
