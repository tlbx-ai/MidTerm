import { getOrCreateTabId } from '../../utils/cookies';

export interface BoardEntry {
  id: string;
  text: string;
  done: boolean;
  date?: string | null;
  year?: number | null;
  week?: number | null;
  quarter?: number | null;
  sender?: string | null;
  url?: string | null;
}

export interface BoardItem {
  id: string;
  revision: number;
  kind: 'note' | 'todo' | 'calendar' | 'mail' | 'timeline' | 'browser';
  title: string;
  text: string;
  color: string;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  entries: BoardEntry[];
  url?: string | null;
  localDirectory?: string | null;
  browserSessionId?: string | null;
  browserPreviewName?: string | null;
  workingDirectory?: string | null;
  launchCommand?: string | null;
  prompt?: string | null;
  sessionId?: string | null;
}

export interface BoardDocument {
  id: string;
  title: string;
  revision: number;
  panX: number;
  panY: number;
  zoom: number;
  items: BoardItem[];
}

export class BoardApiError extends Error {
  constructor(
    public readonly status: number,
    detail: string,
  ) {
    super(detail);
  }
}

export async function boardRequest<T>(path = '', method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api/boards${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-MidTerm-Tab-Id': getOrCreateTabId() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new BoardApiError(response.status, await response.text());
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

export function newBoardItem(kind: BoardItem['kind'], x: number, y: number): BoardItem {
  return {
    id: '',
    revision: 0,
    kind,
    title: '',
    text: '',
    color: kind === 'note' ? 'sand' : 'plain',
    x,
    y,
    width: kind === 'browser' ? 640 : 320,
    height: kind === 'browser' ? 440 : 280,
    z: 0,
    entries: [],
  };
}
