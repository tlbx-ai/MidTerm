export function runWithGuaranteedTerminalReplay(
  initializeOptionalFeatures: () => void,
  replayBufferedOutput: () => void,
  reportInitializationError: (error: unknown) => void,
): void {
  try {
    initializeOptionalFeatures();
  } catch (error) {
    reportInitializationError(error);
  } finally {
    replayBufferedOutput();
  }
}

export function shouldRequestInitialTerminalReplay(renderedSequence: bigint | null): boolean {
  return renderedSequence === null || renderedSequence === 0n;
}
