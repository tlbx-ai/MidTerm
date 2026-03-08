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

function tryMatchCursorVisibilityControl(
  data: Uint8Array,
  index: number,
): CursorVisibilityMatch | null {
  if (
    index + 5 < data.length &&
    data[index] === 0x1b &&
    data[index + 1] === 0x5b &&
    data[index + 2] === 0x3f &&
    data[index + 3] === 0x32 &&
    data[index + 4] === 0x35
  ) {
    const final = data[index + 5];
    if (final === 0x68 || final === 0x6c) {
      return {
        visible: final === 0x68,
        endExclusive: index + 6,
      };
    }
  }

  if (
    index + 4 < data.length &&
    data[index] === 0x9b &&
    data[index + 1] === 0x3f &&
    data[index + 2] === 0x32 &&
    data[index + 3] === 0x35
  ) {
    const final = data[index + 4];
    if (final === 0x68 || final === 0x6c) {
      return {
        visible: final === 0x68,
        endExclusive: index + 5,
      };
    }
  }

  if (
    index + 5 < data.length &&
    data[index] === 0xc2 &&
    data[index + 1] === 0x9b &&
    data[index + 2] === 0x3f &&
    data[index + 3] === 0x32 &&
    data[index + 4] === 0x35
  ) {
    const final = data[index + 5];
    if (final === 0x68 || final === 0x6c) {
      return {
        visible: final === 0x68,
        endExclusive: index + 6,
      };
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
