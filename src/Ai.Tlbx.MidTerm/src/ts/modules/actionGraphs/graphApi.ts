/**
 * Fetch layer for agent-curated action graphs. Pure CRUD reads plus the two
 * existing launch APIs an action composes: worker bootstrap and prompt.
 */

export interface ActionGraphNodeAction {
  id: string;
  label: string;
  cwd?: string | null;
  profile?: string | null;
  prompt?: string | null;
  sessionName?: string | null;
  slashCommands?: string[];
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
  color?: string | null;
  url?: string | null;
  path?: string | null;
  host?: string | null;
  project?: string | null;
  sessionId?: string | null;
  externalRef?: string | null;
  date?: string | null;
  actions: ActionGraphNodeAction[];
  source: string;
  updatedAt: string;
}

export interface ActionGraphEdge {
  id: string;
  fromId: string;
  toId: string;
  label?: string | null;
  kind?: string | null;
}

export interface ActionGraph {
  id: string;
  name: string;
  nodes: ActionGraphNode[];
  edges: ActionGraphEdge[];
  updatedAt: string;
}

export interface ActionGraphSummary {
  id: string;
  scopeId: string;
  name: string;
  nodeCount: number;
  edgeCount: number;
  updatedAt: string;
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
  color?: string;
  sessionId?: string;
  url?: string;
  path?: string;
  host?: string;
  project?: string;
  date?: string;
  actions?: Omit<ActionGraphNodeAction, 'id'>[];
  source?: string;
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
): Promise<void> {
  await fetch(
    `/api/graphs/${encodeURIComponent(graphId)}/nodes/${encodeURIComponent(nodeId)}/position`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ x, y }),
    },
  );
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

export async function deleteGraph(graphId: string): Promise<void> {
  await throwingFetch(`/api/graphs/${encodeURIComponent(graphId)}`, 'DELETE');
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

export async function deleteNode(graphId: string, nodeId: string): Promise<void> {
  await throwingFetch(
    `/api/graphs/${encodeURIComponent(graphId)}/nodes/${encodeURIComponent(nodeId)}`,
    'DELETE',
  );
}

export async function createEdge(graphId: string, fromId: string, toId: string): Promise<void> {
  await throwingFetch(`/api/graphs/${encodeURIComponent(graphId)}/edges`, 'POST', { fromId, toId });
}

export async function deleteEdge(graphId: string, edgeId: string): Promise<void> {
  await throwingFetch(
    `/api/graphs/${encodeURIComponent(graphId)}/edges/${encodeURIComponent(edgeId)}`,
    'DELETE',
  );
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
  nodeTitle: string,
  action: ActionGraphNodeAction,
  defaultCwd?: string,
): Promise<string> {
  const bootstrapResponse = await fetch('/api/workers/bootstrap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: action.sessionName?.trim() || nodeTitle,
      workingDirectory: action.cwd?.trim() || defaultCwd || undefined,
      profile: action.profile ?? 'terminal',
      agentControlled: true,
      injectGuidance: true,
      slashCommands: action.slashCommands ?? [],
    }),
  });
  if (!bootstrapResponse.ok) {
    throw new Error(`Session launch failed: ${bootstrapResponse.status}`);
  }
  const payload = (await bootstrapResponse.json()) as WorkerBootstrapResponsePayload;
  const sessionId = payload.session?.id;
  if (!sessionId) {
    throw new Error('Session launch did not return a session id.');
  }

  const prompt = action.prompt?.trim();
  if (prompt) {
    await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/input/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: prompt, mode: 'auto' }),
    });
  }

  return sessionId;
}
