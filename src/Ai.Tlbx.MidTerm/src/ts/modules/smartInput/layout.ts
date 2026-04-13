export type AdaptiveFooterRailKey = 'primary' | 'automation' | 'context' | 'status';

export interface AdaptiveFooterRailSequenceState {
  lensActive: boolean;
  isMobile: boolean;
}

export interface AdaptiveFooterReserveHeightArgs {
  dockHeight: number;
  textareaHeight?: number | null;
  collapsedTextareaHeight?: number | null;
}

export const ADAPTIVE_FOOTER_RESERVED_HEIGHT_CHANGED_EVENT =
  'midterm:adaptive-footer-reserved-height-changed';

export function getAdaptiveFooterRailSequence(
  state: AdaptiveFooterRailSequenceState,
): AdaptiveFooterRailKey[] {
  void state;
  return ['primary', 'context', 'automation', 'status'];
}

export function calculateAdaptiveFooterReservedHeight(
  args: AdaptiveFooterReserveHeightArgs,
): number {
  const dockHeight = Number.isFinite(args.dockHeight) ? Math.max(0, args.dockHeight) : 0;
  if (dockHeight <= 0) {
    return 0;
  }

  const textareaHeight = Number.isFinite(args.textareaHeight ?? Number.NaN)
    ? Math.max(0, args.textareaHeight ?? 0)
    : 0;
  const collapsedTextareaHeight = Number.isFinite(args.collapsedTextareaHeight ?? Number.NaN)
    ? Math.max(0, args.collapsedTextareaHeight ?? 0)
    : 0;
  const expandedDelta = Math.max(0, textareaHeight - collapsedTextareaHeight);

  return Math.max(0, dockHeight - expandedDelta);
}
