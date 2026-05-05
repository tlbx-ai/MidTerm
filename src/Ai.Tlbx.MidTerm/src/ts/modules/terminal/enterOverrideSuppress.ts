const ENTER_OVERRIDE_INPUT_EVENT_SUPPRESS_MS = 250;

const lastEnterOverrideHandledAtMs = new Map<string, number>();

export function markTerminalEnterOverrideHandled(sessionId: string): void {
  lastEnterOverrideHandledAtMs.set(sessionId, performance.now());
}

export function wasTerminalEnterOverrideHandledRecently(sessionId: string): boolean {
  const handledAtMs = lastEnterOverrideHandledAtMs.get(sessionId);
  return (
    handledAtMs !== undefined &&
    performance.now() - handledAtMs <= ENTER_OVERRIDE_INPUT_EVENT_SUPPRESS_MS
  );
}

export function clearTerminalEnterOverrideHandled(sessionId: string): void {
  lastEnterOverrideHandledAtMs.delete(sessionId);
}
