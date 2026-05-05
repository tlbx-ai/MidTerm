import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(path.join(__dirname, 'sidebarUpdater.ts'), 'utf8');

describe('sidebarUpdater wiring', () => {
  it('rerenders layout-sensitive session rows when the split layout changes', () => {
    expect(source).toContain('$layout');
    expect(source).toContain('unsubscribeLayout = $layout.subscribe');
    expect(source).toContain('unsubscribeLayout?.()');
  });

  it('narrows settings-triggered sidebar rebuilds to sidebar-relevant settings', () => {
    expect(source).toContain('getSidebarSettingsSignature');
    expect(source).toContain('showSidebarSessionFilter');
    expect(source).toContain('allowAdHocSessionBookmarks');
    expect(source).toContain('previousSidebarSettingsSignature === nextSignature');
  });
});
