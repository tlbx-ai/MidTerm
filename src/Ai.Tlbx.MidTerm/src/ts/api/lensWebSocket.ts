import {
  type LensCommandAcceptedResponse,
  type LensHistoryDelta,
  type LensHistoryPatch,
  type LensHistorySnapshot,
  type LensGoalSetRequest,
  type LensHistoryWindowResponse,
  type LensInterruptRequest,
  type LensRequestDecisionRequest,
  type LensTurnRequest,
  type LensTurnStartResponse,
  type LensUserInputAnswerRequest,
} from './types';
import { LensHttpError } from './errors';
import { ReconnectController, createWsUrl } from '../utils';

type LensWsRequestAction =
  | 'attach'
  | 'detach'
  | 'history.window.get'
  | 'turn.submit'
  | 'turn.interrupt'
  | 'thread.goal.set'
  | 'request.approve'
  | 'request.decline'
  | 'request.resolve'
  | 'userInput.resolve';

type LensWsPending =
  | { resolve: () => void; reject: (error: unknown) => void; kind: 'ack' }
  | {
      resolve: (value: LensHistorySnapshot) => void;
      reject: (error: unknown) => void;
      kind: 'historyWindow';
    }
  | {
      resolve: (value: LensTurnStartResponse) => void;
      reject: (error: unknown) => void;
      kind: 'turnStarted';
    }
  | {
      resolve: (value: LensCommandAcceptedResponse) => void;
      reject: (error: unknown) => void;
      kind: 'commandAccepted';
    };

type LensSubscriptionCallbacks = {
  onPatch(patch: LensHistoryDelta): void;
  onHistoryWindow?(historyWindow: LensHistorySnapshot): void;
  onOpen?(): void;
  onError?(error: Event): void;
};

type LensSessionSubscription = {
  afterSequence: number;
  historyWindow?: {
    startIndex?: number;
    count?: number;
    viewportWidth?: number;
    windowRevision?: string;
  };
  listeners: Set<LensSubscriptionCallbacks>;
};

type LensServerMessage =
  | { type: 'ack'; id: string; action: string; sessionId: string }
  | { type: 'error'; id?: string; action?: string; sessionId?: string; message: string }
  | {
      type: 'history.window';
      id?: string;
      sessionId: string;
      windowRevision?: string | null;
      historyWindow: LensHistoryWindowResponse;
    }
  | { type: 'history.patch'; sessionId: string; patch: LensHistoryPatch }
  | { type: 'turnStarted'; id: string; sessionId: string; response: LensTurnStartResponse }
  | {
      type: 'commandAccepted';
      id: string;
      sessionId: string;
      response: LensCommandAcceptedResponse;
    };
type PendingLensServerMessage = Exclude<LensServerMessage, { type: 'history.patch' }>;

const reconnect = new ReconnectController();
const subscriptions = new Map<string, LensSessionSubscription>();
const pending = new Map<string, LensWsPending>();
let ws: WebSocket | null = null;
let connectPromise: Promise<void> | null = null;

function createLensWsError(detail: string): Error {
  return new LensHttpError(400, detail);
}

function createRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `lens-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function buildHistoryWindow(
  startIndex: number | undefined,
  count: number | undefined,
  viewportWidth: number | undefined,
  windowRevision: string | undefined,
): LensSessionSubscription['historyWindow'] | undefined {
  if (
    startIndex === undefined &&
    count === undefined &&
    viewportWidth === undefined &&
    !windowRevision
  ) {
    return undefined;
  }

  return {
    ...(startIndex === undefined ? {} : { startIndex }),
    ...(count === undefined ? {} : { count }),
    ...(viewportWidth === undefined ? {} : { viewportWidth }),
    ...(windowRevision ? { windowRevision } : {}),
  };
}

function historyWindowsEqual(
  left: LensSessionSubscription['historyWindow'] | undefined,
  right: LensSessionSubscription['historyWindow'] | undefined,
): boolean {
  return (
    left?.startIndex === right?.startIndex &&
    left?.count === right?.count &&
    left?.viewportWidth === right?.viewportWidth &&
    left?.windowRevision === right?.windowRevision
  );
}

function normalizeHistoryWindowResponse(
  historyWindow: LensHistoryWindowResponse,
  windowRevision: string | null | undefined,
): LensHistorySnapshot {
  return {
    ...historyWindow,
    windowRevision: windowRevision ?? null,
  };
}

function rejectAllPending(error: Error): void {
  for (const request of pending.values()) {
    request.reject(error);
  }

  pending.clear();
}

function dispatchSubscriptionOpen(): void {
  for (const subscription of subscriptions.values()) {
    for (const listener of subscription.listeners) {
      listener.onOpen?.();
    }
  }
}

function dispatchSubscriptionError(error: Event): void {
  for (const subscription of subscriptions.values()) {
    for (const listener of subscription.listeners) {
      listener.onError?.(error);
    }
  }
}

function resubscribeAll(): void {
  for (const [sessionId, subscription] of subscriptions) {
    sendRaw({
      type: 'subscribe',
      sessionId,
      afterSequence: subscription.afterSequence,
      historyWindow: subscription.historyWindow,
    });
  }
}

function resolvePendingRequest<TKind extends LensWsPending['kind']>(
  id: string,
  kind: TKind,
): Extract<LensWsPending, { kind: TKind }> | null {
  const request = pending.get(id);
  if (!request || request.kind !== kind) {
    return null;
  }

  pending.delete(id);
  return request as Extract<LensWsPending, { kind: TKind }>;
}

function handleHistoryWindowMessage(
  message: Extract<LensServerMessage, { type: 'history.window' }>,
): void {
  if (!message.id) {
    const subscription = subscriptions.get(message.sessionId);
    if (!subscription) {
      return;
    }

    subscription.afterSequence = Math.max(
      subscription.afterSequence,
      message.historyWindow.latestSequence,
    );
    if (
      subscription.historyWindow?.windowRevision &&
      message.windowRevision &&
      subscription.historyWindow.windowRevision !== message.windowRevision
    ) {
      return;
    }
    for (const listener of subscription.listeners) {
      listener.onHistoryWindow?.(
        normalizeHistoryWindowResponse(message.historyWindow, message.windowRevision),
      );
    }
    return;
  }

  resolvePendingRequest(message.id, 'historyWindow')?.resolve(
    normalizeHistoryWindowResponse(message.historyWindow, message.windowRevision),
  );
}

function handleSubscriptionSequenceUpdate(
  sessionId: string,
  nextSequence: number,
  onFound?: (subscription: LensSessionSubscription) => void,
): void {
  const subscription = subscriptions.get(sessionId);
  if (!subscription) {
    return;
  }

  subscription.afterSequence = Math.max(subscription.afterSequence, nextSequence);
  onFound?.(subscription);
}

function handleErrorMessage(message: Extract<LensServerMessage, { type: 'error' }>): void {
  if (!message.id) {
    return;
  }

  const request = pending.get(message.id);
  if (!request) {
    return;
  }

  pending.delete(message.id);
  request.reject(createLensWsError(message.message));
}

const pendingMessageHandlers: {
  [TType in PendingLensServerMessage['type']]: (
    message: Extract<PendingLensServerMessage, { type: TType }>,
  ) => void;
} = {
  ack: (message) => {
    resolvePendingRequest(message.id, 'ack')?.resolve();
  },
  error: handleErrorMessage,
  'history.window': handleHistoryWindowMessage,
  turnStarted: (message) => {
    resolvePendingRequest(message.id, 'turnStarted')?.resolve(message.response);
  },
  commandAccepted: (message) => {
    resolvePendingRequest(message.id, 'commandAccepted')?.resolve(message.response);
  },
};

function isSubscriptionServerMessage(
  message: LensServerMessage,
): message is Extract<LensServerMessage, { type: 'history.patch' }> {
  return message.type === 'history.patch';
}

function handlePendingServerMessage(message: PendingLensServerMessage): void {
  const handler = pendingMessageHandlers[message.type] as (
    pendingMessage: PendingLensServerMessage,
  ) => void;
  handler(message);
}

function emitSubscriptionPatch(sessionId: string, patch: LensHistoryDelta): void {
  handleSubscriptionSequenceUpdate(sessionId, patch.latestSequence, (subscription) => {
    for (const listener of subscription.listeners) {
      listener.onPatch(patch);
    }
  });
}

function handleServerMessage(message: LensServerMessage): void {
  if (!isSubscriptionServerMessage(message)) {
    handlePendingServerMessage(message);
    return;
  }

  emitSubscriptionPatch(message.sessionId, message.patch);
}

function sendRaw(payload: unknown): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

async function ensureConnected(): Promise<void> {
  if (ws?.readyState === WebSocket.OPEN) {
    return;
  }

  if (connectPromise) {
    return connectPromise;
  }

  connectPromise = new Promise<void>((resolve) => {
    const socket = new WebSocket(createWsUrl('/ws/lens'));
    ws = socket;

    socket.onopen = () => {
      reconnect.reset();
      connectPromise = null;
      dispatchSubscriptionOpen();
      resubscribeAll();
      resolve();
    };

    socket.onmessage = (event) => {
      handleServerMessage(JSON.parse(event.data as string) as LensServerMessage);
    };

    socket.onerror = (event) => {
      dispatchSubscriptionError(event);
    };

    socket.onclose = () => {
      const shouldReconnect = subscriptions.size > 0;
      ws = null;
      connectPromise = null;
      rejectAllPending(createLensWsError('Lens WebSocket disconnected.'));
      if (shouldReconnect) {
        reconnect.schedule(() => {
          void ensureConnected();
        });
      }
    };
  });

  return connectPromise;
}

async function requestAck(
  action: LensWsRequestAction,
  sessionId: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await ensureConnected();
  const id = createRequestId();
  const request = new Promise<void>((resolve, reject) => {
    pending.set(id, { resolve, reject, kind: 'ack' });
  });
  sendRaw({ type: 'request', id, action, sessionId, ...extra });
  return request;
}

async function requestHistoryWindow(
  sessionId: string,
  startIndex?: number,
  count?: number,
  windowRevision?: string,
  viewportWidth?: number,
): Promise<LensHistorySnapshot> {
  await ensureConnected();
  const id = createRequestId();
  const request = new Promise<LensHistorySnapshot>((resolve, reject) => {
    pending.set(id, { resolve, reject, kind: 'historyWindow' });
  });
  sendRaw({
    type: 'request',
    id,
    action: 'history.window.get',
    sessionId,
    historyWindow:
      startIndex === undefined && count === undefined && viewportWidth === undefined
        ? undefined
        : {
            ...(startIndex === undefined ? {} : { startIndex }),
            ...(count === undefined ? {} : { count }),
            ...(viewportWidth === undefined ? {} : { viewportWidth }),
            ...(windowRevision ? { windowRevision } : {}),
          },
  });
  return request;
}

async function requestTurnStarted(
  action: 'turn.submit',
  sessionId: string,
  turn: LensTurnRequest,
): Promise<LensTurnStartResponse> {
  await ensureConnected();
  const id = createRequestId();
  const request = new Promise<LensTurnStartResponse>((resolve, reject) => {
    pending.set(id, { resolve, reject, kind: 'turnStarted' });
  });
  sendRaw({
    type: 'request',
    id,
    action,
    sessionId,
    turn,
  });
  return request;
}

async function requestCommandAccepted(
  action: Exclude<LensWsRequestAction, 'attach' | 'detach' | 'history.window.get' | 'turn.submit'>,
  sessionId: string,
  extra: Record<string, unknown> = {},
): Promise<LensCommandAcceptedResponse> {
  await ensureConnected();
  const id = createRequestId();
  const request = new Promise<LensCommandAcceptedResponse>((resolve, reject) => {
    pending.set(id, { resolve, reject, kind: 'commandAccepted' });
  });
  sendRaw({
    type: 'request',
    id,
    action,
    sessionId,
    ...extra,
  });
  return request;
}

export async function attachLensSession(sessionId: string): Promise<void> {
  return requestAck('attach', sessionId);
}

export async function detachLensSession(sessionId: string): Promise<void> {
  return requestAck('detach', sessionId);
}

export async function getLensHistoryWindowWs(
  sessionId: string,
  startIndex?: number,
  count?: number,
  windowRevision?: string,
  viewportWidth?: number,
): Promise<LensHistorySnapshot> {
  return requestHistoryWindow(sessionId, startIndex, count, windowRevision, viewportWidth);
}

export async function submitLensTurnWs(
  sessionId: string,
  request: LensTurnRequest,
): Promise<LensTurnStartResponse> {
  return requestTurnStarted('turn.submit', sessionId, request);
}

export async function interruptLensTurnWs(
  sessionId: string,
  request: LensInterruptRequest,
): Promise<LensCommandAcceptedResponse> {
  return requestCommandAccepted('turn.interrupt', sessionId, { interrupt: request });
}

export async function setLensGoalWs(
  sessionId: string,
  request: LensGoalSetRequest,
): Promise<LensCommandAcceptedResponse> {
  return requestCommandAccepted('thread.goal.set', sessionId, { goalSet: request });
}

export async function approveLensRequestWs(
  sessionId: string,
  requestId: string,
): Promise<LensCommandAcceptedResponse> {
  return requestCommandAccepted('request.approve', sessionId, { requestId });
}

export async function declineLensRequestWs(
  sessionId: string,
  requestId: string,
  request: LensRequestDecisionRequest,
): Promise<LensCommandAcceptedResponse> {
  return requestCommandAccepted('request.decline', sessionId, {
    requestId,
    requestDecision: request,
  });
}

export async function resolveLensUserInputWs(
  sessionId: string,
  requestId: string,
  request: LensUserInputAnswerRequest,
): Promise<LensCommandAcceptedResponse> {
  return requestCommandAccepted('userInput.resolve', sessionId, {
    requestId,
    userInputAnswer: request,
  });
}

export function openLensHistorySocket(
  sessionId: string,
  afterSequence: number,
  startIndex: number | undefined,
  count: number | undefined,
  windowRevision: string | undefined,
  callbacks: LensSubscriptionCallbacks,
  viewportWidth?: number,
): () => void {
  let subscription = subscriptions.get(sessionId);
  if (!subscription) {
    subscription = {
      afterSequence,
      listeners: new Set<LensSubscriptionCallbacks>(),
    };
  }
  subscription.afterSequence = Math.max(subscription.afterSequence, afterSequence);
  const nextHistoryWindow = buildHistoryWindow(startIndex, count, viewportWidth, windowRevision);
  if (nextHistoryWindow) {
    subscription.historyWindow = nextHistoryWindow;
  }
  subscription.listeners.add(callbacks);
  subscriptions.set(sessionId, subscription);

  const shouldSendSubscribeImmediately = ws?.readyState === WebSocket.OPEN;
  void ensureConnected()
    .then(() => {
      if (!shouldSendSubscribeImmediately) {
        return;
      }

      const current = subscriptions.get(sessionId);
      if (!current || !current.listeners.has(callbacks)) {
        return;
      }

      sendRaw({
        type: 'subscribe',
        sessionId,
        afterSequence: current.afterSequence,
        historyWindow: current.historyWindow,
      });
    })
    .catch(() => {
      callbacks.onError?.(new Event('error'));
    });

  return () => {
    const current = subscriptions.get(sessionId);
    if (!current) {
      return;
    }

    current.listeners.delete(callbacks);
    if (current.listeners.size > 0) {
      return;
    }

    subscriptions.delete(sessionId);
    sendRaw({
      type: 'unsubscribe',
      sessionId,
      afterSequence: current.afterSequence,
    });
  };
}

export function updateLensHistorySocketWindow(
  sessionId: string,
  startIndex: number | undefined,
  count: number | undefined,
  windowRevision: string | undefined,
  viewportWidth?: number,
): void {
  const subscription = subscriptions.get(sessionId);
  if (!subscription) {
    return;
  }

  const nextHistoryWindow = buildHistoryWindow(startIndex, count, viewportWidth, windowRevision);
  if (historyWindowsEqual(subscription.historyWindow, nextHistoryWindow)) {
    return;
  }

  if (nextHistoryWindow) {
    subscription.historyWindow = nextHistoryWindow;
  } else {
    delete subscription.historyWindow;
  }

  const shouldSendSubscribeImmediately = ws?.readyState === WebSocket.OPEN;
  void ensureConnected().then(() => {
    if (!shouldSendSubscribeImmediately) {
      return;
    }

    const current = subscriptions.get(sessionId);
    if (!current) {
      return;
    }

    sendRaw({
      type: 'subscribe',
      sessionId,
      afterSequence: current.afterSequence,
      historyWindow: current.historyWindow,
    });
  });
}
