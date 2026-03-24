import type { MidTermSettingsPublic } from '../../types';

function clampTransparency(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }

  return Math.min(100, Math.max(0, value));
}

/**
 * xterm's WebGL renderer currently forces cell background rectangles to full opacity,
 * so alpha-based terminal backgrounds render incorrectly there.
 */
export function shouldUseWebglRenderer(
  settings: MidTermSettingsPublic | null | undefined,
): boolean {
  if (settings?.useWebGL === false) {
    return false;
  }

  const terminalTransparency = clampTransparency(
    settings?.terminalTransparency ?? settings?.uiTransparency,
  );
  const hasWallpaper =
    settings?.backgroundImageEnabled === true && settings.backgroundImageFileName !== null;

  return terminalTransparency <= 0 && !hasWallpaper;
}
