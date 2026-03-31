import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const css = readFileSync(path.join(__dirname, '../../../static/css/app.css'), 'utf8');
const lensDesign = readFileSync(path.join(__dirname, '../../../../../../docs/LensDesign.md'), 'utf8');

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
});
