/**
 * Chat Module
 *
 * Handles the voice chat panel display, message rendering,
 * and panel visibility state. Tool calls within a turn are
 * consolidated into collapsible group bubbles.
 */

import { createLogger } from '../logging';
import type { ChatMessage, VoiceToolName, InteractiveOp } from '../../types';
import { escapeHtml } from '../../utils';
import { renderMarkdown } from '../../utils/markdown';
import { t } from '../i18n';

const log = createLogger('chat');
const STORAGE_KEY = 'midterm.chatPanelOpen';
const MAX_CHAT_ELEMENTS = 69;
const MAX_CHAT_MESSAGES = 200;

const chatMessages: ChatMessage[] = [];
let autoAcceptEnabled = false;

interface ToolEntry {
  toolName: string;
  request: string;
  response: string;
  rowEl: HTMLElement;
  group: ActiveToolGroup;
  state: 'running' | 'done' | 'failed' | 'declined';
  statusEl: HTMLElement;
  outcomeEl: HTMLElement;
}

interface ActiveToolGroup {
  element: HTMLElement;
  entriesContainer: HTMLElement;
  summary: HTMLElement;
  statusEl: HTMLElement;
  countEl: HTMLElement;
  namesEl: HTMLElement;
  entries: ToolEntry[];
}

let activeToolGroup: ActiveToolGroup | null = null;
const toolEntries = new Map<string, ToolEntry>();

function rememberToolEntry(id: string, entry: ToolEntry): void {
  toolEntries.set(id, entry);
  if (toolEntries.size > MAX_CHAT_MESSAGES) {
    const oldest = toolEntries.keys().next().value;
    if (oldest !== undefined) toolEntries.delete(oldest);
  }
}

/**
 * Initialize the chat panel and event handlers
 */
export function initChatPanel(): void {
  const collapseBtn = document.getElementById('btn-collapse-chat');
  if (collapseBtn) {
    collapseBtn.addEventListener('click', hideChatPanel);
  }

  log.info(() => 'Chat panel initialized');
}

/**
 * Show the chat panel
 */
export function showChatPanel(): void {
  const panel = document.getElementById('chat-panel');
  if (panel) {
    panel.classList.remove('hidden');
    localStorage.setItem(STORAGE_KEY, 'true');
    log.info(() => 'Chat panel shown');
  }
}

/**
 * Hide the chat panel
 */
function hideChatPanel(): void {
  const panel = document.getElementById('chat-panel');
  if (panel) {
    panel.classList.add('hidden');
    localStorage.setItem(STORAGE_KEY, 'false');
    log.info(() => 'Chat panel hidden');
  }
}

/**
 * Toggle the chat panel visibility
 */
export function toggleChatPanel(): void {
  const panel = document.getElementById('chat-panel');
  if (panel?.classList.contains('hidden')) {
    showChatPanel();
  } else {
    hideChatPanel();
  }
}

/**
 * Add a chat message and render it.
 * Tool call requests and responses are consolidated into groups.
 */
export function addChatMessage(message: ChatMessage): void {
  chatMessages.push(message);
  trimChatHistory();

  if (message.role === 'assistant' && isToolCallMessage(message.content)) {
    const toolName = extractToolName(message.content);
    const lines = message.content.split('\n');
    const args = lines.slice(1).join('\n').trim();

    if (!activeToolGroup) {
      const group = createToolGroup(message.timestamp);
      const container = document.getElementById('chat-messages');
      if (container) {
        container.appendChild(group.element);
      }
      activeToolGroup = group;
    }

    const entry = addToolEntry(activeToolGroup, toolName, args, message.timestamp);
    if (message.toolRequestId) {
      rememberToolEntry(message.toolRequestId, entry);
    }
  } else if (message.role === 'tool') {
    let entry = message.toolRequestId ? toolEntries.get(message.toolRequestId) : undefined;
    entry ??= !message.toolRequestId
      ? activeToolGroup?.entries
          .slice()
          .reverse()
          .find(
            (candidate) =>
              !candidate.response && (!message.toolName || candidate.toolName === message.toolName),
          )
      : undefined;
    if (!entry) {
      const group = createToolGroup(message.timestamp);
      document.getElementById('chat-messages')?.appendChild(group.element);
      entry = addToolEntry(group, message.toolName || 'tool', '', message.timestamp);
    }
    updateToolEntryResponse(entry, message.content);
  } else {
    finalizeToolGroup();
    renderMessage(message);
  }

  trimChatDom();
  scrollToBottom();
  log.info(() => `Chat message added: ${message.role}`);
}

