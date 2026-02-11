/**
 * Command Output Panel
 *
 * Streams and displays command execution output via SSE.
 */

import { createLogger } from '../logging';
import { cancelRun } from './commandsApi';

const log = createLogger('commandOutput');

interface OutputState {
  container: HTMLElement;
  runId: string;
  eventSource: EventSource | null;
  lines: string[];
}

const outputStates = new Map<string, OutputState>();

export function showOutput(
  container: HTMLElement,
  runId: string,
  onDone?: (status: string) => void,
): void {
  hideOutput(runId);

  container.innerHTML = `
    <div class="commands-output" data-run-id="${runId}">
      <div class="commands-output-header">
        <span class="commands-output-status">Running...</span>
        <button class="commands-output-cancel">Cancel</button>
      </div>
      <pre class="commands-output-content"></pre>
    </div>`;

  const contentEl = container.querySelector('.commands-output-content') as HTMLPreElement;
  const statusEl = container.querySelector('.commands-output-status') as HTMLElement;

  const state: OutputState = {
    container,
    runId,
    eventSource: null,
    lines: [],
  };
  outputStates.set(runId, state);

  container.querySelector('.commands-output-cancel')?.addEventListener('click', async () => {
    await cancelRun(runId);
    statusEl.textContent = 'Cancelling...';
  });

  const es = new EventSource(`/api/commands/run/${encodeURIComponent(runId)}/stream`);
  state.eventSource = es;

  es.onmessage = (event) => {
    state.lines.push(event.data);
    contentEl.textContent += event.data + '\n';
    contentEl.scrollTop = contentEl.scrollHeight;
  };

  es.addEventListener('done', (event) => {
    const status = (event as MessageEvent).data || 'completed';
    statusEl.textContent = status === 'completed' ? 'Completed' : `Failed (${status})`;
    statusEl.classList.add(status === 'completed' ? 'status-success' : 'status-error');
    container.querySelector('.commands-output-cancel')?.remove();
    es.close();
    state.eventSource = null;
    onDone?.(status);
  });

  es.onerror = () => {
    log.warn(() => `SSE error for run ${runId}`);
    statusEl.textContent = 'Connection lost';
    es.close();
    state.eventSource = null;
    onDone?.('error');
  };
}

export function hideOutput(runId: string): void {
  const state = outputStates.get(runId);
  if (!state) return;
  state.eventSource?.close();
  outputStates.delete(runId);
}
