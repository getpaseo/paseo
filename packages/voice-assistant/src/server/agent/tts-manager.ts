import { v4 as uuidv4 } from "uuid";
import { synthesizeSpeech } from "./tts-openai.js";
import type { VoiceAssistantWebSocketServer } from "../websocket-server.js";

interface PendingPlayback {
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

/**
 * Store pending playback confirmations
 * Maps audio ID -> promise resolve/reject handlers
 */
const pendingPlaybacks = new Map<string, PendingPlayback>();

/**
 * Timeout for waiting on client playback confirmation (30 seconds)
 */
const PLAYBACK_TIMEOUT_MS = 30000;

/**
 * Generate TTS audio, broadcast to clients, and wait for playback confirmation
 * Returns a Promise that resolves when the client confirms playback completed
 */
export async function generateTTSAndWaitForPlayback(
  text: string,
  wsServer: VoiceAssistantWebSocketServer
): Promise<void> {
  // Generate TTS audio
  const { audio, format } = await synthesizeSpeech(text);

  // Create unique ID for this audio segment
  const audioId = uuidv4();

  // Create promise that will be resolved when client confirms playback
  const playbackPromise = new Promise<void>((resolve, reject) => {
    // Set timeout to prevent hanging forever
    const timeout = setTimeout(() => {
      pendingPlaybacks.delete(audioId);
      reject(new Error(`Audio playback timeout for ${audioId}`));
    }, PLAYBACK_TIMEOUT_MS);

    // Store handlers
    pendingPlaybacks.set(audioId, { resolve, reject, timeout });
  });

  // Broadcast audio to clients
  wsServer.broadcast({
    type: "audio_output",
    payload: {
      id: audioId,
      audio: audio.toString("base64"),
      format,
    },
  });

  console.log(
    `[TTS-Manager] ${new Date().toISOString()} Sent audio ${audioId}, waiting for playback...`
  );

  // Wait for playback confirmation
  await playbackPromise;

  console.log(
    `[TTS-Manager] ${new Date().toISOString()} Audio ${audioId} playback confirmed`
  );
}

/**
 * Called when client confirms audio playback completed
 * Resolves the corresponding promise
 */
export function confirmAudioPlayed(audioId: string): void {
  const pending = pendingPlaybacks.get(audioId);

  if (!pending) {
    console.warn(
      `[TTS-Manager] Received confirmation for unknown audio ID: ${audioId}`
    );
    return;
  }

  // Clear timeout and resolve promise
  clearTimeout(pending.timeout);
  pending.resolve();
  pendingPlaybacks.delete(audioId);
}