function trimChatHistory(): void {
  const overflow = chatMessages.length - MAX_CHAT_MESSAGES;
  if (overflow > 0) {
    chatMessages.splice(0, overflow);
  }
}

/**
 * Check if a message is a tool call request from the assistant
 */
function isToolCallMessage(content: string): boolean {
  return content.toLowerCase().startsWith('calling tool:');
}

/**
 * Extract tool name from a tool call message
 */
function extractToolName(content: string): string {
  const match = content.match(/calling tool:\s*(\w+)/i);
  return match ? (match[1] ?? 'unknown') : 'unknown';
}

/**
 * Format JSON content for display
 */
function formatJsonContent(content: string): string {
  try {
    const trimmed = content.trim();
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      const parsed: unknown = JSON.parse(trimmed);
      return JSON.stringify(parsed, null, 2);
    }
  } catch {
    // Not valid JSON, return as-is
  }
  return content;
}

/**
 * Create a compact, keyboard-accessible tool activity disclosure.
 */
function createToolGroup(timestamp: string): ActiveToolGroup {
  const el = document.createElement('details');
  el.className = 'chat-msg chat-msg-tool-group';
  const summary = document.createElement('summary');
  summary.className = 'tool-group-header';
  summary.title = formatTime(timestamp);
  const statusEl = document.createElement('span');
  statusEl.className = 'tool-group-state';
  statusEl.setAttribute('aria-hidden', 'true');
  const countEl = document.createElement('span');
  countEl.className = 'tool-group-count';
  const namesEl = document.createElement('span');
  namesEl.className = 'tool-group-names';
  summary.append(statusEl, countEl, namesEl);
  el.appendChild(summary);

  const entriesContainer = document.createElement('div');
  entriesContainer.className = 'tool-group-entries';
  el.appendChild(entriesContainer);

  return { element: el, summary, statusEl, countEl, namesEl, entriesContainer, entries: [] };
}

function toolStateLabel(state: ToolEntry['state']): string {
  return t(`chat.tools${state.charAt(0).toUpperCase()}${state.slice(1)}`);
}

function refreshToolGroup(group: ActiveToolGroup): void {
  const state = group.entries.some((entry) => entry.state === 'failed')
    ? 'failed'
    : group.entries.some((entry) => entry.state === 'declined')
      ? 'declined'
      : group.entries.some((entry) => entry.state === 'running')
        ? 'running'
        : 'done';
  group.element.dataset.state = state;
  group.statusEl.textContent = state === 'running' ? '⋯' : state === 'done' ? '✓' : '!';
  group.countEl.textContent = String(group.entries.length);
  const names = group.entries.map((entry) => entry.toolName).join(' · ');
  group.namesEl.textContent = names;
  const label = `${group.entries.length} ${t(group.entries.length === 1 ? 'chat.toolCall' : 'chat.toolCalls')} · ${toolStateLabel(state)} · ${names}`;
  group.summary.setAttribute('aria-label', label);
  group.summary.title = label;
}

/**
 * Add a collapsible tool entry row to a group
 */
