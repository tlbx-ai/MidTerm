/**
 * DOM Utilities
 *
 * Helper functions for DOM manipulation and event handling.
 */

/**
 * Escape HTML special characters to prevent XSS
 */
export function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Bind a click event to an element by ID
 */
export function bindClick(id: string, handler: (e: MouseEvent) => void): void {
  const el = document.getElementById(id);
  if (el) {
    el.addEventListener('click', handler);
  }
}

/**
 * Create a debounced version of a function
 */
export function debounce<T extends (...args: unknown[]) => void>(
  fn: T,
  delay: number,
): (...args: Parameters<T>) => void {
  let timeoutId: number | undefined;
  return (...args: Parameters<T>) => {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
    timeoutId = window.setTimeout(() => fn(...args), delay);
  };
}

/**
 * Create a throttled version of a function that fires immediately,
 * then at most once per interval, with a trailing call to capture final state.
 */
export function throttle<T extends (...args: unknown[]) => void>(
  fn: T,
  interval: number,
): (...args: Parameters<T>) => void {
  let lastCall = 0;
  let trailingTimeoutId: number | undefined;
  return (...args: Parameters<T>) => {
    const now = performance.now();
    const elapsed = now - lastCall;

    if (trailingTimeoutId !== undefined) {
      clearTimeout(trailingTimeoutId);
    }

    if (elapsed >= interval) {
      lastCall = now;
      fn(...args);
    }

    trailingTimeoutId = window.setTimeout(() => {
      lastCall = performance.now();
      fn(...args);
    }, interval);
  };
}

/**
 * Format bytes as human-readable string
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
