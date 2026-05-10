import { interruptAppServerControlTurn, sendAppServerControlTurn } from '../../api/client';
import type {
  AppServerControlAttachmentReference,
  AppServerControlInterruptRequest,
  AppServerControlTurnRequest,
  AppServerControlTurnStartResponse,
} from '../../api/types';
import { $sessions } from '../../stores';
import { getActiveTab } from '../sessionTabs';
import {
  acceptAppServerControlQuickSettings,
  createAppServerControlTurnRequestWithQuickSettings,
} from './quickSettings';

export const APP_SERVER_CONTROL_TURN_SUBMITTED_EVENT = 'midterm:appServerControl-turn-submitted';
export const APP_SERVER_CONTROL_TURN_ACCEPTED_EVENT = 'midterm:appServerControl-turn-accepted';
export const APP_SERVER_CONTROL_TURN_FAILED_EVENT = 'midterm:appServerControl-turn-failed';

export interface AppServerControlTurnSubmittedEventDetail {
  optimisticId: string;
  sessionId: string;
  request: AppServerControlTurnRequest;
}

export interface AppServerControlTurnAcceptedEventDetail extends AppServerControlTurnSubmittedEventDetail {
  response: AppServerControlTurnStartResponse;
}

export interface AppServerControlTurnFailedEventDetail extends AppServerControlTurnSubmittedEventDetail {
  errorMessage: string;
}

export interface AppServerControlTurnExecutionSummary {
  turnId?: string | null;
  state?: string | null;
}

type AppServerControlTurnLifecycleEventDetail =
  | AppServerControlTurnSubmittedEventDetail
  | AppServerControlTurnAcceptedEventDetail
  | AppServerControlTurnFailedEventDetail;

