/**
 * Fetch layer for agent-curated action graphs. Pure CRUD reads plus the two
 * existing launch APIs an action composes: worker bootstrap and prompt.
 */

export interface ActionGraphNodeAction {
  id: string;
  label: string;
  cwd?: string | null;
  command?: string | null;
  profile?: string | null;
  prompt?: string | null;
  sessionName?: string | null;
  slashCommands?: string[];
}

export interface ActionGraphSessionBinding {
  sessionId: string;
  role?: string | null;
  createdAt: string;
}

export interface ActionGraphNode {
  id: string;
  kind: string;
  title: string;
  state?: string | null;
  html?: string | null;
  x: number;
  y: number;
  width?: number | null;
  height?: number | null;
  minZoom?: number | null;
  maxZoom?: number | null;
  pinned: boolean;
  attention: boolean;
  hidden: boolean;
  color?: string | null;
  url?: string | null;
  path?: string | null;
  host?: string | null;
  project?: string | null;
  sessionId?: string | null;
  externalRef?: string | null;
  date?: string | null;
  actions: ActionGraphNodeAction[];
  sessions: ActionGraphSessionBinding[];
  source: string;
  updatedAt: string;
  revision: number;
}

export interface ActionGraphEdge {
  id: string;
  fromId: string;
  toId: string;
  label?: string | null;
  kind?: string | null;
  revision: number;
}

export interface ActionGraph {
  id: string;
  name: string;
  nodes: ActionGraphNode[];
  edges: ActionGraphEdge[];
  refreshCommand?: string | null;
  refreshCwd?: string | null;
  refreshPrompt?: string | null;
  updatedAt: string;
  revision: number;
}

export interface ActionGraphSummary {
  id: string;
  scopeId: string;
  name: string;
  nodeCount: number;
  edgeCount: number;
  updatedAt: string;
  revision: number;
}

export interface ActionGraphScope {
  id: string;
  name: string;
  graphCount: number;
}

export interface UpsertNodePayload {
  id?: string;
  kind?: string;
  title?: string;
  state?: string;
  html?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  minZoom?: number;
  maxZoom?: number;
  pinned?: boolean;
  attention?: boolean;
  hidden?: boolean;
  color?: string;
  sessionId?: string;
  url?: string;
  path?: string;
  host?: string;
  project?: string;
  date?: string;
  actions?: Omit<ActionGraphNodeAction, 'id'>[];
  source?: string;
  expectedRevision?: number;
  expectedGraphRevision?: number;
}

export async function fetchGraphList(signal?: AbortSignal): Promise<ActionGraphSummary[]> {
  const response = await fetch('/api/graphs', { signal: signal ?? null });
  if (!response.ok) {
    throw new Error(`Graph list failed: ${response.status}`);
  }
  const payload = (await response.json()) as { graphs?: ActionGraphSummary[] };
  return payload.graphs ?? [];
}

export async function fetchGraph(graphId: string, signal?: AbortSignal): Promise<ActionGraph> {
  const response = await fetch(`/api/graphs/${encodeURIComponent(graphId)}`, {
    signal: signal ?? null,
  });
  if (!response.ok) {
    throw new Error(`Graph load failed: ${response.status}`);
  }
  return (await response.json()) as ActionGraph;
}

export async function persistNodePosition(
  graphId: string,
  nodeId: string,
  x: number,
  y: number,
  expectedRevision: number,
): Promise<ActionGraphNode> {
  return (await throwingFetch(
    `/api/graphs/${encodeURIComponent(graphId)}/nodes/${encodeURIComponent(nodeId)}/position`,
    'POST',
    { x, y, expectedRevision },
  )) as ActionGraphNode;
}

export async function fetchScopes(signal?: AbortSignal): Promise<ActionGraphScope[]> {
  const response = await fetch('/api/graph-scopes', { signal: signal ?? null });
  if (!response.ok) {
    throw new Error(`Scope list failed: ${response.status}`);
  }
  const payload = (await response.json()) as { scopes?: ActionGraphScope[] };
  return payload.scopes ?? [];
}

