import { beforeEach, describe, expect, it, vi } from 'vitest';
import { $activeSessionId } from '../../stores';
import { initAppShellStatePersistence } from './appShellState';

describe('app shell state persistence', () => {
  const values = new Map<string, string>();

  beforeEach(() => {
    values.clear();
    values.set('midterm.activeSessionId', 'bookmarked-session');
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      removeItem: vi.fn((key: string) => values.delete(key)),
    });
    $activeSessionId.set(null);
  });

  it('preserves the remembered session until the initial server selection is known', () => {
    initAppShellStatePersistence();

    expect(values.get('midterm.activeSessionId')).toBe('bookmarked-session');

    $activeSessionId.set('selected-session');
    expect(values.get('midterm.activeSessionId')).toBe('selected-session');
  });
});
