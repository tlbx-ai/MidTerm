import type { MidTermSettingsPublic } from '../../types';
import { getEffectiveTerminalCellBackgroundAlpha } from '../theming/themes';

export function shouldUseWebglRenderer(
  settings: MidTermSettingsPublic | null | undefined,
): boolean {
  if (settings?.useWebGL === false) {
    return false;
  }

  return getEffectiveTerminalCellBackgroundAlpha(settings ?? null) >= 1;
}
