import type { Page } from "@playwright/test";
import { daemonWsRoutePattern } from "./daemon-port";

type WebSocketMessage = string | Buffer;

interface SessionSocket {
  send(message: string): void;
}

/** What the rewritten `server_info` reports for dictation; `missing` drops the voice field. */
export type DictationCapability = { enabled: boolean; reason: string } | "missing";

function parseEnvelope(message: WebSocketMessage): {
  type?: unknown;
  message?: Record<string, unknown>;
} | null {
  const raw = typeof message === "string" ? message : message.toString("utf8");
  try {
    return JSON.parse(raw) as { type?: unknown; message?: Record<string, unknown> };
  } catch {
    return null;
  }
}

export function sessionMessage(message: WebSocketMessage): Record<string, unknown> | null {
  const envelope = parseEnvelope(message);
  return envelope?.type === "session" && envelope.message ? envelope.message : null;
}

export function sendSessionMessage(ws: SessionSocket, message: Record<string, unknown>): void {
  ws.send(JSON.stringify({ type: "session", message }));
}

function rewriteDictationCapability(
  message: WebSocketMessage,
  capability: DictationCapability,
): WebSocketMessage {
  const envelope = parseEnvelope(message);
  const payload = envelope?.message?.payload;
  if (
    envelope?.message?.type !== "status" ||
    !payload ||
    typeof payload !== "object" ||
    (payload as { status?: unknown }).status !== "server_info"
  ) {
    return message;
  }

  const serverInfo = payload as Record<string, unknown>;
  if (capability === "missing") {
    const capabilities = serverInfo.capabilities as Record<string, unknown> | undefined;
    if (capabilities) {
      delete capabilities.voice;
    }
  } else {
    serverInfo.capabilities = {
      voice: {
        dictation: capability,
        voice: { enabled: false, reason: "Realtime voice is disabled in this test." },
      },
    };
  }
  return JSON.stringify(envelope);
}

interface SyntheticMicrophoneState {
  getUserMediaCalls: number;
  trackStops: number;
  hold: boolean;
  pending: Array<() => void>;
}

/**
 * Replaces getUserMedia with an oscillator stream, so the app's real web audio
 * source runs end to end. Counts calls and stopped tracks, and can hold an
 * acquisition until the test releases it (a permission prompt left open).
 */
export async function installSyntheticMicrophone(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state: SyntheticMicrophoneState = {
      getUserMediaCalls: 0,
      trackStops: 0,
      hold: false,
      pending: [],
    };
    (
      window as unknown as { __paseoSyntheticMicrophone: SyntheticMicrophoneState }
    ).__paseoSyntheticMicrophone = state;
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async () => {
        state.getUserMediaCalls += 1;
        if (state.hold) {
          await new Promise<void>((resolve) => state.pending.push(resolve));
        }
        const context = new AudioContext();
        const oscillator = context.createOscillator();
        const destination = context.createMediaStreamDestination();
        oscillator.connect(destination);
        oscillator.start();
        for (const track of destination.stream.getTracks()) {
          const stop = track.stop.bind(track);
          track.stop = () => {
            state.trackStops += 1;
            stop();
          };
        }
        return destination.stream;
      },
    });
  });
}

export async function microphoneStats(
  page: Page,
): Promise<{ getUserMediaCalls: number; trackStops: number }> {
  return await page.evaluate(() => {
    const state = (window as unknown as { __paseoSyntheticMicrophone: SyntheticMicrophoneState })
      .__paseoSyntheticMicrophone;
    return { getUserMediaCalls: state.getUserMediaCalls, trackStops: state.trackStops };
  });
}

/** Makes the next getUserMedia calls wait until `releaseMicrophone`. */
export async function holdMicrophone(page: Page): Promise<void> {
  await page.evaluate(() => {
    (
      window as unknown as { __paseoSyntheticMicrophone: SyntheticMicrophoneState }
    ).__paseoSyntheticMicrophone.hold = true;
  });
}

export async function releaseMicrophone(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = (window as unknown as { __paseoSyntheticMicrophone: SyntheticMicrophoneState })
      .__paseoSyntheticMicrophone;
    state.hold = false;
    for (const resolve of state.pending.splice(0)) {
      resolve();
    }
  });
}

