import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const css = readFileSync(path.join(__dirname, '../../../static/css/app.css'), 'utf8');

describe('workspace pane transparency wiring', () => {
  it('binds files, git, and web panes to terminal-scoped background tokens', () => {
    expect(css).toContain(
      '--workspace-pane-background: var(--terminal-canvas-background, var(--terminal-bg));',
    );
    expect(css).toContain(
      '--workspace-pane-chrome-background: var(--terminal-ui-background, var(--terminal-bg));',
    );
    expect(css).toContain('.file-viewer-dock {');
    expect(css).toContain('.git-dock {');
    expect(css).toContain('.web-preview-dock {');
    expect(css).toContain('.file-browser-tree {');
    expect(css).toContain('.file-browser-preview {');
    expect(css).toContain('background: var(--workspace-pane-background);');
    expect(css).toContain('background: var(--workspace-pane-chrome-background);');
  });
});
