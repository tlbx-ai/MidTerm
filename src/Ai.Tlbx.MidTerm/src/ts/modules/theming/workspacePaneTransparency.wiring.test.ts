import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const css = readFileSync(path.join(__dirname, '../../../static/css/app.css'), 'utf8');

describe('workspace pane transparency wiring', () => {
  it('keeps files, git, and web panes out of terminal-scoped background tokens', () => {
    expect(css).toContain('--workspace-pane-background: var(--bg-primary);');
    expect(css).toContain('--workspace-pane-chrome-background: var(--bg-elevated);');
    expect(css).toContain('.file-viewer-dock {');
    expect(css).toContain('.git-dock {');
    expect(css).toContain('.web-preview-dock {');
    expect(css).toContain('.file-browser-tree {');
    expect(css).toContain('.file-browser-preview {');
    expect(css).toContain('background: var(--workspace-pane-background);');
    expect(css).toContain('background: var(--workspace-pane-chrome-background);');
  });

  it('keeps terminal and Lens panes as the only workspace surface over wallpaper', () => {
    expect(css).toContain('.main-content {');
    expect(css).toContain('.terminals-area {');
    expect(css).toContain('.layout-leaf {');
    expect(css).toContain(
      "body.opaque-terminal-surfaces .session-wrapper[data-active-tab='terminal'],",
    );
    expect(css).toContain('background-color: transparent;');
    expect(css).toContain('background: transparent;');
    expect(css).toContain(
      'background-color: var(--terminal-canvas-background, var(--terminal-bg));',
    );
    expect(css).toContain('background: var(--terminal-canvas-background, var(--terminal-bg));');
  });

  it('binds the sidebar header and IDE bar to the shared app chrome background', () => {
    expect(css).toContain('--app-chrome-background: var(--bg-terminal);');
    expect(css).toContain(
      'background-color: var(--app-chrome-background, var(--bg-terminal));',
    );
    expect(css).toContain('background: var(--app-chrome-background, var(--bg-terminal));');
    expect(css).not.toContain('color-mix(in srgb, var(--bg-dialog-chrome) 94%, transparent)');
  });
});
