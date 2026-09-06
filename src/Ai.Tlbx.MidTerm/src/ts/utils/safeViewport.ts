/** Bounds shared by floating controls and the inset-aware application shell. */
export function getSafeViewportBounds(): {
  top: number;
  right: number;
  bottom: number;
  left: number;
} {
  const viewport = window.visualViewport;
  const top = viewport?.offsetTop ?? 0;
  const left = viewport?.offsetLeft ?? 0;
  const style = getComputedStyle(document.documentElement);
  const inset = (side: string): number =>
    Math.max(0, Number.parseFloat(style.getPropertyValue(`--safe-area-inset-${side}`)) || 0);
  return {
    top: top + inset('top'),
    right: left + (viewport?.width ?? window.innerWidth) - inset('right'),
    bottom: top + (viewport?.height ?? window.innerHeight) - inset('bottom'),
    left: left + inset('left'),
  };
}
