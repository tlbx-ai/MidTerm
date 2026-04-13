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
const footerSupportSource = readFileSync(path.join(__dirname, 'footerSupport.ts'), 'utf8');
const lensResumeButtonSource = readFileSync(path.join(__dirname, 'lensResumeButton.ts'), 'utf8');
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
    expect(css).toContain('.adaptive-footer-dock .smart-input-lens-dropdown-menu {');
    expect(css).toContain(
      '.smart-input-lens-dropdown.smart-input-lens-dropdown-open-up .smart-input-lens-dropdown-menu {',
    );
    expect(css).toContain('position: absolute;');
    expect(css).toContain('z-index: 5;');
    expect(viewSource).toContain('createLensQuickSettingsDropdown(lensModelSelect)');
    expect(viewSource).toContain('createLensQuickSettingsDropdown(lensEffortSelect)');
    expect(viewSource).toContain(
      "lensQuickSettingsActions.className = 'smart-input-lens-actions';",
    );
    expect(viewSource).toContain(
      'manager-bar-action-popover smart-input-lens-dropdown-menu hidden',
    );
    expect(viewSource).toContain(
      "wrapper.classList.toggle('smart-input-lens-dropdown-open-up', openUp);",
    );
    expect(viewSource).toContain("document.addEventListener('scroll', updateMenuPlacement, true);");
  });

  it('mounts smart input, manager automation, and status rails inside one adaptive footer dock', () => {
    expect(html).toContain('id="adaptive-footer-dock"');
    expect(html).toContain('id="adaptive-footer-reserve"');
    expect(html).toContain('id="adaptive-footer-primary"');
    expect(html).toContain('id="adaptive-footer-context"');
    expect(html).toContain('id="adaptive-footer-status"');
    expect(html).toContain('id="manager-bar-overflow"');
    expect(css).toContain('.manager-bar-overflow[hidden] {');
    expect(css).toContain('display: none !important;');
    expect(source).toContain(
      'function getAdaptiveFooterLayoutState(): AdaptiveFooterLayoutState {',
    );
    expect(source).toContain('showAutomation');
    expect(source).toContain('showStatus');
    expect(source).toContain('syncFooterRailOrder(layoutState);');
    expect(layoutSource).toContain("return ['primary', 'automation', 'context', 'status'];");
  });

  it('collapses the adaptive footer immediately while settings are open', () => {
    expect(source).toContain('$settingsOpen');
    expect(source).toContain('const settingsOpen = $settingsOpen.get();');
    expect(source).toContain('$settingsOpen.subscribe(() => {');
    expect(source).toContain('const showFooter = settingsOpen');
    expect(source).toContain('hideAdaptiveFooter();');
    expect(source).toContain('updateFooterReservedHeight();');
  });

  it('reserves only collapsed footer height and uses send gestures for auto-send toggling', () => {
    expect(footerSupportSource).toContain('calculateAdaptiveFooterReservedHeight');
    expect(layoutSource).toContain('ADAPTIVE_FOOTER_RESERVED_HEIGHT_CHANGED_EVENT');
    expect(source).toContain('ResizeObserver');
    expect(footerSupportSource).toContain('setAdaptiveFooterReservedHeight(');
    expect(footerSupportSource).toContain('window.dispatchEvent(');
    expect(source).toContain("footerDock?.scrollTo({ top: 0, behavior: 'auto' });");
    expect(viewSource).toContain("sendBtn.addEventListener('dblclick', args.onSendDoubleClick);");
    expect(source).toContain('AUTO_SEND_LONG_PRESS_MS');
    expect(source).toContain(
      "footerStatusHost.toggleAttribute('hidden', !renderedTerminalStatus);",
    );
    expect(source).toContain('createTerminalTouchToggleButton({');
    expect(source).toContain('function setTouchKeysExpanded(expanded: boolean): void {');
    expect(source).toContain('closeTouchControllerPopup();');
    expect(source).toContain('footerContextHost.appendChild(keysToggle);');
    expect(viewSource).toContain(
      "keysToggle.className = 'adaptive-footer-context-toggle adaptive-footer-status-toggle';",
    );
    expect(css).toContain('.adaptive-footer-dock {');
    expect(css).toContain('.adaptive-footer-reserve {');
    expect(css).toContain('height: var(--adaptive-footer-reserved-height);');
    expect(css).toContain('.smart-input-tools-surface {');
    expect(css).toContain(
      ".adaptive-footer-dock[data-device='mobile'] .smart-input-tools-surface {",
    );
    expect(css).toContain('.adaptive-footer-status.adaptive-footer-status-sheet-open {');
    expect(css).toContain('.adaptive-footer-context-toggle {');
    expect(css).toContain(".adaptive-footer-status[data-lens-compact='true'] {");
    expect(css).toContain('position: relative;');
    expect(css).toContain('z-index: 3;');
    expect(css).toContain('--command-bay-control-height: 34px;');
    expect(css).toContain('--command-bay-surface: color-mix(');
    expect(css).toContain('align-items: center;');
    expect(css).toContain('.smart-input-tools-toggle::before,');
    expect(viewSource).toContain(
      "toolsPanel.className = 'manager-bar-action-popover smart-input-tools-surface';",
    );
    expect(css).toContain('font-size: var(--terminal-font-size, 16px);');
    expect(metricsSource).toContain('const MAX_TEXTAREA_OVERLAY_LINES = 7;');
    expect(metricsSource).toContain(
      'const MAX_VISIBLE_TEXTAREA_LINES = COLLAPSED_TEXTAREA_LINES + MAX_TEXTAREA_OVERLAY_LINES;',
    );
  });

  it('keeps staged attachment drafts available in both Lens and terminal composers', () => {
    expect(source).toContain('lensAttachmentDrafts');
    expect(source).toContain('handleSmartInputSelectedFiles');
    expect(source).toContain('const uploadedPath = await uploadFile(sessionId, file);');
    expect(source).toContain('shouldConvertPastedTextToSmartInputReference');
    expect(source).toContain('addLensComposerTextReference');
    expect(source).toContain("target: 'terminal'");
    expect(source).toContain('void openLensDraftAttachment(currentSessionId, attachment);');
    expect(source).toContain('enqueueCommandBayTurn');
    expect(source).not.toContain('await handleFileDrop(files);');
    expect(source).not.toContain(
      "isLensActiveSession(sessionId) &&\n        clipboardDataMayContainLensComposerImage",
    );
    expect(submissionSource).toContain('prepareSmartInputOutboundPrompt');
    expect(submissionSource).toContain(
      'queuedTurn: args.submitQueuedTurn(args.sessionId, request)',
    );
    expect(css).toContain('.smart-input-attachments {');
    expect(css).toContain('.smart-input-attachment-chip {');
    expect(css).toContain('.smart-input-attachment-open {');
  });

  it('keeps command-bay panels in reserved flow while only textarea growth may overlay the pane', () => {
    expect(source).toContain(
      "footerStatusHost.classList.add('adaptive-footer-status-sheet-open');",
    );
    expect(source).toContain('return args.lensActive ? args.isMobile : args.touchControlsAvailable;');
    expect(source).toContain('shouldUseCompactLensStatusRail(layoutState)');
    expect(source).toContain('dockedBar.appendChild(dom.inputRow);');
    expect(source).toContain('let toolsPanelOpen = false;');
    expect(source).toContain('let suppressNextToolsToggleClick = false;');
    expect(source).toContain('setToolsPanelOpen(!toolsPanelOpen);');
    expect(source).toContain('event.stopPropagation();');
    expect(source).not.toContain("nextToolsToggleBtn.addEventListener('pointerdown'");
    expect(viewSource).toContain('inputRow.appendChild(toolsPanel);');
    expect(css).toContain('bottom: calc(100% + var(--command-bay-gap));');
    expect(css).toContain('.smart-input-lens-settings-sheet {');
    expect(css).toContain('overflow: visible;');
    expect(css).toContain('.adaptive-footer-primary {');
    expect(css).toContain('.smart-input-editor {');
    expect(css).toContain('.smart-input-textarea {');
    expect(css).toContain('.adaptive-footer-dock .smart-input-textarea {');
    expect(css).toContain(":root:not([data-command-bay-ligatures='false']) .smart-input-textarea");
    expect(css).toContain(
      'font-family: var(--terminal-font-family, var(--agent-history-mono-font-family, var(--font-mono)));',
    );
    expect(css).toContain('font-size: var(--terminal-font-size, 16px);');
    expect(css).toContain('font-weight: var(--terminal-font-weight, normal);');
    expect(css).toContain('letter-spacing: var(--terminal-letter-spacing, 0px);');
    expect(css).toContain("--smart-input-textarea-rendered-height: var(--smart-input-textarea-min-height);");
    expect(css).toContain(".smart-input-textarea[data-midterm-single-line='true'] {");
    expect(css).toContain('--smart-input-textarea-line-height: calc(');
    expect(css).toContain('var(--terminal-line-height, 1)');
    expect(css).toContain('font-kerning: none;');
    expect(css).toContain('@supports (leading-trim: both) and (text-edge: cap alphabetic) {');
    expect(css).toContain('overflow: visible;');
    expect(css).toContain('.manager-btn-overflow-hidden {');
    expect(metricsSource).toContain("const SINGLE_LINE_DATASET_KEY = 'midtermSingleLine';");
  });

  it('renders the plus-menu tools as popover actions with icon and text labels', () => {
    expect(viewSource).toContain("toolsToggleBtn.setAttribute('aria-haspopup', 'menu');");
    expect(viewSource).toContain(
      "toolsToggleBtn.addEventListener('pointerdown', args.onToolsTogglePointerDown);",
    );
    expect(viewSource).toContain("button.classList.add('smart-input-tool-button');");
    expect(viewSource).toContain('smart-input-tool-label');
    expect(viewSource).not.toContain('describeTerminalStatus(');
    expect(css).toContain('.smart-input-tools-surface .smart-input-tool-button {');
    expect(css).toContain('.smart-input-tools-surface .smart-input-tool-label {');
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
    expect(keyBindingsSource).toContain('document.addEventListener(');
    expect(keyBindingsSource).toContain("'keydown'");
    expect(keyBindingsSource).toContain('event.stopImmediatePropagation();');
    expect(keyBindingsSource).toContain('true,');
    expect(source).toContain("event.key === 'Escape'");
    expect(source).toContain('void handleLensEscape(sessionId);');
  });

  it('submits from the command bay only on bare Enter', () => {
    expect(source).toContain('import {');
    expect(source).toContain("} from './enterBehavior';");
    expect(source).toContain("event.key === 'ArrowUp'");
    expect(source).toContain("event.key === 'ArrowDown'");
    expect(source).toContain("navigatePromptHistory(sessionId, 'older', textarea)");
    expect(source).toContain("navigatePromptHistory(sessionId, 'newer', textarea)");
    expect(source).toContain('shouldInsertLineBreakOnEnter');
    expect(source).toContain('insertSmartInputLineBreak');
    expect(source).toContain('if (shouldInsertLineBreakOnEnter(event)) {');
    expect(source).toContain('insertSmartInputLineBreak(textarea);');
    expect(source).toContain('if (shouldSubmitSmartInputOnEnter(event)) {');
    expect(source).not.toContain("if (event.key === 'Enter' && !event.shiftKey) {");
  });

  it('advertises prompt history restoration from the empty Automation Bar composer', () => {
    expect(viewSource).toContain("textarea.placeholder = t('smartInput.placeholder');");
    expect(source).toContain('pushCurrentPromptToHistory(sessionId);');
    expect(source).toContain('sessionPromptHistoryNavigation');
  });

  it('routes command-bay sends through the backend-owned queue instead of direct terminal submission', () => {
    expect(source).toContain('await enqueueCommandBayTurn(sessionId, {');
    expect(source).toContain('submitQueuedTurn: enqueueCommandBayTurn,');
  });

  it('adds a space-scoped provider resume action to the Lens Command Bay status rail', () => {
    expect(source).toContain('setLensResumeConversationHandler');
    expect(source).toContain('createLensResumeButton');
    expect(source).toContain('syncLensQuickSettingsActions(sessionId);');
    expect(source).toContain('shouldIgnoreFooterTransientUiDocumentClickSupport(target)');
    expect(footerSupportSource).toContain("target.closest('.provider-resume-picker-overlay')");
    expect(lensResumeButtonSource).toContain(
      "button.className = 'smart-input-lens-action smart-input-lens-resume';",
    );
    expect(lensResumeButtonSource).toContain('session?.spaceId');
    expect(css).toContain('.smart-input-lens-actions {');
    expect(css).toContain('.smart-input-lens-action {');
  });
});