function addToolEntry(
  group: ActiveToolGroup,
  toolName: string,
  args: string,
  timestamp: string,
): ToolEntry {
  const entry: ToolEntry = {
    toolName,
    request: args,
    response: '',
    rowEl: document.createElement('details'),
    group,
    state: 'running',
    statusEl: document.createElement('span'),
    outcomeEl: document.createElement('span'),
  };
  const row = entry.rowEl;
  row.className = 'tool-group-entry-row';

  const headerRow = document.createElement('summary');
  headerRow.className = 'tool-group-entry-header';

  entry.statusEl.className = 'tool-entry-state';
  entry.statusEl.textContent = '⋯';
  entry.statusEl.setAttribute('aria-label', toolStateLabel('running'));

  const nameEl = document.createElement('span');
  nameEl.className = 'tool-group-entry-name';
  nameEl.textContent = toolName;

  headerRow.appendChild(entry.statusEl);
  headerRow.appendChild(nameEl);

  entry.outcomeEl.className = 'tool-group-entry-outcome';
  headerRow.appendChild(entry.outcomeEl);

  const detailEl = document.createElement('div');
  detailEl.className = 'tool-group-entry-detail';

  row.appendChild(headerRow);
  row.appendChild(detailEl);
  row.addEventListener('toggle', () => {
    if ((row as HTMLDetailsElement).open) rebuildDetail(entry, detailEl);
  });

  group.entriesContainer.appendChild(row);
  group.entries.push(entry);
  headerRow.title = formatTime(timestamp);
  refreshToolGroup(group);
  return entry;
}

/**
 * Rebuild the detail section (full pre blocks)
 */
function rebuildDetail(entry: ToolEntry, el: HTMLElement): void {
  const reqFormatted = entry.request ? formatJsonContent(entry.request) : '';
  const resFormatted = entry.response ? formatJsonContent(entry.response) : '';
  let html = '';
  if (reqFormatted) {
    html += `<div class="tool-group-detail-label">${escapeHtml(t('chat.toolRequest'))}</div>`;
    html += `<pre class="chat-msg-tool-args">${escapeHtml(reqFormatted)}</pre>`;
  }
  if (resFormatted) {
    html += `<div class="tool-group-detail-label">${escapeHtml(t('chat.toolResponse'))}</div>`;
    html += `<pre class="chat-msg-tool-result">${escapeHtml(resFormatted)}</pre>`;
  }
  el.innerHTML = html;
}

/**
 * Attach a tool response to an existing entry
 */
function parseToolOutcome(content: string): { state: ToolEntry['state']; outcome: string } {
  let state: ToolEntry['state'] = 'done';
  let outcome = '';
  try {
    const response = JSON.parse(content) as {
      error?: unknown;
      declined?: boolean;
      result?: { error?: unknown; success?: boolean; responseText?: unknown };
    };
    if (response.declined) state = 'declined';
    else if (response.error || response.result?.error || response.result?.success === false)
      state = 'failed';
    const description = response.error || response.result?.error || response.result?.responseText;
    if (typeof description === 'string') outcome = description;
  } catch {
    // A legacy plain-text response still remains inspectable in the detail view.
  }
  return { state, outcome };
}

function updateToolEntryResponse(entry: ToolEntry, content: string): void {
  entry.response = content;
  const { state, outcome } = parseToolOutcome(content);
  entry.state = state;
  entry.rowEl.dataset.state = entry.state;
  entry.statusEl.textContent = entry.state === 'done' ? '✓' : '!';
  entry.statusEl.setAttribute('aria-label', toolStateLabel(entry.state));
  entry.outcomeEl.textContent = outcome || toolStateLabel(entry.state);
  entry.outcomeEl.title = outcome || toolStateLabel(entry.state);
  const detailEl = entry.rowEl.querySelector<HTMLElement>('.tool-group-entry-detail');
  if (detailEl && (entry.rowEl as HTMLDetailsElement).open) {
    rebuildDetail(entry, detailEl);
  }
  refreshToolGroup(entry.group);
}

/**
 * Close the active tool group so subsequent messages render normally
 */
