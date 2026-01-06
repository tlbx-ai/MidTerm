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

/**
 * Parse compressed output frame and decompress.
 * Frame format: [cols:2][rows:2][uncompressedLen:4][gzip-data...]
 */
export async function parseCompressedOutputFrame(payload: Uint8Array): Promise<OutputFrame> {
  const cols = (payload[0] ?? 0) | ((payload[1] ?? 0) << 8);
  const rows = (payload[2] ?? 0) | ((payload[3] ?? 0) << 8);
  const valid = cols > 0 && cols <= MAX_FRAME_DIMENSION && rows > 0 && rows <= MAX_FRAME_DIMENSION;

  // Skip uncompressedLen (bytes 4-7) - we don't need it, DecompressionStream handles sizing
  const compressedData = payload.slice(8);

  try {
    const data = await decompressGzip(compressedData);
    return { cols, rows, data, valid };
  } catch (e) {
    console.error('Decompression failed:', e);
    return { cols, rows, data: new Uint8Array(0), valid: false };
  }
}

/**
 * Decompress GZip data using native DecompressionStream API.
 */
export async function decompressGzip(compressed: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await writer.write(compressed as any);
  await writer.close();

  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  // Concatenate chunks into single array
  const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}
