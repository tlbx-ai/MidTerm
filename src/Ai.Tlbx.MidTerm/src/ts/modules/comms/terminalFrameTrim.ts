const SEQUENCE_MODULUS = 1n << 64n;
const HALF_SEQUENCE_RANGE = 1n << 63n;

export interface TerminalFrameSequence {
  kind: 'contiguous' | 'overlap' | 'duplicate' | 'gap';
  sequenceStart: bigint;
}

export function isSequenceNewer(candidate: bigint, current: bigint): boolean {
  const delta = (candidate - current + SEQUENCE_MODULUS) % SEQUENCE_MODULUS;
  return delta !== 0n && delta < HALF_SEQUENCE_RANGE;
}

export function maxSequence(current: bigint, candidate: bigint): bigint {
  return isSequenceNewer(candidate, current) ? candidate : current;
}

/**
 * Classifies a frame before any cursor is advanced. A forward gap must never be
 * handed to xterm because a partial ANSI/UTF-8 sequence can corrupt parser state.
 */
export function classifyTerminalFrameSequence(
  dataLength: number,
  sequenceEnd: bigint,
  receivedSeq: bigint,
): TerminalFrameSequence {
  const frameLength = BigInt(Math.max(0, dataLength));
  const sequenceStart = (sequenceEnd - frameLength + SEQUENCE_MODULUS) % SEQUENCE_MODULUS;

  // Zero is the bootstrap sentinel. Protocol v2 recovery-begin frames install
  // an exact start cursor before replay; accepting here preserves v1 compatibility.
  if (receivedSeq === 0n || sequenceStart === receivedSeq) {
    return { kind: 'contiguous', sequenceStart };
  }
  if (!isSequenceNewer(sequenceEnd, receivedSeq)) {
    return { kind: 'duplicate', sequenceStart };
  }
  if (isSequenceNewer(sequenceStart, receivedSeq)) {
    return { kind: 'gap', sequenceStart };
  }
  return { kind: 'overlap', sequenceStart };
}

export function trimFrameToUnseenSuffix(
  data: Uint8Array,
  sequenceEnd: bigint,
  receivedSeq: bigint,
): Uint8Array {
  if (data.length === 0 || receivedSeq === 0n) {
    return data;
  }

  if (!isSequenceNewer(sequenceEnd, receivedSeq)) {
    return new Uint8Array(0);
  }

  const frameLength = BigInt(data.length);
  const sequenceStart = (sequenceEnd - frameLength + SEQUENCE_MODULUS) % SEQUENCE_MODULUS;
  const overlapBytes = (receivedSeq - sequenceStart + SEQUENCE_MODULUS) % SEQUENCE_MODULUS;

  if (
    isSequenceNewer(receivedSeq, sequenceStart) &&
    overlapBytes > 0n &&
    overlapBytes < frameLength
  ) {
    // receivedSeq is the byte cursor already handed to xterm. Its parser owns
    // any partial ANSI or UTF-8 prefix, so the only correct continuation is the
    // exact unseen suffix. Replaying the whole frame here duplicates visible
    // text and can restart a control sequence inside xterm's pending parser state.
    return data.subarray(Number(overlapBytes));
  }

  return data;
}
