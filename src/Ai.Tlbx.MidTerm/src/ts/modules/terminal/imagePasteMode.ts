/**
 * Image Paste Mode Resolver
 *
 * Chooses the preferred image paste path for the active TUI app:
 * - native: app reads image from OS clipboard via its own shortcut
 * - path: image is uploaded and pasted as a filesystem path
 */

export type ImagePasteMode = 'native' | 'path';

export interface ImagePasteForegroundInfo {
  name: string | null;
  commandLine: string | null;
}

const NATIVE_IMAGE_APPS = ['codex', 'claude', 'gemini', 'aider', 'qwen'];

function normalize(value: string | null | undefined): string {
  return (value ?? '').toLowerCase();
}

function hasToken(value: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i');
  return pattern.test(value);
}

/**
 * Resolve the preferred image paste mode for the active foreground process.
 * Defaults to 'path' so unknown apps still get a robust image insertion path.
 */
export function resolveImagePasteMode(foreground: ImagePasteForegroundInfo): ImagePasteMode {
  const name = normalize(foreground.name);
  const commandLine = normalize(foreground.commandLine);
  const combined = `${name} ${commandLine}`.trim();

  for (const token of NATIVE_IMAGE_APPS) {
    if (hasToken(combined, token)) {
      return 'native';
    }
  }

  return 'path';
}
