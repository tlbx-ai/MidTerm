import { describe, expect, it } from 'vitest';

import {
  resolveAppServerControlHistoryFetchAheadItems,
  resolveAppServerControlHistoryWindowTargetCount,
} from './historyVirtualizer';

describe('historyVirtualizer', () => {
  it('enforces a minimum retained fetch-ahead margin of 20 items', () => {
    expect(
      resolveAppServerControlHistoryFetchAheadItems({
        overscanItems: 12,
        fetchAheadItems: 4,
      }),
    ).toBe(20);
    expect(
      resolveAppServerControlHistoryFetchAheadItems({
        overscanItems: 12,
        fetchAheadItems: 30,
      }),
    ).toBe(30);
  });

  it('sizes the retained history window with at least 20 items of margin on each side', () => {
    const count = resolveAppServerControlHistoryWindowTargetCount(
      { clientHeight: 600 } as HTMLDivElement,
      10,
      [150, 150, 150],
      {
        overscanItems: 12,
        fetchAheadItems: 6,
      },
    );

    expect(count).toBe(44);
  });
});
