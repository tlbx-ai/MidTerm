import type { MidTermSettingsPublic } from '../../types';

export function shouldUseWebglRenderer(
  settings: MidTermSettingsPublic | null | undefined,
): boolean {
  return settings?.useWebGL !== false;
}
