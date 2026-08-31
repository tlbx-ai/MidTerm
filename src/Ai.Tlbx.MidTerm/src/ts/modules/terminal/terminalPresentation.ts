import type { TerminalState } from '../../types';

export type TerminalPresentationRole = 'owner' | 'follower';
export type TerminalPresentationActionState = 'idle' | 'claiming';

/**
 * One immutable, browser-local view of a terminal's authoritative size state.
 * Rendering code may only publish a complete snapshot, never individual fields.
 */
export interface TerminalPresentationSnapshot {
  readonly sessionId: string;
  readonly epoch: number;
  readonly role: TerminalPresentationRole;
  readonly ownerOnline: boolean;
  readonly ownerLabel: string | null;
  readonly canonicalCols: number;
  readonly canonicalRows: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly passiveScale: number;
  readonly actionState: TerminalPresentationActionState;
}

export function createTerminalPresentationSnapshot(
  values: TerminalPresentationSnapshot,
): TerminalPresentationSnapshot {
  return Object.freeze({ ...values });
}

const committedSnapshots = new WeakMap<TerminalState, TerminalPresentationSnapshot>();
const actionStates = new WeakMap<TerminalState, TerminalPresentationActionState>();
const pendingFrames = new WeakMap<TerminalState, number>();
const generations = new WeakMap<TerminalState, number>();

export function getCommittedTerminalPresentation(
  state: TerminalState,
): TerminalPresentationSnapshot | undefined {
  return committedSnapshots.get(state);
}

export function commitTerminalPresentation(
  state: TerminalState,
  snapshot: TerminalPresentationSnapshot,
): void {
  committedSnapshots.set(state, snapshot);
}

export function getTerminalPresentationActionState(
  state: TerminalState,
): TerminalPresentationActionState {
  return actionStates.get(state) ?? 'idle';
}

export function setTerminalPresentationActionState(
  state: TerminalState,
  actionState: TerminalPresentationActionState,
): void {
  actionStates.set(state, actionState);
}

export function scheduleTerminalPresentationFrame(state: TerminalState, render: () => void): void {
  if (pendingFrames.has(state)) return;
  const generation = generations.get(state) ?? 0;
  pendingFrames.set(state, -1);
  const frameId = requestAnimationFrame(() => {
    if ((generations.get(state) ?? 0) !== generation) return;
    pendingFrames.delete(state);
    render();
  });
  if (pendingFrames.get(state) === -1) pendingFrames.set(state, frameId);
}

export function disposeTerminalPresentation(state: TerminalState): void {
  const pendingFrame = pendingFrames.get(state);
  if (
    pendingFrame !== undefined &&
    pendingFrame >= 0 &&
    typeof cancelAnimationFrame === 'function'
  ) {
    cancelAnimationFrame(pendingFrame);
  }
  generations.set(state, (generations.get(state) ?? 0) + 1);
  pendingFrames.delete(state);
  committedSnapshots.delete(state);
  actionStates.delete(state);
}

/**
 * Reject stale ownership responses before they can repaint the terminal. A
 * same-epoch update may refine presentation details, but ownership identity is
 * immutable inside an epoch.
 */
export function reduceTerminalPresentationSnapshot(
  committed: TerminalPresentationSnapshot | undefined,
  proposed: TerminalPresentationSnapshot,
): TerminalPresentationSnapshot {
  if (!committed || committed.sessionId !== proposed.sessionId) {
    return proposed;
  }

  if (proposed.epoch < committed.epoch) {
    return committed;
  }

  if (proposed.epoch === committed.epoch && proposed.role !== committed.role) {
    return committed;
  }

  return proposed;
}
