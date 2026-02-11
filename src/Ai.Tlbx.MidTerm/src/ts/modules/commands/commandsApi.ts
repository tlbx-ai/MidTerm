/**
 * Commands API
 *
 * REST wrappers for command CRUD and execution.
 */

export interface CommandDefinition {
  filename: string;
  name: string;
  description: string;
  commands: string[];
  order: number;
}

export interface CommandListResponse {
  commandsDirectory: string;
  commands: CommandDefinition[];
}

export interface CommandRunStatus {
  runId: string;
  status: string;
  exitCode?: number;
  currentStep: number;
  totalSteps: number;
}

export async function fetchCommands(sessionId: string): Promise<CommandListResponse | null> {
  try {
    const res = await fetch(`/api/commands?sessionId=${encodeURIComponent(sessionId)}`);
    if (!res.ok) return null;
    return (await res.json()) as CommandListResponse;
  } catch {
    return null;
  }
}

export async function createCommand(
  sessionId: string,
  name: string,
  description: string,
  commands: string[],
): Promise<CommandDefinition | null> {
  try {
    const res = await fetch('/api/commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, name, description, commands }),
    });
    if (!res.ok) return null;
    return (await res.json()) as CommandDefinition;
  } catch {
    return null;
  }
}

export async function updateCommand(
  filename: string,
  sessionId: string,
  name: string,
  description: string,
  commands: string[],
): Promise<CommandDefinition | null> {
  try {
    const res = await fetch(`/api/commands/${encodeURIComponent(filename)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, name, description, commands }),
    });
    if (!res.ok) return null;
    return (await res.json()) as CommandDefinition;
  } catch {
    return null;
  }
}

export async function deleteCommand(filename: string, sessionId: string): Promise<boolean> {
  try {
    const res = await fetch(
      `/api/commands/${encodeURIComponent(filename)}?sessionId=${encodeURIComponent(sessionId)}`,
      { method: 'DELETE' },
    );
    return res.ok;
  } catch {
    return false;
  }
}

export async function runCommand(sessionId: string, filename: string): Promise<string | null> {
  try {
    const res = await fetch('/api/commands/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, filename }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { runId: string };
    return data.runId;
  } catch {
    return null;
  }
}

export async function cancelRun(runId: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/commands/run/${encodeURIComponent(runId)}/cancel`, {
      method: 'POST',
    });
    return res.ok;
  } catch {
    return false;
  }
}
