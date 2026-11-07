import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import pino from "pino";
import { expect, test } from "vitest";
import {
  DictationStreamManager,
  type DictationStreamOutboundMessage,
} from "./dictation-stream-manager.js";
import {
  LocalSpeechWorkerClient,
  WorkerBackedSpeechToTextProvider,
} from "../speech/providers/local/worker-client.js";
import { parsePcm16MonoWav } from "../test-utils/dictation-e2e.js";

const modelsDir =
  process.env.PASEO_LOCAL_MODELS_DIR ?? path.join(homedir(), ".paseo", "models", "local-speech");
const enabled =
  process.env.PASEO_LOCAL_REPLAY_REPRO === "1" &&
  existsSync(
    path.join(modelsDir, "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8", "encoder.int8.onnx"),
  );

// Opt-in diagnostic: actual native inference, no downloaded models or fake worker.
test.skipIf(!enabled)(
  "replays 806 retained PCM chunks without timing out local speech requests",
  async () => {
    const logger = pino({ level: "silent" });
    const worker = new LocalSpeechWorkerClient({
      logger,
      config: {
        modelsDir,
        voiceSttModel: "parakeet-tdt-0.6b-v2-int8",
        dictationSttModel: "parakeet-tdt-0.6b-v2-int8",
        voiceTtsModel: "kokoro-en-v0_19",
      },
    });
    let settle!: (message: DictationStreamOutboundMessage) => void;
    const outcome = new Promise<DictationStreamOutboundMessage>((resolve) => {
      settle = resolve;
    });
    const manager = new DictationStreamManager({
      logger,
      sessionId: "local-replay-repro",
      stt: new WorkerBackedSpeechToTextProvider(worker, "dictationStt"),
      emit: (message) => {
        if (message.type === "dictation_stream_final" || message.type === "dictation_stream_error")
          settle(message);
      },
    });
    const format = "audio/pcm;rate=16000;bits=16";
    try {
      const fixture = parsePcm16MonoWav(
        readFileSync(
          new URL("../../../../app/e2e/support/fixtures/recording.wav", import.meta.url),
        ),
      );
      expect(fixture.sampleRate).toBe(16000);
      const audio = Buffer.alloc(25_776_660);
      for (let offset = 0; offset < audio.length; offset += fixture.pcm16.length) {
        fixture.pcm16.copy(audio, offset, 0, Math.min(fixture.pcm16.length, audio.length - offset));
      }
      await manager.handleStart("buffered-recording", format);
      let seq = 0;
      for (let offset = 0; offset < audio.length; offset += 32_000) {
        await manager.handleChunk({
          dictationId: "buffered-recording",
          seq: seq++,
          audioBase64: audio
            .subarray(offset, Math.min(audio.length, offset + 32_000))
            .toString("base64"),
          format,
        });
      }
      expect(seq).toBe(806);
      await manager.handleFinish("buffered-recording", seq - 1);
      const result = await outcome;
      console.log("Local replay outcome", result);
      expect(result.type).toBe("dictation_stream_final");
    } finally {
      manager.cleanupAll();
      worker.shutdown();
    }
  },
  120_000,
);
