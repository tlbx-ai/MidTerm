export interface InteractionRenderHost {
  requestAnimationFrame(callback: FrameRequestCallback): number;
  cancelAnimationFrame(handle: number): void;
  setTimeout(callback: () => void, delay: number): number;
  clearTimeout(handle: number): void;
}

export interface InteractionRenderScheduler {
  schedule(): void;
  finish(): void;
  cancel(): void;
}

const DEFAULT_SETTLE_MS = 84;

/**
 * Keeps gesture frames compositor-only. Expensive DOM reconciliation happens
 * once after input settles; viewport overscan covers the short culling delay.
 */
export function createInteractionRenderScheduler(
  host: InteractionRenderHost,
  commitTransform: () => void,
  reconcileViewport: () => void,
  settleMs = DEFAULT_SETTLE_MS,
): InteractionRenderScheduler {
  let transformFrame: number | null = null;
  let settleTimer: number | null = null;

  const cancel = (): void => {
    if (transformFrame !== null) {
      host.cancelAnimationFrame(transformFrame);
      transformFrame = null;
    }
    if (settleTimer !== null) {
      host.clearTimeout(settleTimer);
      settleTimer = null;
    }
  };

  const finish = (): void => {
    cancel();
    commitTransform();
    reconcileViewport();
  };

  const schedule = (): void => {
    if (transformFrame === null) {
      transformFrame = host.requestAnimationFrame(() => {
        transformFrame = null;
        commitTransform();
      });
    }
    if (settleTimer !== null) host.clearTimeout(settleTimer);
    settleTimer = host.setTimeout(() => {
      settleTimer = null;
      commitTransform();
      reconcileViewport();
    }, settleMs);
  };

  return { schedule, finish, cancel };
}