export async function createScope(id: string, name: string): Promise<void> {
  await throwingFetch('/api/graph-scopes', 'POST', { id, name });
}

export async function createGraph(id: string, name: string, scopeId: string): Promise<void> {
  await throwingFetch('/api/graphs', 'POST', { id, name, scopeId });
}

export async function saveGraphRefresh(
  graphId: string,
  spec: {
    refreshCommand: string;
    refreshCwd: string;
    refreshPrompt: string;
    expectedRevision?: number;
  },
): Promise<void> {
  await throwingFetch('/api/graphs', 'POST', { id: graphId, ...spec });
}

/**
 * Launch the graph's stored refresh spec in a visible session: plain shell in the
 * configured cwd, the free-form agent command typed verbatim, then the prompt via
 * the state-aware prompt API.
 */
export async function runGraphRefresh(graph: ActionGraph, defaultCwd?: string): Promise<string> {
  const bootstrapResponse = await fetch('/api/workers/bootstrap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: `Sync: ${graph.name}`,
      workingDirectory: graph.refreshCwd?.trim() || defaultCwd || undefined,
      launchCommand: graph.refreshCommand?.trim(),
      agentControlled: true,
      injectGuidance: true,
    }),
  });
  if (!bootstrapResponse.ok) {
    throw new Error(`Refresh launch failed: ${bootstrapResponse.status}`);
  }
  const payload = (await bootstrapResponse.json()) as WorkerBootstrapResponsePayload;
  const sessionId = payload.session?.id;
  if (!sessionId) {
    throw new Error('Refresh launch did not return a session id.');
  }
  const prompt = graph.refreshPrompt?.trim();
  if (prompt) {
    await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/input/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: [
          'tlbx Action Graph refresh context:',
          `- graphId: ${graph.id}`,
          `- graphRevision: ${graph.revision}`,
          '- Read .tlbx/AGENTS.md or .tlbx/CLAUDE.md and load the generated tlbx_graphs helper.',
          `- Start with: mtg_graph ${graph.id}`,
          '- Use mtg_help before mutating and preserve optimistic-concurrency revisions.',
          '',
          'Task:',
          prompt,
        ].join('\n'),
        mode: 'auto',
      }),
    });
  }
  return sessionId;
}

export async function deleteGraph(graphId: string, expectedRevision?: number): Promise<void> {
  const query =
    expectedRevision === undefined
      ? ''
      : `?expectedRevision=${encodeURIComponent(expectedRevision)}`;
  await throwingFetch(`/api/graphs/${encodeURIComponent(graphId)}${query}`, 'DELETE');
}

export async function organizeGraph(
  graphId: string,
  expectedGraphRevision?: number,
): Promise<ActionGraph> {
  return (await throwingFetch(`/api/graphs/${encodeURIComponent(graphId)}/organize`, 'POST', {
    expectedGraphRevision,
  })) as ActionGraph;
}

export async function createNode(
  graphId: string,
  payload: UpsertNodePayload,
): Promise<ActionGraphNode> {
  return (await throwingFetch(
    `/api/graphs/${encodeURIComponent(graphId)}/nodes`,
    'POST',
    payload,
  )) as ActionGraphNode;
}

export async function updateNode(
  graphId: string,
  nodeId: string,
  payload: UpsertNodePayload,
): Promise<ActionGraphNode> {
  return (await throwingFetch(
    `/api/graphs/${encodeURIComponent(graphId)}/nodes/${encodeURIComponent(nodeId)}`,
    'PATCH',
    payload,
  )) as ActionGraphNode;
}

export async function deleteNode(
  graphId: string,
  nodeId: string,
  expectedRevision?: number,
  expectedGraphRevision?: number,
): Promise<void> {
  const search = new URLSearchParams();
  if (expectedRevision !== undefined) search.set('expectedRevision', String(expectedRevision));
  if (expectedGraphRevision !== undefined) {
    search.set('expectedGraphRevision', String(expectedGraphRevision));
  }
  const query = search.size > 0 ? `?${search.toString()}` : '';
  await throwingFetch(
    `/api/graphs/${encodeURIComponent(graphId)}/nodes/${encodeURIComponent(nodeId)}${query}`,
    'DELETE',
  );
}

