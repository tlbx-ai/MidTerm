import { describe, expect, it, vi } from 'vitest';
import { SessionSubscriptionSet } from './sessionSubscriptions';

describe('SessionSubscriptionSet', () => {
  it('subscribes every session restored into the session list', () => {
    const subscriptions = new SessionSubscriptionSet();
    const subscribe = vi.fn();
    const unsubscribe = vi.fn();

    subscriptions.sync(['session-a', 'session-b'], subscribe, unsubscribe);

    expect(subscribe.mock.calls).toEqual([['session-a'], ['session-b']]);
    expect(unsubscribe).not.toHaveBeenCalled();
  });

  it('keeps unchanged sessions and removes sessions no longer visible', () => {
    const subscriptions = new SessionSubscriptionSet();
    const subscribe = vi.fn();
    const unsubscribe = vi.fn();
    subscriptions.sync(['session-a', 'session-b'], subscribe, unsubscribe);
    subscribe.mockClear();

    subscriptions.sync(['session-b', 'session-c'], subscribe, unsubscribe);

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledWith('session-a');
    expect(subscribe).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledWith('session-c');
  });
});
