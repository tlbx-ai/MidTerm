export function createAlternateScreenReplayPrefix(mode: number): string | null {
  return mode === 47 || mode === 1047 || mode === 1049 ? `\x1b[?${mode}h` : null;
}
