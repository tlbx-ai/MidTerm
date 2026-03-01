/**
 * Transcription Client
 *
 * Records audio via webAudioAccess.js, then POSTs raw PCM16
 * to the MidTerm.Voice /api/transcribe REST endpoint.
 */

import { $voiceServerPassword } from '../../stores';
import { createLogger } from '../logging';

const log = createLogger('transcription');
const VOICE_SERVER_URL = 'https://midterm.tlbx.ai';

let audioChunks: ArrayBuffer[] = [];
let isRecording = false;
let onCompletedCallback: ((text: string) => void) | null = null;

export function startTranscription(
  _onDelta: (text: string) => void,
  onCompleted: (text: string) => void,
): void {
  onCompletedCallback = onCompleted;
  audioChunks = [];
  isRecording = true;

  log.info(() => 'Starting push-to-talk recording');

  void (async () => {
    if (window.initAudioWithUserInteraction) {
      await window.initAudioWithUserInteraction();
    }

    if (window.startRecording) {
      const success = await window.startRecording(
        (base64Audio: string) => {
          if (!isRecording) return;
          audioChunks.push(base64ToArrayBuffer(base64Audio));
        },
        500,
        null,
        24000,
      );

      if (!success) {
        log.error(() => 'Recording failed to start');
        isRecording = false;
      }
    }
  })();
}

export async function stopTranscription(): Promise<void> {
  if (!isRecording) return;
  isRecording = false;

  if (window.stopRecording) {
    await window.stopRecording();
  }

  if (audioChunks.length === 0) {
    log.warn(() => 'No audio frames captured');
    return;
  }

  const pcmData = concatenateBuffers(audioChunks);
  audioChunks = [];

  log.info(() => `Sending ${pcmData.byteLength} bytes for transcription`);

  try {
    const password = $voiceServerPassword.get();
    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
    };
    if (password) {
      headers['Authorization'] = `Bearer ${password}`;
    }

    const response = await fetch(`${VOICE_SERVER_URL}/api/transcribe`, {
      method: 'POST',
      headers,
      body: pcmData,
    });

    if (!response.ok) {
      log.error(() => `Transcription failed: ${String(response.status)}`);
      return;
    }

    const result = (await response.json()) as { text?: string };
    if (result.text && onCompletedCallback) {
      onCompletedCallback(result.text);
    }
  } catch (e) {
    log.error(() => `Transcription error: ${String(e)}`);
  }
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

function concatenateBuffers(buffers: ArrayBuffer[]): ArrayBuffer {
  const totalLength = buffers.reduce((sum, b) => sum + b.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const buf of buffers) {
    result.set(new Uint8Array(buf), offset);
    offset += buf.byteLength;
  }
  return result.buffer;
}
