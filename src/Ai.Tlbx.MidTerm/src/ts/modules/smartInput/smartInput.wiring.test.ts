import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const source = readFileSync(path.join(__dirname, 'smartInput.ts'), 'utf8');
const layoutSource = readFileSync(path.join(__dirname, 'layout.ts'), 'utf8');
const css = readFileSync(path.join(__dirname, '../../../static/css/app.css'), 'utf8');
const html = readFileSync(path.join(__dirname, '../../../static/index.html'), 'utf8');

describe('smart input tab wiring', () => {
  it('resyncs smart input visibility when non-Lens tabs activate', () => {
    expect(source).toContain("onTabActivated('agent', (sessionId) => {");
    expect(source).toContain("onTabActivated('terminal', (sessionId) => {");
    expect(source).toContain("onTabActivated('files', (sessionId) => {");
  });

  it('does not rely on agent deactivation timing to hide Lens-only controls', () => {
    expect(source).not.toContain("onTabDeactivated('agent'");
  });

  it('keeps Lens quick settings hidden when the hidden attribute is set', () => {
    expect(css).toContain('.smart-input-lens-settings[hidden] {');
    expect(css).toContain('display: none !important;');
  });

  it('mounts smart input, manager automation, and status rails inside one adaptive footer dock', () => {
    expect(html).toContain('id="adaptive-footer-dock"');
    expect(html).toContain('id="adaptive-footer-primary"');
    expect(html).toContain('id="adaptive-footer-context"');
    expect(html).toContain('id="adaptive-footer-status"');
    expect(source).toContain('function getAdaptiveFooterLayoutState(): AdaptiveFooterLayoutState {');
    expect(source).toContain('showAutomation');
    expect(source).toContain('showStatus');
    expect(source).toContain('syncFooterRailOrder(layoutState);');
    expect(layoutSource).toContain("return ['primary', 'automation', 'context', 'status'];");
  });

  it('reserves only collapsed footer height and uses send gestures for auto-send toggling', () => {
    expect(source).toContain('calculateAdaptiveFooterReservedHeight');
    expect(source).toContain('ResizeObserver');
    expect(source).toContain("nextSendBtn.addEventListener('dblclick'");
    expect(source).toContain('AUTO_SEND_LONG_PRESS_MS');
    expect(css).toContain('.adaptive-footer-dock {');
    expect(css).toContain('.smart-input-tools-surface {');
    expect(css).toContain('.adaptive-footer-status.adaptive-footer-status-sheet-open {');
  });

  it('keeps command-bay panels in reserved flow while only textarea growth may overlay the pane', () => {
    expect(source).toContain('footerStatusHost.classList.add(\'adaptive-footer-status-sheet-open\');');
    expect(source).toContain('dockedBar.appendChild(toolsSurface);');
    expect(source).toContain('dockedBar.appendChild(inputRow);');
    expect(css).toContain('margin: 0 0 8px;');
    expect(css).toContain('.smart-input-lens-settings-sheet {');
    expect(css).toContain('overflow: visible;');
  });

  it('routes Escape through the Lens interrupt handler instead of treating it like a text key', () => {
    expect(source).toContain("if (e.key === 'Escape' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {");
    expect(source).toContain('void handleLensEscape(sessionId);');
  });
});
