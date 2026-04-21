import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(path.join(__dirname, 'spacesTreeSidebar.ts'), 'utf8');
const css = readFileSync(path.join(__dirname, '../../../static/css/app.css'), 'utf8');
const locale = readFileSync(path.join(__dirname, '../../../static/locales/en.json'), 'utf8');

describe('spacesTreeSidebar wiring', () => {
  it('does not render a dedicated spaces empty-state badge', () => {
    expect(source).not.toContain('spaces-sidebar-empty');
    expect(source).not.toContain("t('spaces.noSearchMatches')");
    expect(source).not.toContain("t('spaces.sidebarEmpty')");
    expect(css).not.toContain('.spaces-sidebar-empty');
    expect(locale).not.toContain('"spaces.noSearchMatches"');
    expect(locale).not.toContain('"spaces.sidebarEmpty"');
  });
});
