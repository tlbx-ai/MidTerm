/**
 * Commands API
 *
 * REST wrappers for script CRUD and execution via hidden mthost sessions.
 */

export interface ScriptDefinition {
  filename: string;
  name: string;
  extension: string;
  shellType: string;
  content: string;
}

export interface ScriptListResponse {
  scriptsDirectory: string;
  scripts: ScriptDefinition[];
}

export interface RunScriptResponse {
  hiddenSessionId: string;
}

export async function fetchScripts(sessionId: string): Promise<ScriptListResponse | null> {
  try {
    const res = await fetch(`/api/commands?sessionId=${encodeURIComponent(sessionId)}`);
    if (!res.ok) return null;
    return (await res.json()) as ScriptListResponse;
  } catch {
    return null;
  }
}

export async function createScript(
  sessionId: string,
  name: string,
  extension: string,
  content: string,
): Promise<ScriptDefinition | null> {
  try {
    const res = await fetch('/api/commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, name, extension, content }),
    });
    if (!res.ok) return null;
    return (await res.json()) as ScriptDefinition;
  } catch {
    return null;
  }
}

export async function updateScript(
  filename: string,
  sessionId: string,
  content: string,
): Promise<ScriptDefinition | null> {
  try {
    const res = await fetch(`/api/commands/${encodeURIComponent(filename)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, content }),
    });
    if (!res.ok) return null;
    return (await res.json()) as ScriptDefinition;
  } catch {
    return null;
  }
}

export async function deleteScript(filename: string, sessionId: string): Promise<boolean> {
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

export async function runScript(
  sessionId: string,
  filename: string,
): Promise<RunScriptResponse | null> {
  try {
    const res = await fetch('/api/commands/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, filename }),
    });
    if (!res.ok) return null;
    return (await res.json()) as RunScriptResponse;
  } catch {
    return null;
  }
}
