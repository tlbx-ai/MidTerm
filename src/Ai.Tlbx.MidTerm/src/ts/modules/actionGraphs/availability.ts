export interface ActionGraphsAvailabilitySettings {
  actionGraphsEnabled?: boolean;
  devMode?: boolean;
}

/** Action Graphs are experimental and visible only after explicit opt-in. */
export function isActionGraphsAvailable(
  settings: ActionGraphsAvailabilitySettings | null | undefined,
): boolean {
  return settings?.actionGraphsEnabled === true;
}
