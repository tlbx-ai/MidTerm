import { describe, expect, it } from 'vitest';
import { isAdHocSession } from './spacesTreeSidebarLogic';

describe('spacesTreeSidebar session classification', () => {
  it('keeps generic new-session entries ad hoc even when they have a workspace path', () => {
    expect(
      isAdHocSession({
        isAdHoc: true,
        spaceId: null,
      } as any),
    ).toBe(true);
  });

  it('falls back to missing space ids when older payloads omit isAdHoc', () => {
    expect(
      isAdHocSession({
        spaceId: null,
      } as any),
    ).toBe(true);

    expect(
      isAdHocSession({
        spaceId: 'space-1',
      } as any),
    ).toBe(false);
  });
});