export async function createEdge(
  graphId: string,
  fromId: string,
  toId: string,
  expectedGraphRevision?: number,
): Promise<void> {
  await throwingFetch(`/api/graphs/${encodeURIComponent(graphId)}/edges`, 'POST', {
    fromId,
    toId,
    expectedGraphRevision,
  });
}

export async function deleteEdge(
  graphId: string,
  edgeId: string,
  expectedGraphRevision?: number,
): Promise<void> {
  const query =
    expectedGraphRevision === undefined
      ? ''
      : `?expectedGraphRevision=${encodeURIComponent(expectedGraphRevision)}`;
  await throwingFetch(
    `/api/graphs/${encodeURIComponent(graphId)}/edges/${encodeURIComponent(edgeId)}${query}`,
    'DELETE',
  );
}

export async function bindSession(
  graphId: string,
  nodeId: string,
  sessionId: string,
  role: string,
  expectedGraphRevision?: number,
): Promise<ActionGraphNode> {
  return (await throwingFetch(
    `/api/graphs/${encodeURIComponent(graphId)}/nodes/${encodeURIComponent(nodeId)}/sessions`,
    'POST',
    { sessionId, role, expectedGraphRevision },
  )) as ActionGraphNode;
}

async function throwingFetch(url: string, method: string, body?: unknown): Promise<unknown> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const response = await fetch(url, init);
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || `${method} ${url} failed: ${response.status}`);
  }
  const text = await response.text();
  return text ? (JSON.parse(text) as unknown) : undefined;
}

interface WorkerBootstrapResponsePayload {
  session?: { id?: string };
}

/**
 * Execute a stored launch spec verbatim: bootstrap an agent-controlled session,
 * then deliver the prompt through the state-aware prompt API. Actions without a
 * cwd of their own fall back to the configured default working directory.
 */
export async function runNodeAction(
  graphId: string,
  node: ActionGraphNode,
  action: ActionGraphNodeAction,
  defaultCwd?: string,
): Promise<string> {
  const bootstrapResponse = await fetch('/api/workers/bootstrap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(workerBootstrapPayload(node, action, defaultCwd)),
  });
  if (!bootstrapResponse.ok) {
    throw new Error(`Session launch failed: ${bootstrapResponse.status}`);
  }
  const payload = (await bootstrapResponse.json()) as WorkerBootstrapResponsePayload;
  const sessionId = payload.session?.id;
  if (!sessionId) {
    throw new Error('Session launch did not return a session id.');
  }

  const prompt = graphAwarePrompt(graphId, node, action.prompt?.trim());
  if (prompt) {
    await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/input/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: prompt, mode: 'auto' }),
    });
  }

  return sessionId;
}

function workerBootstrapPayload(
  node: ActionGraphNode,
  action: ActionGraphNodeAction,
  defaultCwd?: string,
): Record<string, unknown> {
  const command = action.command?.trim();
  return {
    name: action.sessionName?.trim() || node.title,
    workingDirectory: action.cwd?.trim() || defaultCwd,
    launchCommand: command,
    profile: action.profile ?? (command ? undefined : 'terminal'),
    agentControlled: true,
    injectGuidance: true,
    slashCommands: action.slashCommands ?? [],
  };
}

function graphAwarePrompt(
  graphId: string,
  node: ActionGraphNode,
  task: string | undefined,
): string {
  const context = [
    'tlbx Action Graph context:',
    `- graphId: ${graphId}`,
    `- nodeId: ${node.id}`,
    `- nodeRevision: ${node.revision}`,
    '- tlbx stores exact graph/session facts but does not interpret their meaning.',
    '- Read .tlbx/AGENTS.md or .tlbx/CLAUDE.md, then load the generated tlbx_graphs helper.',
    `- Start with: mtg_context ${graphId} ${node.id}`,
    '- Use mtg_help for mutation and concurrency examples.',
    '- Keep this node and its graph neighborhood current as the work changes.',
  ].join('\n');
  return task ? `${context}\n\nTask:\n${task}` : context;
}
