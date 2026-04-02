import type { MidTermSettingsPublic } from '../../types';
import { getEffectiveTerminalBackgroundAlpha } from '../theming/themes';

export function shouldUseWebglRenderer(
  settings: MidTermSettingsPublic | null | undefined,
): boolean {
  if (settings?.useWebGL === false) {
    return false;
  }

  return getEffectiveTerminalBackgroundAlpha(settings ?? null) >= 1;
}
