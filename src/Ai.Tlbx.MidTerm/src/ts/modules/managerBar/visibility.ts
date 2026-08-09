export function shouldShowManagerBar(
  enabled: boolean | null | undefined,
  activeSessionId: string | null | undefined,
  hasQueuedItems = false,
): boolean {
  return (
    (enabled === true || hasQueuedItems) &&
    typeof activeSessionId === 'string' &&
    activeSessionId.length > 0
  );
}