interface QueuedAppServerControlTurn {
  optimisticId: string;
  request: AppServerControlTurnRequest;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface AppServerControlTurnQueueState {
  currentTurnId: string | null;
  currentTurnRunning: boolean;
  queuedTurns: QueuedAppServerControlTurn[];
  submittingTurn: boolean;
  pendingInterruptAfterSubmit: boolean;
  interruptInFlight: boolean;
  queueDrainActive: boolean;
  interruptingForQueuedTurns: boolean;
  haltQueuedTurns: boolean;
  activeQueuedTurnId: string | null;
}

const appServerControlTurnQueueStates = new Map<string, AppServerControlTurnQueueState>();

export function isAppServerControlActiveSession(sessionId: string | null | undefined): boolean {
  if (!sessionId) {
    return false;
  }

  const session = $sessions.get()[sessionId];
  return session?.appServerControlOnly === true && getActiveTab(sessionId) === 'agent';
}

export function createAppServerControlTurnRequest(
  text: string,
  attachments: AppServerControlAttachmentReference[] = [],
  sessionId?: string,
): AppServerControlTurnRequest {
  if (sessionId) {
    return createAppServerControlTurnRequestWithQuickSettings(sessionId, text, attachments);
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

export async function submitAppServerControlTurn(
  sessionId: string,
  request: AppServerControlTurnRequest,
): Promise<AppServerControlTurnStartResponse> {
  const normalizedRequest = normalizeAppServerControlTurnRequest(request);
  const optimisticId = dispatchSubmittedAppServerControlTurn(sessionId, normalizedRequest);
  const state = getOrCreateAppServerControlTurnQueueState(sessionId);
  state.submittingTurn = true;

  try {
    const response = await sendAppServerControlTurnWithLifecycle(
      sessionId,
      optimisticId,
      normalizedRequest,
    );
    state.currentTurnId = response.turnId ?? state.currentTurnId;
    state.currentTurnRunning = true;
    await maybeInterruptAppServerControlTurnAfterSubmit(sessionId, state);
    return response;
  } catch (error) {
    state.pendingInterruptAfterSubmit = false;
    throw error;
  } finally {
    state.submittingTurn = false;
  }
}

export function submitQueuedAppServerControlTurn(
  sessionId: string,
  request: AppServerControlTurnRequest,
): Promise<void> {
  const normalizedRequest = normalizeAppServerControlTurnRequest(request);
  const optimisticId = dispatchSubmittedAppServerControlTurn(sessionId, normalizedRequest);
  const state = getOrCreateAppServerControlTurnQueueState(sessionId);

  return new Promise<void>((resolve, reject) => {
    const queuedTurn: QueuedAppServerControlTurn = {
      optimisticId,
      request: normalizedRequest,
      resolve,
      reject: (error: Error) => {
        reject(error);
      },
    };

    if (shouldQueueAppServerControlTurn(state)) {
      state.queuedTurns.push(queuedTurn);
      return;
    }

    void startQueuedAppServerControlTurn(sessionId, state, queuedTurn, false);
  });
}

export async function handleAppServerControlEscape(sessionId: string): Promise<boolean> {
  const state = getOrCreateAppServerControlTurnQueueState(sessionId);
  const { hasQueuedWork, hasSubmittingTurn } = getAppServerControlEscapeWorkState(state);

  if (!state.currentTurnRunning && !hasQueuedWork && !hasSubmittingTurn) {
    return false;
  }

  if (hasQueuedWork && (state.interruptingForQueuedTurns || state.queueDrainActive)) {
    state.haltQueuedTurns = true;
    state.interruptingForQueuedTurns = false;
    cancelQueuedAppServerControlTurns(state, sessionId, 'Canceled queued AppServerControl turn.');

    if (state.currentTurnRunning) {
      return requestAppServerControlTurnInterrupt(sessionId, state);
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
    return requestAppServerControlTurnInterrupt(sessionId, state);
  }

  if (hasSubmittingTurn) {
    state.pendingInterruptAfterSubmit = true;
    return true;
  }

  maybeDrainQueuedAppServerControlTurns(sessionId, state);
  return true;
}

export function hasInterruptibleAppServerControlTurnWork(sessionId: string): boolean {
  const state = getOrCreateAppServerControlTurnQueueState(sessionId);
  const { hasQueuedWork, hasSubmittingTurn } = getAppServerControlEscapeWorkState(state);
  return state.currentTurnRunning || hasQueuedWork || hasSubmittingTurn;
}

export function syncAppServerControlTurnExecutionState(
  sessionId: string,
  currentTurn: AppServerControlTurnExecutionSummary | null | undefined,
): void {
  const state = getOrCreateAppServerControlTurnQueueState(sessionId);
  state.currentTurnId = currentTurn?.turnId?.trim() || null;
  state.currentTurnRunning = isRunningAppServerControlTurnState(currentTurn?.state);

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
    cancelQueuedAppServerControlTurns(state, sessionId, 'Canceled queued AppServerControl turn.');
    resetQueuedDrainState(state);
    return;
  }

  if (state.queuedTurns.length > 0) {
    maybeDrainQueuedAppServerControlTurns(sessionId, state);
    return;
  }

  if (!state.activeQueuedTurnId) {
    resetQueuedDrainState(state);
  }
}

export function clearAppServerControlTurnSessionState(sessionId: string): void {
  const state = appServerControlTurnQueueStates.get(sessionId);
  if (!state) {
    return;
  }

  cancelQueuedAppServerControlTurns(state, sessionId, 'AppServerControl session closed.');
  appServerControlTurnQueueStates.delete(sessionId);
}

function dispatchAppServerControlTurnEvent(
  name: string,
  detail: AppServerControlTurnLifecycleEventDetail,
): void {
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

function normalizeAppServerControlTurnRequest(
  request: AppServerControlTurnRequest,
): AppServerControlTurnRequest {
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

function dispatchSubmittedAppServerControlTurn(
  sessionId: string,
  request: AppServerControlTurnRequest,
): string {
  const optimisticId = createOptimisticTurnId();
  dispatchAppServerControlTurnEvent(APP_SERVER_CONTROL_TURN_SUBMITTED_EVENT, {
    optimisticId,
    sessionId,
    request,
  });
  return optimisticId;
}

async function sendAppServerControlTurnWithLifecycle(
  sessionId: string,
  optimisticId: string,
  request: AppServerControlTurnRequest,
): Promise<AppServerControlTurnStartResponse> {
  try {
    const response = await sendAppServerControlTurn(sessionId, request);
    acceptAppServerControlQuickSettings(sessionId, response.provider, response.quickSettings);
    dispatchAppServerControlTurnEvent(APP_SERVER_CONTROL_TURN_ACCEPTED_EVENT, {
      optimisticId,
      sessionId,
      request,
      response,
    });
    return response;
  } catch (error) {
    dispatchAppServerControlTurnEvent(APP_SERVER_CONTROL_TURN_FAILED_EVENT, {
      optimisticId,
      sessionId,
      request,
      errorMessage: String(error),
    });
    throw error;
  }
}

function getOrCreateAppServerControlTurnQueueState(
  sessionId: string,
): AppServerControlTurnQueueState {
  const existing = appServerControlTurnQueueStates.get(sessionId);
  if (existing) {
    return existing;
  }

  const created: AppServerControlTurnQueueState = {
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
  appServerControlTurnQueueStates.set(sessionId, created);
  return created;
}

function getAppServerControlEscapeWorkState(state: AppServerControlTurnQueueState): {
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

function shouldQueueAppServerControlTurn(state: AppServerControlTurnQueueState): boolean {
  return state.currentTurnRunning || state.submittingTurn || state.queuedTurns.length > 0;
}

async function startQueuedAppServerControlTurn(
  sessionId: string,
  state: AppServerControlTurnQueueState,
  queuedTurn: QueuedAppServerControlTurn,
  fromQueue: boolean,
): Promise<void> {
  state.submittingTurn = true;
  if (fromQueue) {
    state.queueDrainActive = true;
    state.activeQueuedTurnId = queuedTurn.optimisticId;
  }

  try {
    const response = await sendAppServerControlTurnWithLifecycle(
      sessionId,
      queuedTurn.optimisticId,
      queuedTurn.request,
    );
    state.currentTurnId = response.turnId ?? state.currentTurnId;
    state.currentTurnRunning = true;
    if (fromQueue) {
      state.activeQueuedTurnId = response.turnId ?? queuedTurn.optimisticId;
    }
    await maybeInterruptAppServerControlTurnAfterSubmit(sessionId, state);
    queuedTurn.resolve();
  } catch (error) {
    state.pendingInterruptAfterSubmit = false;
    const normalized = error instanceof Error ? error : new Error(String(error));
    queuedTurn.reject(normalized);
    if (fromQueue && !state.haltQueuedTurns) {
      maybeDrainQueuedAppServerControlTurns(sessionId, state);
    }
  } finally {
    state.submittingTurn = false;
  }
}

function maybeDrainQueuedAppServerControlTurns(
  sessionId: string,
  state: AppServerControlTurnQueueState,
): void {
  if (state.submittingTurn || state.currentTurnRunning) {
    return;
  }

  if (state.haltQueuedTurns) {
    cancelQueuedAppServerControlTurns(state, sessionId, 'Canceled queued AppServerControl turn.');
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
  void startQueuedAppServerControlTurn(sessionId, state, nextTurn, true);
}

function cancelQueuedAppServerControlTurns(
  state: AppServerControlTurnQueueState,
  sessionId: string,
  errorMessage: string,
): void {
  const canceledTurns = state.queuedTurns.splice(0, state.queuedTurns.length);
  for (const turn of canceledTurns) {
    dispatchAppServerControlTurnEvent(APP_SERVER_CONTROL_TURN_FAILED_EVENT, {
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

function resetQueuedDrainState(state: AppServerControlTurnQueueState): void {
  state.queueDrainActive = false;
  state.interruptingForQueuedTurns = false;
  state.haltQueuedTurns = false;
  state.activeQueuedTurnId = null;
}

async function requestAppServerControlTurnInterrupt(
  sessionId: string,
  state: AppServerControlTurnQueueState,
): Promise<boolean> {
  if (state.interruptInFlight) {
    return true;
  }

  state.interruptInFlight = true;
  const request: AppServerControlInterruptRequest = state.currentTurnId
    ? { turnId: state.currentTurnId }
    : {};

  try {
    await interruptAppServerControlTurn(sessionId, request);
    return true;
  } catch {
    state.interruptInFlight = false;
    return false;
  }
}

async function maybeInterruptAppServerControlTurnAfterSubmit(
  sessionId: string,
  state: AppServerControlTurnQueueState,
): Promise<void> {
  if (!state.pendingInterruptAfterSubmit) {
    return;
  }

  state.pendingInterruptAfterSubmit = false;
  await requestAppServerControlTurnInterrupt(sessionId, state);
}

function isRunningAppServerControlTurnState(state: string | null | undefined): boolean {
  const normalized = (state || '').trim().toLowerCase();
  return normalized === 'running' || normalized === 'in_progress' || normalized === 'submitted';
}
