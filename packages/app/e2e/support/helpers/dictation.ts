import type { Page } from "../fixtures";
import { daemonWsRoutePattern } from "./daemon-port";

type WebSocketMessage = string | Buffer;

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

export function sendSessionMessage(
  ws: { send(message: string): void },
  message: Record<string, unknown>,
): void {
  ws.send(JSON.stringify({ type: "session", message }));
}

export function enableDictationCapability(message: WebSocketMessage): WebSocketMessage {
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
  (payload as Record<string, unknown>).capabilities = {
    voice: {
      dictation: { enabled: true, reason: "" },
      voice: { enabled: false, reason: "Realtime voice is disabled in this test." },
    },
  };
  return JSON.stringify(envelope);
}

/**
 * Replaces the browser microphone with an oscillator. `silent` keeps the stream
 * running at zero gain, which is what a muted or wrongly routed input delivers.
 */
export async function installSyntheticMicrophone(
  page: Page,
  options: { silent?: boolean } = {},
): Promise<void> {
  await page.addInitScript((silent: boolean) => {
    const mediaDevices = navigator.mediaDevices;
    Object.defineProperty(mediaDevices, "getUserMedia", {
      configurable: true,
      value: async () => {
        const context = new AudioContext();
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        gain.gain.value = silent ? 0 : 1;
        const destination = context.createMediaStreamDestination();
        oscillator.connect(gain);
        gain.connect(destination);
        oscillator.start();
        return destination.stream;
      },
    });
  }, options.silent ?? false);
}

/**
 * Answers dictation stream requests in place of the daemon. Each finish is
 * answered with the next queued transcript; everything else reaches the daemon.
 */
export async function installDictationTranscriptHarness(page: Page, transcripts: string[]) {
  const queue = [...transcripts];
  let resolveAudioChunk!: () => void;
  const audioChunk = new Promise<void>((resolve) => {
    resolveAudioChunk = resolve;
  });

  await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
    const server = ws.connectToServer();

    ws.onMessage((message) => {
      const request = sessionMessage(message);
      const type = request?.type;
      const dictationId = typeof request?.dictationId === "string" ? request.dictationId : null;

      if (type === "dictation_stream_start" && dictationId) {
        sendSessionMessage(ws, {
          type: "dictation_stream_ack",
          payload: { dictationId, ackSeq: -1 },
        });
        return;
      }
      if (type === "dictation_stream_chunk" && dictationId) {
        const seq = typeof request?.seq === "number" ? request.seq : 0;
        sendSessionMessage(ws, {
          type: "dictation_stream_ack",
          payload: { dictationId, ackSeq: seq },
        });
        resolveAudioChunk();
        return;
      }
      if (type === "dictation_stream_finish" && dictationId) {
        sendSessionMessage(ws, {
          type: "dictation_stream_finish_accepted",
          payload: { dictationId, timeoutMs: 5_000 },
        });
        sendSessionMessage(ws, {
          type: "dictation_stream_final",
          payload: { dictationId, text: queue.shift() ?? "" },
        });
        return;
      }

      server.send(message);
    });

    server.onMessage((message) => ws.send(enableDictationCapability(message)));
  });

  return { waitForAudio: () => audioChunk };
}
