import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ReconnectController } from './reconnect';

describe('ReconnectController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('cancels a scheduled reconnect when a connection opens explicitly', () => {
    const reconnect = new ReconnectController();
    const connect = vi.fn();

    reconnect.schedule(connect);
    reconnect.reset();
    vi.runAllTimers();

    expect(connect).not.toHaveBeenCalled();
  });

  it('runs only the latest scheduled reconnect', () => {
    const reconnect = new ReconnectController();
    const first = vi.fn();
    const second = vi.fn();

    reconnect.schedule(first);
    reconnect.schedule(second);
    vi.runAllTimers();

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });
});
