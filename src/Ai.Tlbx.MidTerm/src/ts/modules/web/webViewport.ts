import { $webPreviewViewport } from '../../stores';

/**
 * Apply the stored responsive viewport to a preview frame.
 * Navigation and target changes recreate frames, so the fixed-size styling
 * must be derived from the store instead of living only on the old element.
 */
export function applyStoredViewportToFrame(frame: HTMLIFrameElement): void {
  const viewport = $webPreviewViewport.get();
  if (!viewport) {
    frame.style.width = '';
    frame.style.height = '';
    frame.style.maxWidth = '';
    frame.style.maxHeight = '';
    frame.style.left = '';
    frame.style.top = '';
    frame.style.transform = '';
    return;
  }

  frame.style.width = `${viewport.width}px`;
  frame.style.height = `${viewport.height}px`;
  frame.style.maxWidth = `${viewport.width}px`;
  frame.style.maxHeight = `${viewport.height}px`;
  frame.style.left = '50%';
  frame.style.top = '50%';
  frame.style.transform = 'translate(-50%, -50%)';
}
