import { $activeSessionId } from '../../stores';

let openGeneration = 0;

export interface FileOpenRequest {
  readonly id: number;
  readonly sessionId: string | null;
}

export function beginFileOpen(sessionId = $activeSessionId.get()): FileOpenRequest {
  return { id: ++openGeneration, sessionId };
}

export function isFileOpenCurrent(request: FileOpenRequest): boolean {
  return request.id === openGeneration && request.sessionId === $activeSessionId.get();
}

export function cancelFileOpen(): void {
  openGeneration++;
}

/** One document request retains its identity while its presentation can move. */
export class FileViewLoad {
  private readonly controller = new AbortController();

  public constructor(
    public readonly path: string,
    public readonly sessionId: string | null,
    public container: HTMLElement,
  ) {}

  public get signal(): AbortSignal {
    return this.controller.signal;
  }

  public isActive(): boolean {
    return !this.signal.aborted && this.container.isConnected;
  }

  public abort(): void {
    this.controller.abort();
  }
}
