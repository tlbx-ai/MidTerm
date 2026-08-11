import type { MidTermSettingsPublic } from '../../types';

export function shouldUseWebglRenderer(
  settings: MidTermSettingsPublic | null | undefined,
): boolean {
  if (settings?.useWebGL === false) {
    return false;
  }

  return true;
}

export function shouldOwnWebglContext(
  ownershipManaged: boolean,
  priorityKnown: boolean,
  hasPriority: boolean,
  managedContextAllowed = true,
): boolean {
  if (!managedContextAllowed) return false;
  if (!ownershipManaged) return true;
  return !priorityKnown || hasPriority;
}