export function finalizeToolGroup(): void {
  if (activeToolGroup) {
    log.info(() => `Finalized tool group with ${activeToolGroup?.entries.length ?? 0} entries`);
    activeToolGroup = null;
  }
}

/**
 * Remove oldest children from #chat-messages until <= MAX_CHAT_ELEMENTS
 */
function trimChatDom(): void {
  const container = document.getElementById('chat-messages');
  if (!container) return;
  while (container.children.length > MAX_CHAT_ELEMENTS) {
    container.removeChild(container.children[0] as Node);
  }
}

/**
 * Render a conversation message; tool activity uses its compact disclosures.
 */
function renderMessage(message: ChatMessage): void {
  const container = document.getElementById('chat-messages');
  if (!container) return;

  const msgEl = document.createElement('div');
  const time = formatTime(message.timestamp);

  msgEl.className = `chat-msg chat-msg-${message.role}`;
  msgEl.innerHTML = `
      <div class="chat-msg-content${message.role === 'assistant' ? ' chat-markdown' : ''}">${message.role === 'assistant' ? renderMarkdown(message.content) : escapeHtml(message.content)}</div>
      <div class="chat-msg-time">${time}</div>
    `;

  container.appendChild(msgEl);
}

/**
 * Scroll the chat messages to the bottom
 */
function scrollToBottom(): void {
  const container = document.getElementById('chat-messages');
  if (container) {
    container.scrollTop = container.scrollHeight;
  }
}

/**
 * Format ISO timestamp to time string (HH:MM)
 */
