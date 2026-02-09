/**
 * Terminal Module
 *
 * Re-exports terminal management and scaling functionality.
 */

export * from './manager';
export * from './scaling';
export * from './search';
export * from './fileDrop';
export { initTouchScrolling, teardownTouchScrolling, isTouchSelecting } from './touchScrolling';
