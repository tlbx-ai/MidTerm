export function shouldShowManagerBar(
  enabled: boolean | null | undefined,
  activeSessionId: string | null | undefined,
): boolean {
  return enabled === true && typeof activeSessionId === 'string' && activeSessionId.length > 0;
}
