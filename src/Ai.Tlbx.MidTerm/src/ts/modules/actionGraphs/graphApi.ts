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
  name: string;
  nodeCount: number;
  edgeCount: number;
  updatedAt: string;
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

interface WorkerBootstrapResponsePayload {
  session?: { id?: string };
}

/**
 * Execute a stored launch spec verbatim: bootstrap an agent-controlled session,
 * then deliver the prompt through the state-aware prompt API.
 */
export async function runNodeAction(
  nodeTitle: string,
  action: ActionGraphNodeAction,
): Promise<string> {
  const bootstrapResponse = await fetch('/api/workers/bootstrap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: action.sessionName?.trim() || nodeTitle,
      workingDirectory: action.cwd ?? undefined,
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
