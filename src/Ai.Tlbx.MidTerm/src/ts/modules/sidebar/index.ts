/**
 * Sidebar Module
 *
 * Re-exports sidebar functionality including session list
 * rendering and sidebar collapse/expand behavior.
 */

export * from './sessionList';
export * from './collapse';
export * from './shareAccess';
export * from './networkSection';
export * from './voiceSection';
export * from './sidebarUpdater';
export * from './sessionDrag';
export { initTrafficIndicator } from './trafficIndicator';
export { initHeatIndicator, recordBytes, suppressHeat } from './heatIndicator';
