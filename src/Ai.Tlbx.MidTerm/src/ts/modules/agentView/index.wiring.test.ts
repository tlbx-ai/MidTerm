import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const css = readFileSync(path.join(__dirname, '../../../static/css/app.css'), 'utf8');
const lensDesign = readFileSync(path.join(__dirname, '../../../../../../docs/LensDesign.md'), 'utf8');
const indexSource = readFileSync(path.join(__dirname, 'index.ts'), 'utf8');
const historyContentSource = readFileSync(path.join(__dirname, 'historyContent.ts'), 'utf8');
const historyDomSource = readFileSync(path.join(__dirname, 'historyDom.ts'), 'utf8');
const historyProcessingSource = readFileSync(path.join(__dirname, 'historyProcessing.ts'), 'utf8');
const focusReclaimSource = readFileSync(
  path.join(__dirname, '../terminal/focusReclaim.ts'),
  'utf8',
);
const viewShellSource = readFileSync(path.join(__dirname, 'viewShell.ts'), 'utf8');

describe('agent view Lens wiring', () => {
  it('keeps Codex Lens user and assistant metadata above the message body', () => {
    expect(css).toContain(
      ".agent-view-panel[data-lens-layout='full-width-left'] .agent-history-user .agent-history-header,",
    );
    expect(css).not.toContain('order: 1;');
  });

  it('uses slightly larger user and assistant metadata in full-width Lens layout', () => {
    expect(css).toContain(
      ".agent-view-panel[data-lens-layout='full-width-left'] .agent-history-badge-user,",
    );
    expect(css).toContain(
      ".agent-view-panel[data-lens-layout='full-width-left'] .agent-history-user .agent-history-meta,",
    );
    expect(css).toContain('font-size: 9px;');
    expect(css).toContain(".agent-view-panel[data-lens-layout='full-width-left'] .agent-history-badge-assistant {");
    expect(css).toContain('display: none;');
  });

  it('lets agent message typography follow the configurable agent UI font while machine rows stay on terminal monospace', () => {
    expect(css).toContain('--agent-history-message-font-family:');
    expect(css).toContain('var(--agent-ui-font-family,');
    expect(css).toContain(
      '--agent-history-mono-font-family: var(--terminal-font-family, var(--font-mono));',
    );
    expect(css).toContain('.agent-history-user .agent-history-body {');
    expect(css).toContain('.agent-history-assistant .agent-history-body {');
    expect(viewShellSource).not.toContain('--agent-font-family');
  });

  it('documents the above-body metadata rule in the Lens design contract', () => {
    expect(lensDesign).toContain(
      'In Codex Lens, user and assistant rows should place their quiet role label and timestamp above the message body, not below it.',
    );
    expect(lensDesign).toContain(
      'the quiet role label should remain on user rows, while assistant rows should omit a repeated `Agent` label',
    );
  });

  it('binds the Lens pane background to terminal transparency tokens', () => {
    expect(css).toContain('background: var(--terminal-canvas-background, var(--terminal-bg));');
    expect(lensDesign).toContain(
      'Lens pane background/transparency should follow the terminal transparency model, not the surrounding generic UI shell transparency model.',
    );
  });

  it('keeps the history shell flat instead of reintroducing wrapper cards', () => {
    expect(indexSource).not.toContain('agent-history-card');
    expect(lensDesign).toContain(
      'Codex/Claude history rows now render with a flatter console-like surface and remove the remaining card/bubble chrome while the renderer is being hardened',
    );
  });

  it('replaces changed history rows instead of mutating past DOM nodes in place', () => {
    expect(indexSource).not.toContain('updateHistoryEntryNode(');
    expect(lensDesign).toContain(
      "Future updates must not mutate an already-rendered older row into a different row identity.",
    );
  });

  it('styles command-execution rows as console-like Ran blocks with terminal monospace', () => {
    expect(css).toContain('.agent-history-command-body {');
    expect(css).toContain('.agent-history-command-entry {');
    expect(css).toContain('.agent-history-command-entry .agent-history-header,');
    expect(css).toContain('background: transparent;');
    expect(css).toContain('border: 0;');
    expect(css).toContain('font-family: var(--agent-history-mono-font-family, var(--font-mono));');
    expect(css).toContain('.agent-history-command-token-command {');
    expect(css).toContain('.agent-history-command-output-tail {');
    expect(lensDesign).toContain('Command-execution rows should render in a console-like `Ran …` form');
    expect(lensDesign).toContain('Command-execution rows should remain fully flat.');
    expect(lensDesign).toContain('fold up to 12 tail lines');
    expect(lensDesign).toContain('must not downgrade it back into a generic tool row');
  });

  it('keeps machine-oriented history rows flat and dense', () => {
    expect(css).toContain('.agent-history-tool .agent-history-body,');
    expect(css).toContain('.agent-history-diff .agent-history-body {');
    expect(css).toContain('border: 0;');
    expect(css).toContain('border-radius: 0;');
    expect(css).toContain('box-shadow: none;');
    expect(css).toContain('.agent-history-markdown p,');
    expect(css).toContain('margin-bottom: 2px;');
    expect(css).toContain('.agent-history-markdown li + li {');
    expect(css).toContain('margin-top: 1px;');
    expect(lensDesign).toContain('Lens should not draw decorative card outlines, rounded shells, or inset border treatments around machine-oriented history rows.');
    expect(lensDesign).toContain('Markdown paragraph and list spacing should be dense and terminal-like.');
  });

  it('documents finalized assistant enrichment without leaking into streaming or artifact rows', () => {
    expect(css).toContain('.agent-history-markdown .agent-history-inline-file {');
    expect(css).toContain('.agent-history-inline-previews {');
    expect(css).toContain('.agent-history-inline-preview-frame {');
    expect(css).toContain('.agent-history-attachment-image-frame {');
    expect(css).toContain('object-fit: contain;');
    expect(lensDesign).toContain(
      'Finalized assistant messages may receive a post-settlement enrichment pass',
    );
    expect(lensDesign).toContain(
      'Assistant-only semantic tinting should remain subtle.',
    );
    expect(lensDesign).toContain(
      'Image previews should preserve the full image bounds inside a bounded frame instead of center-cropping portrait screenshots or photos.',
    );
  });

  it('styles diff rows as Edited path headers with tight colored hunk blocks', () => {
    expect(css).toContain('.agent-history-diff-line-file {');
    expect(css).toContain('.agent-history-diff-line-add {');
    expect(css).toContain('.agent-history-diff-line-delete {');
    expect(css).toContain('.agent-history-diff-line-add > .agent-history-diff-line-number:first-child,');
    expect(css).toContain('grid-column: 1 / span 2;');
    expect(historyContentSource).toContain("Edited ${displayPath}");
    expect(lensDesign).toContain('Diff file headers should read like console work artifacts');
    expect(lensDesign).toContain('Command-execution rows and diff rows should not repeat timestamp meta.');
  });

  it('keeps runtime token stats in a compact hovering overlay instead of history rows', () => {
    expect(viewShellSource).toContain('data-agent-field="runtime-stats"');
    expect(indexSource).toContain('buildLensRuntimeStats(snapshot)');
    expect(historyDomSource).toContain('formatTokenWindowCompact(stats)');
    expect(css).toContain('.agent-runtime-stats {');
    expect(css).toContain('.agent-runtime-stats-detail {');
    expect(lensDesign).toContain('Codex runtime bookkeeping notices such as context-window updates and rate-limit updates should not render as history rows.');
    expect(lensDesign).toContain('Lens should expose that telemetry in a compact hovering stats display');
  });

  it('documents the selection-preservation rule for passive Lens rerenders', () => {
    expect(indexSource).toContain('hasActiveLensSelectionInPanel');
    expect(focusReclaimSource).toContain("element.closest?.('.agent-view-panel') != null");
    expect(lensDesign).toContain('Passive rerenders must not clear an active text selection inside Lens.');
  });

  it('documents the current Lens usability floor and canonical-only retention stance', () => {
    expect(lensDesign).toContain('the visible result after those changes must not regress below the current Lens floor');
    expect(lensDesign).toContain('persistent `Ran …` command rows with folded output tails');
    expect(lensDesign).toContain('deterministic older-history paging through a bounded virtualized window');
    expect(lensDesign).toContain('Raw provider inputs are transient reducer inputs, not retained Lens history.');
    expect(lensDesign).toContain('it should be dropped instead of preserved in a hidden Lens data layer.');
  });

  it('renders the busy indicator as Working with per-letter sweep animation', () => {
    expect(historyProcessingSource).toContain("lensText('lens.status.working', 'Working')");
    expect(historyProcessingSource).toContain('resolveBusyIndicatorLabelFromSnapshotItems(snapshot)');
    expect(historyProcessingSource).toContain('BUSY_INDICATOR_EXCLUDED_ITEM_TYPES');
    expect(historyProcessingSource).toContain('resolveBusyIndicatorAnimationOffsetMs(snapshot)');
    expect(historyDomSource).toContain('agent-history-busy-label-letter');
    expect(historyDomSource).toContain('--agent-busy-animation-offset-ms');
    expect(historyDomSource).toContain('agent-history-busy-elapsed');
    expect(historyDomSource).toContain('(Press Esc to cancel)');
    expect(css).toContain('.agent-history-busy-bubble {');
    expect(css).toContain('justify-content: flex-start;');
    expect(css).toContain('.agent-history-busy-label {');
    expect(css).toContain('flex: 0 0 auto;');
    expect(css).toContain('white-space: pre;');
    expect(css).toContain('.agent-history-busy-label-letter {');
    expect(css).toContain('.agent-history-busy-status {');
    expect(css).toContain('animation: agent-history-busy-sweep 1.45s linear infinite alternate;');
    expect(css).toContain('animation-delay: calc((var(--agent-busy-letter-index, 0) * 90ms) - var(--agent-busy-animation-offset-ms, 0ms));');
    expect(css).toContain('.agent-history-busy-cancel {');
    expect(css).toContain('.agent-history-turn-duration-body {');
    expect(css).toContain('.agent-history-turn-duration-marker {');
    expect(css).toContain('.agent-history-turn-duration-segment {');
    expect(css).toContain('.agent-history-turn-duration-label {');
    expect(historyDomSource).toContain('createTurnDurationNoteBody(entry)');
    expect(css).toContain('@keyframes agent-history-busy-sweep {');
    expect(lensDesign).toContain('When the provider exposes a live in-progress task/tool/reasoning detail label');
    expect(lensDesign).toContain('User-prompt text and assistant-message text must not populate the busy bubble.');
    expect(lensDesign).toContain('busy bubble should also show a muted wall-clock duration counter');
    expect(lensDesign).toContain('hint immediately after the animated label');
    expect(lensDesign).toContain('append one muted inline duration note');
    expect(lensDesign).toContain('vertical rule above and below the text');
  });

  it('routes plain Escape from the Lens surface through Lens interruption', () => {
    expect(viewShellSource).toContain("panel.addEventListener('keydown', (event) => {");
    expect(viewShellSource).toContain("event.key !== 'Escape' ||");
    expect(viewShellSource).toContain('event.shiftKey ||');
    expect(viewShellSource).toContain('event.ctrlKey ||');
    expect(viewShellSource).toContain('event.altKey ||');
    expect(viewShellSource).toContain('event.metaKey');
    expect(indexSource).toContain('void handleLensEscape(targetSessionId);');
  });

  it('normalizes command-output transcript rows into persistent command presentations', () => {
    expect(historyProcessingSource).toContain('applyDirectCommandPresentation(mapped);');
    expect(historyContentSource).toContain('export function hasInlineCommandPresentation(');
    expect(historyContentSource).toContain('export function parseCommandOutputBody(');
    expect(historyProcessingSource).toContain('preservePersistentCommandEntries(');
    expect(historyProcessingSource).toContain("normalizedType !== 'commandoutput'");
  });
});
