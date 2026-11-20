import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterEach, describe, expect, test } from "vitest";

import { mergeSpeechSettingsPatch } from "../../speech-settings.js";
import { PersistedConfigSchema } from "../../../persisted-config.js";
import type { SpeechToTextProvider } from "../../speech-provider.js";
import { resolveOpenAiSpeechConfig } from "./config.js";
import { initializeOpenAiSpeechServices } from "./runtime.js";
import { OpenAISTT } from "./stt.js";
import { OpenAITTS } from "./tts.js";

describe("initializeOpenAiSpeechServices", () => {
  test("uses REST OpenAI STT for voice and dictation", () => {
    const services = initializeOpenAiSpeechServices({
      providers: {
        dictationStt: { provider: "openai", explicit: true },
        voiceTurnDetection: { provider: "local", explicit: false, enabled: false },
        voiceStt: { provider: "openai", explicit: true },
        voiceTts: { provider: "openai", explicit: true },
      },
      openaiConfig: {
        stt: { apiKey: "sk-test" },
        dictationStt: { apiKey: "sk-test" },
        tts: { apiKey: "sk-test" },
      },
      existing: {
        turnDetectionService: null,
        sttService: null,
        ttsService: null,
        dictationSttService: null,
      },
      logger: pino({ level: "silent" }),
    });

    expect(services.sttService).toBeInstanceOf(OpenAISTT);
    expect(services.dictationSttService).toBeInstanceOf(OpenAISTT);
    expect(services.ttsService).toBeInstanceOf(OpenAITTS);
  });
});

// An OpenAI-compatible transcription endpoint that records the model each request asks for.
async function startTranscriptionServer(): Promise<{
  server: Server;
  baseUrl: string;
  models: string[];
  keys: (string | undefined)[];
  paths: (string | undefined)[];
}> {
  const models: string[] = [];
  const keys: (string | undefined)[] = [];
  const paths: (string | undefined)[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("latin1");
    });
    request.on("end", () => {
      const model = /name="model"\r\n\r\n([^\r]*)/.exec(body)?.[1];
      models.push(model ?? "<none>");
      keys.push(request.headers.authorization);
      paths.push(request.url);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ text: "hello" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}/v1`, models, keys, paths };
}

async function transcribeOnce(stt: SpeechToTextProvider | null): Promise<void> {
  if (!stt) throw new Error("STT service was not created");
  const session = stt.createSession({ logger: pino({ level: "silent" }), language: "en" });
  const transcript = new Promise<void>((resolve, reject) => {
    session.on("transcript", (event) => {
      if (event.isFinal) resolve();
    });
    session.on("error", (error) =>
      reject(error instanceof Error ? error : new Error(String(error))),
    );
  });
  await session.connect();
  session.appendPcm16(Buffer.alloc(3200));
  session.commit();
  await transcript;
  session.close();
}

describe("OpenAI speech-to-text models", () => {
  let server: Server | null = null;

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = null;
  });

  test("dictation and voice mode each transcribe with the model chosen for them", async () => {
    const endpoint = await startTranscriptionServer();
    server = endpoint.server;
    let persisted = PersistedConfigSchema.parse({
      features: {
        dictation: {
          stt: {
            provider: "openai",
            apiKey: "dictation-key",
            baseUrl: `${endpoint.baseUrl}/dictation`,
            model: "gpt-4o-mini-transcribe",
          },
        },
        voiceMode: {
          enabled: true,
          stt: {
            provider: "openai",
            apiKey: "listening-key",
            baseUrl: `${endpoint.baseUrl}/listening`,
            model: "whisper-1",
          },
        },
      },
    });
    persisted = mergeSpeechSettingsPatch(persisted, {
      voiceMode: { stt: { provider: "openai", model: "whisper-1" } },
    });
    const providers = {
      dictationStt: { provider: "openai", explicit: true },
      voiceTurnDetection: { provider: "local", explicit: false, enabled: false },
      voiceStt: { provider: "openai", explicit: true },
      voiceTts: { provider: "local", explicit: false },
    } as const;

    const services = initializeOpenAiSpeechServices({
      providers,
      openaiConfig: resolveOpenAiSpeechConfig({ env: {}, persisted, providers }),
      existing: {
        turnDetectionService: null,
        sttService: null,
        ttsService: null,
        dictationSttService: null,
      },
      logger: pino({ level: "silent" }),
    });
    await transcribeOnce(services.dictationSttService);
    await transcribeOnce(services.sttService);

    expect(endpoint.models).toEqual(["gpt-4o-mini-transcribe", "whisper-1"]);
    expect(endpoint.keys).toEqual(["Bearer dictation-key", "Bearer listening-key"]);
    expect(endpoint.paths).toEqual([
      "/v1/dictation/audio/transcriptions",
      "/v1/listening/audio/transcriptions",
    ]);
  });
});
