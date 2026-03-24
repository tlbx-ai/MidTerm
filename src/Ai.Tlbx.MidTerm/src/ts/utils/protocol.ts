/**
 * Protocol Utilities
 *
 * Binary protocol helpers for mux WebSocket communication.
 */

import { MAX_FRAME_DIMENSION } from '../constants';
import { createLogger } from '../modules/logging';

const log = createLogger('mux');

/** Parsed output frame from server */
export interface OutputFrame {
  sequenceEnd: bigint;
  cols: number;
  rows: number;
  data: Uint8Array;
  valid: boolean;
}

/**
 * Parse output frame from binary payload.
 * Frame format: [sequenceEnd:8][cols:2][rows:2][data]
 */
export function parseOutputFrame(payload: Uint8Array): OutputFrame {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const sequenceEnd = payload.length >= 8 ? view.getBigUint64(0, true) : 0n;
  const cols = (payload[8] ?? 0) | ((payload[9] ?? 0) << 8);
  const rows = (payload[10] ?? 0) | ((payload[11] ?? 0) << 8);
  // The mux layer already takes ownership of the WebSocket payload before it
  // reaches this parser, so we can return a view here instead of another copy.
  const data = payload.subarray(12);
  const valid = cols > 0 && cols <= MAX_FRAME_DIMENSION && rows > 0 && rows <= MAX_FRAME_DIMENSION;

  return { sequenceEnd, cols, rows, data, valid };
}

/**
 * Parse compressed output frame and decompress.
 * Frame format: [sequenceEnd:8][cols:2][rows:2][uncompressedLen:4][gzip-data...]
 */
export async function parseCompressedOutputFrame(payload: Uint8Array): Promise<OutputFrame> {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const sequenceEnd = payload.length >= 8 ? view.getBigUint64(0, true) : 0n;
  const cols = (payload[8] ?? 0) | ((payload[9] ?? 0) << 8);
  const rows = (payload[10] ?? 0) | ((payload[11] ?? 0) << 8);
  const valid = cols > 0 && cols <= MAX_FRAME_DIMENSION && rows > 0 && rows <= MAX_FRAME_DIMENSION;

  // Skip uncompressedLen (bytes 12-15) - we don't need it, DecompressionStream handles sizing
  const compressedData = payload.subarray(16);

  try {
    const data = await decompressGzip(compressedData);
    return { sequenceEnd, cols, rows, data, valid };
  } catch (e) {
    log.error(() => `Decompression failed: ${String(e)}`);
    return { sequenceEnd, cols, rows, data: new Uint8Array(0), valid: false };
  }
}

/**
 * Decompress GZip data using native DecompressionStream API.
 * Uses Blob/Response pipeline to avoid backpressure deadlock.
 */
export async function decompressGzip(compressed: Uint8Array): Promise<Uint8Array> {
  const blob = new Blob([compressed as BlobPart]);
  const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