export interface DictationWsHarness {
  /** Every `dictation_stream_start` the app sent. */
  streamStarts(): number;
  /** Audio chunks the app sent, across all dictation ids. */
  chunks(): number;
  /** Resolves on the first chunk the app sends after this call. */
  nextChunk(): Promise<void>;
  /** The final transcript the next finish replies with. */
  setTranscript(text: string): void;
  /** Keeps the next final reply until `releaseFinal`. */
  holdFinal(): void;
  releaseFinal(): void;
  /** Answers the next finish with a stream error instead of a final. */
  failNextFinish(error: string): void;
}

/**
 * Answers the app's dictation stream in place of the daemon: acknowledges starts
 * and chunks, accepts finishes and replies with the scenario's transcript. Rewrites
 * `server_info` to the given dictation capability and forwards everything else, so
 * terminals, agents and workspaces keep using the real daemon.
 * `interceptClientMessage` lets a spec answer other requests itself; return true
 * when it handled one.
 */
export async function installDictationWsHarness(
  page: Page,
  options: {
    transcript?: string;
    capability?: DictationCapability;
    interceptClientMessage?: (request: Record<string, unknown>, ws: SessionSocket) => boolean;
  } = {},
): Promise<DictationWsHarness> {
  const capability = options.capability ?? { enabled: true, reason: "" };
  let transcript = options.transcript ?? "";
  let starts = 0;
  let chunkCount = 0;
  let chunkWaiters: Array<() => void> = [];
  let holdNextFinal = false;
  let heldFinal: (() => void) | null = null;
  let nextFinishError: string | null = null;

  await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
    const server = ws.connectToServer();

    ws.onMessage((message) => {
      const request = sessionMessage(message);
      const type = request?.type;
      const dictationId = typeof request?.dictationId === "string" ? request.dictationId : null;

      if (type === "dictation_stream_start" && dictationId) {
        starts += 1;
        sendSessionMessage(ws, {
          type: "dictation_stream_ack",
          payload: { dictationId, ackSeq: -1 },
        });
        return;
      }
      if (type === "dictation_stream_chunk" && dictationId) {
        chunkCount += 1;
        const seq = typeof request?.seq === "number" ? request.seq : 0;
        sendSessionMessage(ws, {
          type: "dictation_stream_ack",
          payload: { dictationId, ackSeq: seq },
        });
        const waiters = chunkWaiters;
        chunkWaiters = [];
        for (const resolve of waiters) {
          resolve();
        }
        return;
      }
      if (type === "dictation_stream_finish" && dictationId) {
        sendSessionMessage(ws, {
          type: "dictation_stream_finish_accepted",
          payload: { dictationId, timeoutMs: 30_000 },
        });
        if (nextFinishError !== null) {
          const error = nextFinishError;
          nextFinishError = null;
          sendSessionMessage(ws, {
            type: "dictation_stream_error",
            payload: { dictationId, error, retryable: true },
          });
          return;
        }
        const text = transcript;
        const reply = () =>
          sendSessionMessage(ws, {
            type: "dictation_stream_final",
            payload: { dictationId, text },
          });
        if (holdNextFinal) {
          holdNextFinal = false;
          heldFinal = reply;
        } else {
          reply();
        }
        return;
      }
      if (type === "dictation_stream_cancel") {
        return;
      }
      if (request && options.interceptClientMessage?.(request, ws)) {
        return;
      }

      server.send(message);
    });

    server.onMessage((message) => ws.send(rewriteDictationCapability(message, capability)));
  });

  return {
    streamStarts: () => starts,
    chunks: () => chunkCount,
    nextChunk: () => new Promise<void>((resolve) => chunkWaiters.push(resolve)),
    setTranscript: (text) => {
      transcript = text;
    },
    holdFinal: () => {
      holdNextFinal = true;
    },
    releaseFinal: () => {
      const reply = heldFinal;
      heldFinal = null;
      if (!reply) {
        throw new Error("No final reply is being held");
      }
      reply();
    },
    failNextFinish: (error) => {
      nextFinishError = error;
    },
  };
}
