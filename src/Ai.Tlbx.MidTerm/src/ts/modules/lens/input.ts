import { interruptLensTurn, sendLensTurn } from '../../api/client';
import type {
  LensAttachmentReference,
  LensInterruptRequest,
  LensTurnRequest,
  LensTurnStartResponse,
} from '../../api/types';
import { $sessions } from '../../stores';
import { getActiveTab } from '../sessionTabs';
import { acceptLensQuickSettings, createLensTurnRequestWithQuickSettings } from './quickSettings';

export const LENS_TURN_SUBMITTED_EVENT = 'midterm:lens-turn-submitted';
export const LENS_TURN_ACCEPTED_EVENT = 'midterm:lens-turn-accepted';
export const LENS_TURN_FAILED_EVENT = 'midterm:lens-turn-failed';

export interface LensTurnSubmittedEventDetail {
  optimisticId: string;
  sessionId: string;
  request: LensTurnRequest;
}

export interface LensTurnAcceptedEventDetail extends LensTurnSubmittedEventDetail {
  response: LensTurnStartResponse;
}

export interface LensTurnFailedEventDetail extends LensTurnSubmittedEventDetail {
  errorMessage: string;
}

export interface LensTurnExecutionSummary {
  turnId?: string | null;
  state?: string | null;
}

type LensTurnLifecycleEventDetail =
  | LensTurnSubmittedEventDetail
  | LensTurnAcceptedEventDetail
  | LensTurnFailedEventDetail;

