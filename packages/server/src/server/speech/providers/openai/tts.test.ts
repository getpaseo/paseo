import type pino from "pino";
import { ReadableStream } from "node:stream/web";
import pinoLogger from "pino";
import { describe, expect, test } from "vitest";

import {
  OpenAITTS,
  type OpenAITTSAudioClient,
  type OpenAITTSSpeechRequest,
  type OpenAITTSSpeechResponse,
} from "./tts.js";

class FakeOpenAITTSClient implements OpenAITTSAudioClient {
  public readonly speechRequests: OpenAITTSSpeechRequest[] = [];
  public readonly audio: OpenAITTSAudioClient["audio"];
  private readonly speechResponse: OpenAITTSSpeechResponse;

  constructor(speechResponse: OpenAITTSSpeechResponse) {
    this.speechResponse = speechResponse;
    this.audio = {
      speech: {
        create: async (request: OpenAITTSSpeechRequest) => {
          this.speechRequests.push(request);
          return this.speechResponse;
        },
      },
    };
  }
}

function createLogger(): pino.Logger {
  return pinoLogger({ enabled: false });
}

describe("OpenAITTS", () => {
  test("returns a Node stream from the OpenAI web response body", async () => {
    const openaiClient = new FakeOpenAITTSClient({
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Buffer.from("audio"));
          controller.close();
        },
      }),
    });

    const tts = new OpenAITTS({ apiKey: "sk-test" }, createLogger(), { openaiClient });
    const result = await tts.synthesizeSpeech("hello");

    const chunks: Buffer[] = [];
    for await (const chunk of result.stream) {
      chunks.push(Buffer.from(chunk));
    }

    expect(Buffer.concat(chunks).toString()).toBe("audio");
    expect(result.format).toBe("pcm");
    expect(openaiClient.speechRequests).toEqual([
      {
        model: "tts-1",
        voice: "alloy",
        input: "hello",
        response_format: "pcm",
      },
    ]);
  });
});
