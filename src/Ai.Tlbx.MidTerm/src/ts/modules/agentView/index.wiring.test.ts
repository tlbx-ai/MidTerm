import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const css = readFileSync(path.join(__dirname, '../../../static/css/app.css'), 'utf8');
const lensDesign = readFileSync(path.join(__dirname, '../../../../../../docs/LensDesign.md'), 'utf8');
const source = readFileSync(path.join(__dirname, 'index.ts'), 'utf8');

describe('agent view Lens wiring', () => {
  it('keeps Codex Lens user and assistant metadata above the message body', () => {
    expect(css).toContain(
      ".agent-view-panel[data-lens-layout='full-width-left'] .agent-history-user .agent-history-header,",
    );
    expect(css).not.toContain('order: 1;');
  });

  it('uses 7px user and assistant metadata in full-width Lens layout', () => {
    expect(css).toContain(".agent-view-panel[data-lens-layout='full-width-left'] .agent-history-badge-user,");
    expect(css).toContain(".agent-view-panel[data-lens-layout='full-width-left'] .agent-history-user .agent-history-meta,");
    expect(css).toContain('font-size: 7px;');
  });

  it('documents the above-body metadata rule in the Lens design contract', () => {
    expect(lensDesign).toContain(
      'In Codex Lens, user and assistant rows should place their quiet role label and timestamp above the message body, not below it.',
    );
  });

  it('binds the Lens pane background to terminal transparency tokens', () => {
    expect(css).toContain('background: var(--terminal-canvas-background, var(--terminal-bg));');
    expect(lensDesign).toContain(
      'Lens pane background/transparency should follow the terminal transparency model, not the surrounding generic UI shell transparency model.',
    );
  });

  it('keeps the history shell flat instead of reintroducing wrapper cards', () => {
    expect(source).not.toContain('agent-history-card');
    expect(lensDesign).toContain(
      'Codex/Claude history rows now render with a flatter console-like surface and remove the remaining card/bubble chrome while the renderer is being hardened',
    );
  });

  it('replaces changed history rows instead of mutating past DOM nodes in place', () => {
    expect(source).not.toContain('updateHistoryEntryNode(');
    expect(lensDesign).toContain(
      "Future updates must not mutate an already-rendered older row into a different row identity.",
    );
  });

  it('styles command-execution rows as console-like Ran blocks with terminal monospace', () => {
    expect(css).toContain('.agent-history-command-body {');
    expect(css).toContain('font-family: var(--agent-history-mono-font-family, var(--font-mono));');
    expect(css).toContain('.agent-history-command-token-command {');
    expect(css).toContain('.agent-history-command-output-tail {');
    expect(lensDesign).toContain('Command-execution rows should render in a console-like `Ran …` form');
  });

  it('styles diff rows as Edited path headers with tight colored hunk blocks', () => {
    expect(css).toContain('.agent-history-diff-line-file {');
    expect(css).toContain('.agent-history-diff-line-add {');
    expect(css).toContain('.agent-history-diff-line-delete {');
    expect(source).toContain("Edited ${displayPath}");
    expect(lensDesign).toContain('Diff file headers should read like console work artifacts');
  });
});
