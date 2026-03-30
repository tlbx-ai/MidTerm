import {
  type LensCommandAcceptedResponse,
  type LensInterruptRequest,
  type LensPulseDeltaResponse,
  type LensPulseEvent,
  type LensPulseEventListResponse,
  type LensPulseSnapshotResponse,
  type LensRequestDecisionRequest,
  type LensTurnRequest,
  type LensTurnStartResponse,
  type LensUserInputAnswerRequest,
} from './types';
import { ReconnectController, createWsUrl } from '../utils';

type LensWsRequestAction =
  | 'attach'
  | 'detach'
  | 'snapshot.get'
  | 'events.get'
  | 'turn.submit'
  | 'turn.interrupt'
  | 'request.approve'
  | 'request.decline'
  | 'request.resolve'
  | 'userInput.resolve';

type LensWsPending =
  | { resolve: () => void; reject: (error: unknown) => void; kind: 'ack' }
  | {
      resolve: (value: LensPulseSnapshotResponse) => void;
      reject: (error: unknown) => void;
      kind: 'snapshot';
    }
  | {
      resolve: (value: LensPulseEventListResponse) => void;
      reject: (error: unknown) => void;
      kind: 'events';
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
  onDelta(delta: LensPulseDeltaResponse): void;
  onSnapshot?(snapshot: LensPulseSnapshotResponse): void;
  onOpen?(): void;
  onError?(error: Event): void;
};

type LensSessionSubscription = {
  afterSequence: number;
  snapshotWindow?: {
    startIndex?: number;
    count?: number;
  };
  listeners: Set<LensSubscriptionCallbacks>;
};

type LensServerMessage =
  | { type: 'ack'; id: string; action: string; sessionId: string }
  | { type: 'error'; id?: string; action?: string; sessionId?: string; message: string }
  | { type: 'snapshot'; id?: string; sessionId: string; snapshot: LensPulseSnapshotResponse }
  | { type: 'events'; id?: string; sessionId: string; events: LensPulseEventListResponse }
  | { type: 'event'; sessionId: string; event: LensPulseEvent }
  | { type: 'delta'; sessionId: string; delta: LensPulseDeltaResponse }
  | { type: 'turnStarted'; id: string; sessionId: string; response: LensTurnStartResponse }
  | {
      type: 'commandAccepted';
      id: string;
      sessionId: string;
      response: LensCommandAcceptedResponse;
    };

const reconnect = new ReconnectController();
const subscriptions = new Map<string, LensSessionSubscription>();
const pending = new Map<string, LensWsPending>();
let ws: WebSocket | null = null;
let connectPromise: Promise<void> | null = null;

function createLensWsError(detail: string): Error {
  const error = new Error(`HTTP 400: ${detail}`);
  error.name = 'LensHttpError';
  return error;
}

function createRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `lens-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function buildSnapshotWindow(
  startIndex: number | undefined,
  count: number | undefined,
): LensSessionSubscription['snapshotWindow'] | undefined {
  if (startIndex === undefined && count === undefined) {
    return undefined;
  }

  return {
    ...(startIndex === undefined ? {} : { startIndex }),
    ...(count === undefined ? {} : { count }),
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
      snapshotWindow: subscription.snapshotWindow,
    });
  }
}

function handleServerMessage(message: LensServerMessage): void {
  switch (message.type) {
    case 'ack': {
      const request = pending.get(message.id);
      if (request?.kind === 'ack') {
        pending.delete(message.id);
        request.resolve();
      }
      return;
    }
    case 'error': {
      if (message.id) {
        const request = pending.get(message.id);
        if (request) {
          pending.delete(message.id);
          request.reject(createLensWsError(message.message));
          return;
        }
      }

      return;
    }
    case 'snapshot': {
      if (!message.id) {
        const subscription = subscriptions.get(message.sessionId);
        if (!subscription) {
          return;
        }

        subscription.afterSequence = Math.max(
          subscription.afterSequence,
          message.snapshot.latestSequence,
        );
        for (const listener of subscription.listeners) {
          listener.onSnapshot?.(message.snapshot);
        }
        return;
      }

      const request = pending.get(message.id);
      if (request?.kind === 'snapshot') {
        pending.delete(message.id);
        request.resolve(message.snapshot);
      }
      return;
    }
    case 'events': {
      if (!message.id) {
        return;
      }

      const request = pending.get(message.id);
      if (request?.kind === 'events') {
        pending.delete(message.id);
        request.resolve(message.events);
      }
      return;
    }
    case 'turnStarted': {
      const request = pending.get(message.id);
      if (request?.kind === 'turnStarted') {
        pending.delete(message.id);
        request.resolve(message.response);
      }
      return;
    }
    case 'commandAccepted': {
      const request = pending.get(message.id);
      if (request?.kind === 'commandAccepted') {
        pending.delete(message.id);
        request.resolve(message.response);
      }
      return;
    }
    case 'event': {
      const subscription = subscriptions.get(message.sessionId);
      if (!subscription) {
        return;
      }

      subscription.afterSequence = Math.max(subscription.afterSequence, message.event.sequence);
      return;
    }
    case 'delta': {
      const subscription = subscriptions.get(message.sessionId);
      if (!subscription) {
        return;
      }

      subscription.afterSequence = Math.max(
        subscription.afterSequence,
        message.delta.latestSequence,
      );
      for (const listener of subscription.listeners) {
        listener.onDelta(message.delta);
      }
      return;
    }
  }
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

async function requestSnapshot(
  sessionId: string,
  startIndex?: number,
  count?: number,
): Promise<LensPulseSnapshotResponse> {
  await ensureConnected();
  const id = createRequestId();
  const request = new Promise<LensPulseSnapshotResponse>((resolve, reject) => {
    pending.set(id, { resolve, reject, kind: 'snapshot' });
  });
  sendRaw({
    type: 'request',
    id,
    action: 'snapshot.get',
    sessionId,
    snapshotWindow:
      startIndex === undefined && count === undefined
        ? undefined
        : {
            ...(startIndex === undefined ? {} : { startIndex }),
            ...(count === undefined ? {} : { count }),
          },
  });
  return request;
}

async function requestEvents(
  sessionId: string,
  afterSequence = 0,
): Promise<LensPulseEventListResponse> {
  await ensureConnected();
  const id = createRequestId();
  const request = new Promise<LensPulseEventListResponse>((resolve, reject) => {
    pending.set(id, { resolve, reject, kind: 'events' });
  });
  sendRaw({
    type: 'request',
    id,
    action: 'events.get',
    sessionId,
    afterSequence,
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
  action: Exclude<
    LensWsRequestAction,
    'attach' | 'detach' | 'snapshot.get' | 'events.get' | 'turn.submit'
  >,
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

export async function getLensSnapshotWs(
  sessionId: string,
  startIndex?: number,
  count?: number,
): Promise<LensPulseSnapshotResponse> {
  return requestSnapshot(sessionId, startIndex, count);
}

export async function getLensEventsWs(
  sessionId: string,
  afterSequence = 0,
): Promise<LensPulseEventListResponse> {
  return requestEvents(sessionId, afterSequence);
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

export function openLensEventSocket(
  sessionId: string,
  afterSequence: number,
  startIndex: number | undefined,
  count: number | undefined,
  callbacks: LensSubscriptionCallbacks,
): () => void {
  let subscription = subscriptions.get(sessionId);
  if (!subscription) {
    subscription = {
      afterSequence,
      listeners: new Set<LensSubscriptionCallbacks>(),
    };
  }
  subscription.afterSequence = Math.max(subscription.afterSequence, afterSequence);
  const nextSnapshotWindow = buildSnapshotWindow(startIndex, count);
  if (nextSnapshotWindow) {
    subscription.snapshotWindow = nextSnapshotWindow;
  }
  subscription.listeners.add(callbacks);
  subscriptions.set(sessionId, subscription);

  void ensureConnected()
    .then(() => {
      sendRaw({
        type: 'subscribe',
        sessionId,
        afterSequence: subscription.afterSequence,
        snapshotWindow: subscription.snapshotWindow,
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
