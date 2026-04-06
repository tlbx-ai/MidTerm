import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const source = readFileSync(path.join(__dirname, 'smartInput.ts'), 'utf8');
const metricsSource = readFileSync(path.join(__dirname, 'smartInputMetrics.ts'), 'utf8');
const submissionSource = readFileSync(path.join(__dirname, 'lensAttachmentSubmission.ts'), 'utf8');
const layoutSource = readFileSync(path.join(__dirname, 'layout.ts'), 'utf8');
const keyBindingsSource = readFileSync(path.join(__dirname, 'smartInputKeyBindings.ts'), 'utf8');
const viewSource = readFileSync(path.join(__dirname, 'smartInputView.ts'), 'utf8');
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
    expect(css).toContain('.smart-input-lens-actions[hidden] {');
    expect(css).toContain('display: none !important;');
    expect(viewSource).toContain('createLensQuickSettingsDropdown(lensEffortSelect)');
    expect(viewSource).toContain("lensQuickSettingsActions.className = 'smart-input-lens-actions';");
    expect(viewSource).toContain("manager-bar-action-popover smart-input-lens-dropdown-menu hidden");
  });

  it('mounts smart input, manager automation, and status rails inside one adaptive footer dock', () => {
    expect(html).toContain('id="adaptive-footer-dock"');
    expect(html).toContain('id="adaptive-footer-reserve"');
    expect(html).toContain('id="adaptive-footer-primary"');
    expect(html).toContain('id="adaptive-footer-context"');
    expect(html).toContain('id="adaptive-footer-status"');
    expect(html).toContain('id="manager-bar-overflow"');
    expect(source).toContain('function getAdaptiveFooterLayoutState(): AdaptiveFooterLayoutState {');
    expect(source).toContain('showAutomation');
    expect(source).toContain('showStatus');
    expect(source).toContain('syncFooterRailOrder(layoutState);');
    expect(layoutSource).toContain("return ['primary', 'automation', 'context', 'status'];");
  });

  it('reserves only collapsed footer height and uses send gestures for auto-send toggling', () => {
    expect(source).toContain('calculateAdaptiveFooterReservedHeight');
    expect(layoutSource).toContain('ADAPTIVE_FOOTER_RESERVED_HEIGHT_CHANGED_EVENT');
    expect(source).toContain('ResizeObserver');
    expect(source).toContain('setAdaptiveFooterReservedHeight(root, reserveHeight);');
    expect(source).toContain('window.dispatchEvent(');
    expect(source).toContain("footerDock?.scrollTo({ top: 0, behavior: 'auto' });");
    expect(viewSource).toContain("sendBtn.addEventListener('dblclick', args.onSendDoubleClick);");
    expect(source).toContain('AUTO_SEND_LONG_PRESS_MS');
    expect(css).toContain('.adaptive-footer-dock {');
    expect(css).toContain('.adaptive-footer-reserve {');
    expect(css).toContain('height: var(--adaptive-footer-reserved-height);');
    expect(css).toContain('.smart-input-tools-surface {');
    expect(css).toContain('.adaptive-footer-status.adaptive-footer-status-sheet-open {');
    expect(css).toContain('--command-bay-symbol-shadow: drop-shadow(');
    expect(css).toContain('.smart-input-tools-toggle::before,');
    expect(css).toContain('font-size: 16px;');
    expect(metricsSource).toContain('const MAX_TEXTAREA_LINES = 5;');
  });

  it('keeps Lens attachment drafts in the composer until send-time upload', () => {
    expect(source).toContain('lensAttachmentDrafts');
    expect(source).toContain('handleSmartInputSelectedFiles');
    expect(submissionSource).toContain('await args.uploadFile(args.sessionId, attachment.file);');
    expect(submissionSource).toContain('queuedTurn: args.submitQueuedTurn(args.sessionId, request)');
    expect(css).toContain('.smart-input-attachments {');
    expect(css).toContain('.smart-input-attachment-chip {');
  });

  it('keeps command-bay panels in reserved flow while only textarea growth may overlay the pane', () => {
    expect(source).toContain('footerStatusHost.classList.add(\'adaptive-footer-status-sheet-open\');');
    expect(source).toContain('dockedBar.appendChild(dom.inputRow);');
    expect(source).toContain('dockedBar.appendChild(dom.toolsPanel);');
    expect(source).toContain('let toolsPanelOpen = false;');
    expect(source).toContain('setToolsPanelOpen(!toolsPanelOpen);');
    expect(source).toContain("event.stopPropagation();");
    expect(source).not.toContain("nextToolsToggleBtn.addEventListener('pointerdown'");
    expect(css).toContain('margin: 6px 0 0;');
    expect(css).toContain('.smart-input-lens-settings-sheet {');
    expect(css).toContain('overflow: visible;');
    expect(css).toContain('.manager-btn-overflow-hidden {');
  });

  it('uses an explicit picker helper for attach and photo tools instead of relying on raw hidden-input clicks', () => {
    expect(source).toContain('function openFileInputPicker(input: HTMLInputElement): void {');
    expect(viewSource).toContain("if (typeof input.showPicker === 'function')");
    expect(source).toContain('openFileInputPicker(sharedAttachInput);');
    expect(source).toContain('openFileInputPicker(sharedPhotoInput);');
  });

  it('routes Escape through the Lens interrupt handler instead of treating it like a text key', () => {
    expect(source).toContain('bindSmartInputGlobalKeyBindings({');
    expect(source).toContain('hasInterruptibleLensTurnWork(sessionId)');
    expect(keyBindingsSource).toContain("document.addEventListener(");
    expect(keyBindingsSource).toContain("'keydown'");
    expect(keyBindingsSource).toContain('event.stopImmediatePropagation();');
    expect(keyBindingsSource).toContain('true,');
    expect(source).toContain("event.key === 'Escape'");
    expect(source).toContain('void handleLensEscape(sessionId);');
  });

  it('adds a bookmark-scoped provider resume action to the Lens Command Bay status rail', () => {
    expect(source).toContain('setLensResumeConversationHandler');
    expect(source).toContain('createLensResumeButton');
    expect(source).toContain('syncLensQuickSettingsActions(sessionId);');
    expect(source).toContain("button.className = 'smart-input-lens-action smart-input-lens-resume';");
    expect(source).toContain('session?.bookmarkId');
    expect(css).toContain('.smart-input-lens-actions {');
    expect(css).toContain('.smart-input-lens-action {');
  });
});