interface QueuedLensTurn {
  optimisticId: string;
  request: LensTurnRequest;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface LensTurnQueueState {
  currentTurnId: string | null;
  currentTurnRunning: boolean;
  queuedTurns: QueuedLensTurn[];
  submittingTurn: boolean;
  pendingInterruptAfterSubmit: boolean;
  interruptInFlight: boolean;
  queueDrainActive: boolean;
  interruptingForQueuedTurns: boolean;
  haltQueuedTurns: boolean;
  activeQueuedTurnId: string | null;
}

const lensTurnQueueStates = new Map<string, LensTurnQueueState>();

export function isLensActiveSession(sessionId: string | null | undefined): boolean {
  if (!sessionId) {
    return false;
  }

  const session = $sessions.get()[sessionId];
  return session?.lensOnly === true && getActiveTab(sessionId) === 'agent';
}

export function createLensTurnRequest(
  text: string,
  attachments: LensAttachmentReference[] = [],
  sessionId?: string,
): LensTurnRequest {
  if (sessionId) {
    return createLensTurnRequestWithQuickSettings(sessionId, text, attachments);
  }

  return {
    text,
    model: null,
    effort: null,
    planMode: 'off',
    permissionMode: 'manual',
    attachments,
  };
}

export async function submitLensTurn(
  sessionId: string,
  request: LensTurnRequest,
): Promise<LensTurnStartResponse> {
  const normalizedRequest = normalizeLensTurnRequest(request);
  const optimisticId = dispatchSubmittedLensTurn(sessionId, normalizedRequest);
  const state = getOrCreateLensTurnQueueState(sessionId);
  state.submittingTurn = true;

  try {
    const response = await sendLensTurnWithLifecycle(sessionId, optimisticId, normalizedRequest);
    state.currentTurnId = response.turnId ?? state.currentTurnId;
    state.currentTurnRunning = true;
    await maybeInterruptLensTurnAfterSubmit(sessionId, state);
    return response;
  } catch (error) {
    state.pendingInterruptAfterSubmit = false;
    throw error;
  } finally {
    state.submittingTurn = false;
  }
}

export function submitQueuedLensTurn(sessionId: string, request: LensTurnRequest): Promise<void> {
  const normalizedRequest = normalizeLensTurnRequest(request);
  const optimisticId = dispatchSubmittedLensTurn(sessionId, normalizedRequest);
  const state = getOrCreateLensTurnQueueState(sessionId);

  return new Promise<void>((resolve, reject) => {
    const queuedTurn: QueuedLensTurn = {
      optimisticId,
      request: normalizedRequest,
      resolve,
      reject: (error: Error) => {
        reject(error);
      },
    };

    if (shouldQueueLensTurn(state)) {
      state.queuedTurns.push(queuedTurn);
      return;
    }

    void startQueuedLensTurn(sessionId, state, queuedTurn, false);
  });
}

export async function handleLensEscape(sessionId: string): Promise<boolean> {
  const state = getOrCreateLensTurnQueueState(sessionId);
  const { hasQueuedWork, hasSubmittingTurn } = getLensEscapeWorkState(state);

  if (!state.currentTurnRunning && !hasQueuedWork && !hasSubmittingTurn) {
    return false;
  }

  if (hasQueuedWork && (state.interruptingForQueuedTurns || state.queueDrainActive)) {
    state.haltQueuedTurns = true;
    state.interruptingForQueuedTurns = false;
    cancelQueuedLensTurns(state, sessionId, 'Canceled queued Lens turn.');

    if (state.currentTurnRunning) {
      return requestLensTurnInterrupt(sessionId, state);
    }

    if (hasSubmittingTurn) {
      state.pendingInterruptAfterSubmit = true;
      return true;
    }

    resetQueuedDrainState(state);
    return true;
  }

  if (state.queuedTurns.length > 0) {
    state.interruptingForQueuedTurns = true;
  }

  if (state.currentTurnRunning) {
    return requestLensTurnInterrupt(sessionId, state);
  }

  if (hasSubmittingTurn) {
    state.pendingInterruptAfterSubmit = true;
    return true;
  }

  maybeDrainQueuedLensTurns(sessionId, state);
  return true;
}

export function hasInterruptibleLensTurnWork(sessionId: string): boolean {
  const state = getOrCreateLensTurnQueueState(sessionId);
  const { hasQueuedWork, hasSubmittingTurn } = getLensEscapeWorkState(state);
  return state.currentTurnRunning || hasQueuedWork || hasSubmittingTurn;
}

export function syncLensTurnExecutionState(
  sessionId: string,
  currentTurn: LensTurnExecutionSummary | null | undefined,
): void {
  const state = getOrCreateLensTurnQueueState(sessionId);
  state.currentTurnId = currentTurn?.turnId?.trim() || null;
  state.currentTurnRunning = isRunningLensTurnState(currentTurn?.state);

  if (state.currentTurnRunning) {
    if (state.queueDrainActive && !state.activeQueuedTurnId && state.currentTurnId) {
      state.activeQueuedTurnId = state.currentTurnId;
    }
    return;
  }

  state.interruptInFlight = false;

  if (state.activeQueuedTurnId && state.currentTurnId !== state.activeQueuedTurnId) {
    state.activeQueuedTurnId = null;
  }

  if (state.haltQueuedTurns) {
    cancelQueuedLensTurns(state, sessionId, 'Canceled queued Lens turn.');
    resetQueuedDrainState(state);
    return;
  }

  if (state.queuedTurns.length > 0) {
    maybeDrainQueuedLensTurns(sessionId, state);
    return;
  }

  if (!state.activeQueuedTurnId) {
    resetQueuedDrainState(state);
  }
}

export function clearLensTurnSessionState(sessionId: string): void {
  const state = lensTurnQueueStates.get(sessionId);
  if (!state) {
    return;
  }

  cancelQueuedLensTurns(state, sessionId, 'Lens session closed.');
  lensTurnQueueStates.delete(sessionId);
}

function dispatchLensTurnEvent(name: string, detail: LensTurnLifecycleEventDetail): void {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') {
    return;
  }

  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function createOptimisticTurnId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `optimistic-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeLensTurnRequest(request: LensTurnRequest): LensTurnRequest {
  return {
    ...(request.text === undefined ? {} : { text: request.text }),
    ...(request.model === undefined ? {} : { model: request.model ?? null }),
    ...(request.effort === undefined ? {} : { effort: request.effort ?? null }),
    ...(request.planMode === undefined ? {} : { planMode: request.planMode ?? 'off' }),
    ...(request.permissionMode === undefined
      ? {}
      : { permissionMode: request.permissionMode ?? 'manual' }),
    attachments: request.attachments.map((attachment) => ({ ...attachment })),
  };
}

function dispatchSubmittedLensTurn(sessionId: string, request: LensTurnRequest): string {
  const optimisticId = createOptimisticTurnId();
  dispatchLensTurnEvent(LENS_TURN_SUBMITTED_EVENT, {
    optimisticId,
    sessionId,
    request,
  });
  return optimisticId;
}

async function sendLensTurnWithLifecycle(
  sessionId: string,
  optimisticId: string,
  request: LensTurnRequest,
): Promise<LensTurnStartResponse> {
  try {
    const response = await sendLensTurn(sessionId, request);
    acceptLensQuickSettings(sessionId, response.provider, response.quickSettings);
    dispatchLensTurnEvent(LENS_TURN_ACCEPTED_EVENT, {
      optimisticId,
      sessionId,
      request,
      response,
    });
    return response;
  } catch (error) {
    dispatchLensTurnEvent(LENS_TURN_FAILED_EVENT, {
      optimisticId,
      sessionId,
      request,
      errorMessage: String(error),
    });
    throw error;
  }
}

function getOrCreateLensTurnQueueState(sessionId: string): LensTurnQueueState {
  const existing = lensTurnQueueStates.get(sessionId);
  if (existing) {
    return existing;
  }

  const created: LensTurnQueueState = {
    currentTurnId: null,
    currentTurnRunning: false,
    queuedTurns: [],
    submittingTurn: false,
    pendingInterruptAfterSubmit: false,
    interruptInFlight: false,
    queueDrainActive: false,
    interruptingForQueuedTurns: false,
    haltQueuedTurns: false,
    activeQueuedTurnId: null,
  };
  lensTurnQueueStates.set(sessionId, created);
  return created;
}

function getLensEscapeWorkState(state: LensTurnQueueState): {
  hasQueuedWork: boolean;
  hasSubmittingTurn: boolean;
} {
  return {
    hasQueuedWork:
      state.queuedTurns.length > 0 ||
      state.queueDrainActive ||
      state.interruptingForQueuedTurns ||
      Boolean(state.activeQueuedTurnId),
    hasSubmittingTurn: state.submittingTurn && !state.currentTurnRunning,
  };
}

function shouldQueueLensTurn(state: LensTurnQueueState): boolean {
  return state.currentTurnRunning || state.submittingTurn || state.queuedTurns.length > 0;
}

async function startQueuedLensTurn(
  sessionId: string,
  state: LensTurnQueueState,
  queuedTurn: QueuedLensTurn,
  fromQueue: boolean,
): Promise<void> {
  state.submittingTurn = true;
  if (fromQueue) {
    state.queueDrainActive = true;
    state.activeQueuedTurnId = queuedTurn.optimisticId;
  }

  try {
    const response = await sendLensTurnWithLifecycle(
      sessionId,
      queuedTurn.optimisticId,
      queuedTurn.request,
    );
    state.currentTurnId = response.turnId ?? state.currentTurnId;
    state.currentTurnRunning = true;
    if (fromQueue) {
      state.activeQueuedTurnId = response.turnId ?? queuedTurn.optimisticId;
    }
    await maybeInterruptLensTurnAfterSubmit(sessionId, state);
    queuedTurn.resolve();
  } catch (error) {
    state.pendingInterruptAfterSubmit = false;
    const normalized = error instanceof Error ? error : new Error(String(error));
    queuedTurn.reject(normalized);
    if (fromQueue && !state.haltQueuedTurns) {
      maybeDrainQueuedLensTurns(sessionId, state);
    }
  } finally {
    state.submittingTurn = false;
  }
}

function maybeDrainQueuedLensTurns(sessionId: string, state: LensTurnQueueState): void {
  if (state.submittingTurn || state.currentTurnRunning) {
    return;
  }

  if (state.haltQueuedTurns) {
    cancelQueuedLensTurns(state, sessionId, 'Canceled queued Lens turn.');
    resetQueuedDrainState(state);
    return;
  }

  const nextTurn = state.queuedTurns.shift();
  if (!nextTurn) {
    if (!state.activeQueuedTurnId) {
      resetQueuedDrainState(state);
    }
    return;
  }

  state.queueDrainActive = true;
  state.interruptingForQueuedTurns = false;
  void startQueuedLensTurn(sessionId, state, nextTurn, true);
}

function cancelQueuedLensTurns(
  state: LensTurnQueueState,
  sessionId: string,
  errorMessage: string,
): void {
  const canceledTurns = state.queuedTurns.splice(0, state.queuedTurns.length);
  for (const turn of canceledTurns) {
    dispatchLensTurnEvent(LENS_TURN_FAILED_EVENT, {
      optimisticId: turn.optimisticId,
      sessionId,
      request: turn.request,
      errorMessage,
    });
    queueMicrotask(() => {
      turn.resolve();
    });
  }
}

function resetQueuedDrainState(state: LensTurnQueueState): void {
  state.queueDrainActive = false;
  state.interruptingForQueuedTurns = false;
  state.haltQueuedTurns = false;
  state.activeQueuedTurnId = null;
}

async function requestLensTurnInterrupt(
  sessionId: string,
  state: LensTurnQueueState,
): Promise<boolean> {
  if (state.interruptInFlight) {
    return true;
  }

  state.interruptInFlight = true;
  const request: LensInterruptRequest = state.currentTurnId ? { turnId: state.currentTurnId } : {};

  try {
    await interruptLensTurn(sessionId, request);
    return true;
  } catch {
    state.interruptInFlight = false;
    return false;
  }
}

async function maybeInterruptLensTurnAfterSubmit(
  sessionId: string,
  state: LensTurnQueueState,
): Promise<void> {
  if (!state.pendingInterruptAfterSubmit) {
    return;
  }

  state.pendingInterruptAfterSubmit = false;
  await requestLensTurnInterrupt(sessionId, state);
}

function isRunningLensTurnState(state: string | null | undefined): boolean {
  const normalized = (state || '').trim().toLowerCase();
  return normalized === 'running' || normalized === 'in_progress' || normalized === 'submitted';
}
