/**
 * Transcription Client
 *
 * Connects to MidTerm.Voice /transcribe WebSocket endpoint
 * for push-to-talk speech-to-text transcription.
 */

import { $voiceServerPassword } from '../../stores';
import { createLogger } from '../logging';

const log = createLogger('transcription');

let ws: WebSocket | null = null;
let onDeltaCallback: ((text: string) => void) | null = null;
let onCompletedCallback: ((text: string) => void) | null = null;
let audioFrameCount = 0;

interface TranscriptionMessage {
  type: string;
  content?: string;
  message?: string;
}

export function startTranscription(
  onDelta: (text: string) => void,
  onCompleted: (text: string) => void,
): void {
  onDeltaCallback = onDelta;
  onCompletedCallback = onCompleted;

  let wsUrl = `wss://midterm.tlbx.ai/transcribe`;
  const password = $voiceServerPassword.get();
  if (password) {
    wsUrl += `?password=${encodeURIComponent(password)}`;
  }

  audioFrameCount = 0;
  log.info(() => `Connecting to ${wsUrl}`);

  ws = new WebSocket(wsUrl);

  ws.onopen = async () => {
    log.info(() => 'Connected, sending start');
    ws?.send(JSON.stringify({ type: 'start' }));

    if (window.initAudioWithUserInteraction) {
      await window.initAudioWithUserInteraction();
    }

    if (window.startRecording) {
      const success = await window.startRecording(
        (base64Audio: string) => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            const bytes = base64ToArrayBuffer(base64Audio);
            audioFrameCount++;
            ws.send(bytes);
          }
        },
        500,
        null,
        24000,
      );

      if (!success) {
        log.error(() => 'Recording failed to start');
        void stopTranscription();
      }
    }
  };

  ws.onmessage = (event: MessageEvent) => {
    if (typeof event.data !== 'string') return;
    try {
      const msg = JSON.parse(event.data) as TranscriptionMessage;
      switch (msg.type) {
        case 'delta':
          if (msg.content && onDeltaCallback) {
            onDeltaCallback(msg.content);
          }
          break;
        case 'completed':
          if (msg.content && onCompletedCallback) {
            onCompletedCallback(msg.content);
          }
          break;
        case 'error':
          log.error(() => `Transcription error: ${msg.message ?? 'unknown'}`);
          break;
      }
    } catch {
      log.warn(() => `Invalid JSON: ${event.data}`);
    }
  };

  ws.onclose = () => {
    log.info(() => `Disconnected (${audioFrameCount} frames sent)`);
  };

  ws.onerror = () => {
    log.error(() => 'WebSocket error');
  };
}

export async function stopTranscription(): Promise<void> {
  if (window.stopRecording) {
    await window.stopRecording();
  }

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'stop' }));
  }

  onDeltaCallback = null;
  onCompletedCallback = null;
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}
