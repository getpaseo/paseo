import { EventEmitter } from "node:events";
import pino from "pino";
import { expect, test } from "vitest";
import { SessionDelivery } from "../owned-subscriptions/index.js";
import { VoiceSessions } from "./index.js";
import type { StreamingTranscriptionSession } from "../../speech/speech-provider.js";

test("a failed speech close reports the failure without retaining observation demand", async () => {
  class BrokenCloseStream extends EventEmitter implements StreamingTranscriptionSession {
    readonly requiredSampleRate = 16000;
    async connect() {}
    appendPcm16() {}
    commit() {}
    clear() {}
    close() {
      throw new Error("Speech worker close failed");
    }
  }
  const source = {};
  const delivery = new SessionDelivery(() => {});
  delivery.attach(source, true);
  const demands: boolean[] = [];
  const voice = new VoiceSessions(
    {
      sessionId: "failed-speech-close",
      logger: pino({ level: "silent" }),
      host: {
        emit() {},
        async loadAgent() {
          throw new Error("Unexpected agent load");
        },
        async reloadAgentSession() {
          throw new Error("Unexpected agent reload");
        },
        async sendSpokenInput() {
          throw new Error("Unexpected spoken input");
        },
        async interruptAgentIfRunning() {},
        hasActiveAgentRun: () => false,
      },
      stt: null,
      tts: null,
      dictation: { stt: { id: "local", createSession: () => new BrokenCloseStream() } },
    },
    delivery,
    () => demands.push(voice.hasDemand),
  );
  const request = {
    type: "dictation_stream_start" as const,
    dictationId: "recording",
    format: "audio/pcm;rate=16000;bits=16",
  };
  await delivery.request(source, request, () => voice.handleMessage(request));
  expect(voice.hasDemand).toBe(true);
  await expect(delivery.detach(source)).rejects.toThrow();
  expect(voice.hasDemand).toBe(false);
  expect(demands.at(-1)).toBe(false);
});
