/**
 * Protocol Utilities
 *
 * Binary protocol helpers for mux WebSocket communication.
 */

import { MAX_FRAME_DIMENSION } from '../constants';

/** Parsed output frame from server */
export interface OutputFrame {
  cols: number;
  rows: number;
  data: Uint8Array;
  valid: boolean;
}

/**
 * Parse output frame from binary payload.
 * Frame format: [cols:2][rows:2][data]
 */
export function parseOutputFrame(payload: Uint8Array): OutputFrame {
  const cols = (payload[0] ?? 0) | ((payload[1] ?? 0) << 8);
  const rows = (payload[2] ?? 0) | ((payload[3] ?? 0) << 8);
  const data = payload.slice(4);
  const valid = cols > 0 && cols <= MAX_FRAME_DIMENSION && rows > 0 && rows <= MAX_FRAME_DIMENSION;

  return { cols, rows, data, valid };
}
