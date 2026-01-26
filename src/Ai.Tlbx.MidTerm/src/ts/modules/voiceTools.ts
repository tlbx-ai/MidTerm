/**
 * Voice Tools Module
 *
 * Handles tool requests from the voice assistant server.
 * Tools execute locally in the browser using xterm.js buffers and stores.
 */

import { createLogger } from './logging';
import { sendInput } from './comms/muxChannel';
import { sessionTerminals } from '../state';
import { $sessionList, $activeSessionId, $updateInfo, getSession } from '../stores';
import type {
  VoiceToolRequest,
  VoiceToolResponse,
  MakeInputArgs,
  ReadScrollbackArgs,
  InteractiveReadArgs,
  StateOfThingsResult,
  VoiceSessionState,
  MakeInputResult,
  ReadScrollbackResult,
  InteractiveReadResult,
  InteractiveOpResult,
  BellNotification,
} from '../types';
import { JS_BUILD_VERSION } from '../constants';

const log = createLogger('voiceTools');

const recentBells: BellNotification[] = [];
const MAX_BELL_HISTORY = 10;

/**
 * Record a bell notification for a session
 */
export function recordBell(sessionId: string): void {
  recentBells.push({
    sessionId,
    timestamp: new Date().toISOString(),
  });
  if (recentBells.length > MAX_BELL_HISTORY) {
    recentBells.shift();
  }
}

/**
 * Get only the visible viewport content (cols x rows).
 * Returns descriptive message if terminal isn't rendered yet.
 */
function getTerminalViewport(sessionId: string): string {
  const termState = sessionTerminals.get(sessionId);
  if (!termState?.terminal) {
    return '[terminal not in view - ask user to switch to this session to see content]';
  }

  const terminal = termState.terminal;
  const buffer = terminal.buffer.active;
  const viewportStart = buffer.baseY;
  const rows = terminal.rows;
  const lines: string[] = [];

  for (let i = 0; i < rows; i++) {
    const lineIndex = viewportStart + i;
    const line = buffer.getLine(lineIndex);
    if (line) {
      lines.push(line.translateToString(true));
    }
  }

  return lines.join('\n');
}

/**
 * Parse escape sequences in text.
 * Handles: \r \n \t \x## (hex byte)
 */
