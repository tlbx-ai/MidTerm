/**
 * Diagnostics Module
 *
 * Provides log viewing UI for frontend and backend logs.
 */

export { initDiagnosticsPanel, stopDiagnosticsRefresh } from './panel';
export { connectLogsWebSocket, disconnectLogsWebSocket, isConnected } from './logsChannel';