function formatTime(timestamp: string): string {
  try {
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

/**
 * Format a tool request for display
 */
function formatSendPromptToolDisplay(args: Record<string, unknown>): string {
  const sessionId = (args.sessionId as string) || '';
  const text = (args.text as string) || '';
  return `Send prompt to ${sessionId}:\n${text}`;
}

function formatAgentTurnToolDisplay(args: Record<string, unknown>): string {
  const sessionId = (args.sessionId as string) || 'focused session';
  const text = (args.text as string) || '';
  const timeoutMs = Number(args.timeoutMs) || 45000;
  return `Run agent turn on ${sessionId}\nTimeout: ${Math.round(timeoutMs / 1000)}s\n${text}`;
}

function formatDevBrowserToolDisplay(args: Record<string, unknown>): string {
  const command = (args.command as string) || '';
  const selector = (args.selector as string) || '';
  const value = (args.value as string) || '';
  const target = [args.sessionId as string | undefined, args.previewName as string | undefined]
    .filter(Boolean)
    .join('/');
  const lines = [`Run Dev Browser command${target ? ` on ${target}` : ''}: ${command}`];
  if (selector) lines.push(`Selector: ${selector}`);
  if (value) lines.push(`Value: ${value}`);
  return lines.join('\n');
}

function formatDevBrowserScreenshotToolDisplay(args: Record<string, unknown>): string {
  const target = [args.sessionId as string | undefined, args.previewName as string | undefined]
    .filter(Boolean)
    .join('/');
  return `Capture Dev Browser screenshot${target ? ` on ${target}` : ''}`;
}

function formatRepoMonitorToolDisplay(args: Record<string, unknown>): string {
  const action = (args.action as string) || 'list';
  const sessionId = (args.sessionId as string) || 'active session';
  const path = (args.path as string) || '';
  const repoRoot = (args.repoRoot as string) || '';
  const lines = [`Repo monitor ${action} on ${sessionId}`];
  if (path) lines.push(`Path: ${path}`);
  if (repoRoot) lines.push(`Repo root: ${repoRoot}`);
  return lines.join('\n');
}

function formatLayoutControlToolDisplay(args: Record<string, unknown>): string {
  const action = (args.action as string) || 'status';
  const sessionId = (args.sessionId as string) || '';
  const targetSessionId = (args.targetSessionId as string) || '';
  const otherSessionId = (args.otherSessionId as string) || '';
  const position = (args.position as string) || '';
  const lines = [`Layout control: ${action}`];
  if (sessionId) lines.push(`Session: ${sessionId}`);
  if (targetSessionId) lines.push(`Target: ${targetSessionId}`);
  if (otherSessionId) lines.push(`Other: ${otherSessionId}`);
  if (position) lines.push(`Position: ${position}`);
  return lines.join('\n');
}

function formatMakeInputToolDisplay(args: Record<string, unknown>): string {
  const text = (args.text as string) || '';
  const formatted = formatInputText(text);
  return `Send to terminal:\n${formatted}`;
}

function formatSessionOverviewToolDisplay(args: Record<string, unknown>): string {
  const includeBrowserStatus = args.includeBrowserStatus !== false;
  const includeRepoStatus = args.includeRepoStatus !== false;
  const lines = ['Inspect sessions'];
  lines.push(`Browser: ${includeBrowserStatus ? 'yes' : 'no'}`);
  lines.push(`Repos: ${includeRepoStatus ? 'yes' : 'no'}`);
  return lines.join('\n');
}

function formatConversationContinuityToolDisplay(args: Record<string, unknown>): string {
  const sessionId = (args.sessionId as string | undefined)?.trim();
  const scope = (args.scope as string | undefined) || (sessionId ? 'active' : 'active');
  const includeTail = args.includeTail === true;
  const lines = ['Summarize continuity'];
  lines.push(`Scope: ${sessionId || scope}`);
  lines.push(`Tail: ${includeTail ? 'yes' : 'no'}`);
  return lines.join('\n');
}

function formatCampaignStatusToolDisplay(args: Record<string, unknown>): string {
  const scope = (args.scope as string | undefined) || 'all';
  const waitForBusy = args.waitForBusy === true;
  const lines = ['Campaign status'];
  lines.push(`Scope: ${scope}`);
  lines.push(`Wait: ${waitForBusy ? 'yes' : 'no'}`);
  return lines.join('\n');
}

function formatWaitForTurnCompletionToolDisplay(args: Record<string, unknown>): string {
  const sessionId = (args.sessionId as string | undefined)?.trim() || 'session';
  const timeoutMs = Number(args.timeoutMs) || 45000;
  return `Wait for turn completion\nSession: ${sessionId}\nTimeout: ${Math.round(timeoutMs / 1000)}s`;
}

function formatInteractiveReadToolDisplay(args: Record<string, unknown>): string {
  const ops = (args.operations as InteractiveOp[] | undefined) ?? [];
  const lines = ops.map((op, i) => {
    if (op.type === 'input') {
      return `${i + 1}. Input: ${formatInputText(op.data || '')}`;
    } else if (op.type === 'delay') {
      return `${i + 1}. Wait ${op.delayMs || 100}ms`;
    }
    return `${i + 1}. Screenshot`;
  });
  return `Interactive sequence:\n${lines.join('\n')}`;
}

const toolDisplayFormatters = new Map<string, (args: Record<string, unknown>) => string>(
  Object.entries({
    send_prompt: formatSendPromptToolDisplay,
    agent_turn: formatAgentTurnToolDisplay,
    session_overview: formatSessionOverviewToolDisplay,
    conversation_continuity: formatConversationContinuityToolDisplay,
    campaign_status: formatCampaignStatusToolDisplay,
    wait_for_turn_completion: formatWaitForTurnCompletionToolDisplay,
    dev_browser_command: formatDevBrowserToolDisplay,
    dev_browser_screenshot: formatDevBrowserScreenshotToolDisplay,
    repo_monitor: formatRepoMonitorToolDisplay,
    layout_control: formatLayoutControlToolDisplay,
    make_input: formatMakeInputToolDisplay,
    interactive_read: formatInteractiveReadToolDisplay,
  }),
);

function formatToolDisplay(tool: VoiceToolName, args: Record<string, unknown>): string {
  const formatter = toolDisplayFormatters.get(tool);
  return formatter ? formatter(args) : `Tool: ${tool}`;
}

/**
 * Format input text with escape sequence visualization
 */
function formatInputText(text: string): string {
  let result = text;
  result = result.split('\r').join('⏎');
  result = result.split('\n').join('↵');
  result = result.split('\t').join('⇥');
  result = result.split(String.fromCharCode(3)).join('^C'); // Ctrl+C
  result = result.split(String.fromCharCode(27) + '[A').join('↑'); // Arrow Up
  result = result.split(String.fromCharCode(27) + '[B').join('↓'); // Arrow Down
  result = result.split(String.fromCharCode(27) + '[C').join('→'); // Arrow Right
  result = result.split(String.fromCharCode(27) + '[D').join('←'); // Arrow Left
  result = result.split(String.fromCharCode(27) + '[5~').join('⇞'); // Page Up
  result = result.split(String.fromCharCode(27) + '[6~').join('⇟'); // Page Down
  result = result.split(String.fromCharCode(27)).join('ESC'); // Remaining ESC
  return result;
}

/**
 * Show a tool confirmation dialog in the chat panel
 * Returns true if approved, false if declined
 */
export function showToolConfirmation(
  tool: VoiceToolName,
  args: Record<string, unknown>,
  justification: string | undefined,
): Promise<boolean> {
  if (autoAcceptEnabled) {
    log.info(() => `Auto-accepting tool: ${tool}`);
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const container = document.getElementById('chat-messages');
    if (!container) {
      log.warn(() => 'Chat container not found, auto-declining');
      resolve(false);
      return;
    }

    finalizeToolGroup();

    const displayText = formatToolDisplay(tool, args);

    const msgEl = document.createElement('div');
    msgEl.className = 'chat-msg chat-msg-tool-confirm';

    msgEl.innerHTML = `
      <div class="chat-msg-tool-header">
        <span class="chat-msg-tool-icon">⚠️</span>
        <span class="chat-msg-tool-title">Action requires approval</span>
      </div>
      <div class="chat-msg-tool-name">${escapeHtml(tool)}</div>
      <pre class="chat-msg-tool-command">${escapeHtml(displayText)}</pre>
      ${justification ? `<div class="chat-msg-tool-justification">${escapeHtml(justification)}</div>` : ''}
      <div class="chat-msg-tool-actions">
        <button class="btn-tool-accept">Accept</button>
        <button class="btn-tool-decline">Decline</button>
        <label class="tool-auto-accept">
          <input type="checkbox" class="tool-auto-accept-check" />
          Auto-accept this session
        </label>
      </div>
    `;

    container.appendChild(msgEl);
    trimChatDom();
    scrollToBottom();

    const acceptBtn = msgEl.querySelector('.btn-tool-accept') as HTMLButtonElement;
    const declineBtn = msgEl.querySelector('.btn-tool-decline') as HTMLButtonElement;
    const autoAcceptCheck = msgEl.querySelector('.tool-auto-accept-check') as HTMLInputElement;

    const handleResponse = (approved: boolean): void => {
      if (autoAcceptCheck.checked) {
        autoAcceptEnabled = true;
        log.info(() => 'Auto-accept enabled for this session');
      }

      msgEl.classList.add(approved ? 'confirmed' : 'declined');
      const actionsEl = msgEl.querySelector('.chat-msg-tool-actions');
      if (actionsEl) {
        actionsEl.innerHTML = approved
          ? '<span class="tool-status accepted">✓ Accepted</span>'
          : '<span class="tool-status declined">✗ Declined</span>';
      }

      log.info(() => `Tool ${tool} ${approved ? 'accepted' : 'declined'}`);
      resolve(approved);
    };

    acceptBtn.addEventListener('click', () => {
      handleResponse(true);
    });
    declineBtn.addEventListener('click', () => {
      handleResponse(false);
    });
  });
}