function parseEscapeSequences(text: string): string {
  return text
    .replace(/\\r/g, '\r')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Sleep helper for delays between operations.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Handle state_of_things tool - get comprehensive state of all terminals.
 */
async function handleStateOfThings(): Promise<StateOfThingsResult> {
  const sessions = $sessionList.get();
  const activeId = $activeSessionId.get();
  const updateInfo = $updateInfo.get();

  const sessionStates: VoiceSessionState[] = sessions.map((s) => ({
    id: s.id,
    userTitle: s.name,
    terminalTitle: s.terminalTitle,
    foregroundName: s.foregroundName ?? null,
    foregroundCommandLine: s.foregroundCommandLine ?? null,
    currentDirectory: s.currentDirectory ?? null,
    shell: s.shellType,
    cols: s.cols,
    rows: s.rows,
    isRunning: true,
    isActive: s.id === activeId,
    screenContent: getTerminalViewport(s.id),
  }));

  return {
    sessions: sessionStates,
    activeSessionId: activeId,
    version: JS_BUILD_VERSION,
    updateAvailable: updateInfo?.available ?? false,
    recentBells: [...recentBells],
  };
}

/**
 * Handle make_input tool - send input to a terminal and capture result.
 */
async function handleMakeInput(args: MakeInputArgs): Promise<MakeInputResult> {
  const { sessionId, text, delayMs = 100 } = args;

  const session = getSession(sessionId);
  if (!session) {
    return {
      success: false,
      screenContent: `Session ${sessionId} not found`,
      cols: 0,
      rows: 0,
    };
  }

  const parsedText = parseEscapeSequences(text);
  sendInput(sessionId, parsedText);

  await sleep(delayMs);

  return {
    success: true,
    screenContent: getTerminalViewport(sessionId),
    cols: session.cols,
    rows: session.rows,
  };
}

/**
 * Handle read_scrollback tool - read lines from terminal scrollback.
 */
async function handleReadScrollback(args: ReadScrollbackArgs): Promise<ReadScrollbackResult> {
  const { sessionId, start = 'bottom', lines = 40 } = args;

  const termState = sessionTerminals.get(sessionId);
  if (!termState?.terminal) {
    return {
      content: `Session ${sessionId} not found`,
      totalLines: 0,
      returnedLines: 0,
      startLine: 0,
    };
  }

  const buffer = termState.terminal.buffer.active;
  const totalLines = buffer.length;
  const requestedLines = Math.min(lines, 500);

  let startLine: number;
  if (start === 'bottom') {
    startLine = Math.max(0, totalLines - requestedLines);
  } else {
    startLine = Math.max(0, Math.min(parseInt(start, 10) || 0, totalLines - 1));
  }

  const endLine = Math.min(startLine + requestedLines, totalLines);
  const extractedLines: string[] = [];

  for (let i = startLine; i < endLine; i++) {
    const line = buffer.getLine(i);
    if (line) {
      extractedLines.push(line.translateToString(true));
    }
  }

  return {
    content: extractedLines.join('\n'),
    totalLines,
    returnedLines: extractedLines.length,
    startLine,
  };
}

/**
 * Handle interactive_read tool - execute operation sequences for TUI navigation.
 */
async function handleInteractiveRead(args: InteractiveReadArgs): Promise<InteractiveReadResult> {
  const { sessionId, operations } = args;

  const session = getSession(sessionId);
  if (!session) {
    return {
      results: [{ index: 0, success: false, screenshot: `Session ${sessionId} not found` }],
    };
  }

  const results: InteractiveOpResult[] = [];

  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    if (!op) continue;

    try {
      switch (op.type) {
        case 'input':
          if (op.data) {
            const parsed = parseEscapeSequences(op.data);
            sendInput(sessionId, parsed);
          }
          results.push({ index: i, success: true });
          break;

        case 'delay':
          await sleep(op.delayMs ?? 100);
          results.push({ index: i, success: true });
          break;

        case 'screenshot':
          results.push({
            index: i,
            success: true,
            screenshot: getTerminalViewport(sessionId),
          });
          break;

        default:
          results.push({ index: i, success: false });
      }
    } catch (err) {
      log.error(() => `Operation ${i} failed: ${err}`);
      results.push({ index: i, success: false });
    }
  }

  return { results };
}

/**
 * Process a tool request from the voice server.
 * Returns a tool response to send back.
 */
export async function processToolRequest(request: VoiceToolRequest): Promise<VoiceToolResponse> {
  log.info(() => `Processing tool request: ${request.tool} (${request.requestId})`);

  try {
    let result: unknown;

    switch (request.tool) {
      case 'state_of_things':
        result = await handleStateOfThings();
        break;

      case 'make_input':
        result = await handleMakeInput(request.args as unknown as MakeInputArgs);
        break;

      case 'read_scrollback':
        result = await handleReadScrollback(request.args as unknown as ReadScrollbackArgs);
        break;

      case 'interactive_read':
        result = await handleInteractiveRead(request.args as unknown as InteractiveReadArgs);
        break;

      default:
        return {
          type: 'tool_response',
          requestId: request.requestId,
          result: null,
          error: `Unknown tool: ${request.tool}`,
        };
    }

    log.info(() => `Tool ${request.tool} completed successfully`);
    return {
      type: 'tool_response',
      requestId: request.requestId,
      result,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log.error(() => `Tool ${request.tool} failed: ${errorMsg}`);
    return {
      type: 'tool_response',
      requestId: request.requestId,
      result: null,
      error: errorMsg,
    };
  }
}
