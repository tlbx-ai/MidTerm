/**
 * Cursor Visibility Helpers
 *
 * Tracks and optionally suppresses DECTCEM cursor visibility control sequences.
 */

export interface CursorVisibilityControlResult {
  data: Uint8Array;
  remoteCursorVisible: boolean | null;
  hadCursorVisibilityControl: boolean;
}

interface CursorVisibilityMatch {
  visible: boolean;
  endExclusive: number;
}

function isCursorVisibilityFinalByte(value: number | undefined): value is 0x68 | 0x6c {
  return value === 0x68 || value === 0x6c;
}

function matchCursorVisibilitySequence(
  data: Uint8Array,
  index: number,
  prefix: readonly number[],
): CursorVisibilityMatch | null {
  const finalIndex = index + prefix.length;
  if (finalIndex >= data.length) {
    return null;
  }

  for (let offset = 0; offset < prefix.length; offset += 1) {
    if (data[index + offset] !== prefix[offset]) {
      return null;
    }
  }

  const final = data[finalIndex];
  if (!isCursorVisibilityFinalByte(final)) {
    return null;
  }

  return {
    visible: final === 0x68,
    endExclusive: finalIndex + 1,
  };
}

function tryMatchCursorVisibilityControl(
  data: Uint8Array,
  index: number,
): CursorVisibilityMatch | null {
  const prefixes = [
    [0x1b, 0x5b, 0x3f, 0x32, 0x35],
    [0x9b, 0x3f, 0x32, 0x35],
    [0xc2, 0x9b, 0x3f, 0x32, 0x35],
  ] as const;

  for (const prefix of prefixes) {
    const match = matchCursorVisibilitySequence(data, index, prefix);
    if (match) {
      return match;
    }
  }

  return null;
}

export function processCursorVisibilityControls(
  data: Uint8Array,
  suppress: boolean,
): CursorVisibilityControlResult {
  let remoteCursorVisible: boolean | null = null;
  let hadCursorVisibilityControl = false;
  let filtered: number[] | null = null;
  let copyStart = 0;

  for (let i = 0; i < data.length; i++) {
    const match = tryMatchCursorVisibilityControl(data, i);
    if (match === null) {
      continue;
    }

    hadCursorVisibilityControl = true;
    remoteCursorVisible = match.visible;

    if (suppress) {
      filtered ??= [];
      for (let j = copyStart; j < i; j++) {
        filtered.push(data[j] as number);
      }
      copyStart = match.endExclusive;
    }

    i = match.endExclusive - 1;
  }

  if (!suppress || !hadCursorVisibilityControl || filtered === null) {
    return {
      data: data,
      remoteCursorVisible: remoteCursorVisible,
      hadCursorVisibilityControl: hadCursorVisibilityControl,
    };
  }

  for (let i = copyStart; i < data.length; i++) {
    filtered.push(data[i] as number);
  }

  return {
    data: Uint8Array.from(filtered),
    remoteCursorVisible: remoteCursorVisible,
    hadCursorVisibilityControl: true,
  };
}
