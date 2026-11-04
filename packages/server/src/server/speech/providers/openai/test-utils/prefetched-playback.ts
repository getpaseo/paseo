import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import pino from "pino";
import { OpenAITTS } from "../tts.js";
import { TTSManager } from "../../../../agent/tts-manager.js";

if (!global.gc) throw new Error("Run with --expose-gc");

const sentences = ["First sentence.", "Second sentence.", "Third sentence."];
const audio = sentences.map((_, index) => Buffer.alloc(192_000, index + 1));
const requests: string[] = [];
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const { input } = JSON.parse(Buffer.concat(chunks).toString()) as { input: string };
  requests.push(input);
  const body = audio[sentences.indexOf(input)];
  response.writeHead(200, { "Content-Type": "audio/pcm", "Content-Length": body.length });
  response.end(body);
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Missing server address");
const logger = pino({ level: "silent" });
const provider = new OpenAITTS(
  { apiKey: "test", baseUrl: `http://127.0.0.1:${address.port}/v1` },
  logger,
);
const manager = new TTSManager("prefetched-playback", logger, provider);
const emitted: { bytes: number; value: number; format: string }[] = [];

try {
  await manager.generateAndWaitForPlayback(
    sentences.join(" "),
    (message) => {
      if (message.type !== "audio_output") return;
      const buffer = Buffer.from(message.payload.audio, "base64");
      emitted.push({ bytes: buffer.length, value: buffer[0], format: message.payload.format });
      if (emitted.length === 1) {
        // Hold the playback acknowledgement while the other responses are prefetched.
        void (async () => {
          while (requests.length < sentences.length) await delay(10);
          for (let cycle = 0; cycle < 20; cycle++) {
            await delay(25);
            global.gc!();
          }
          manager.confirmAudioPlayed(message.payload.id);
        })();
      } else {
        setImmediate(() => manager.confirmAudioPlayed(message.payload.id));
      }
    },
    new AbortController().signal,
    true,
  );
  console.log(JSON.stringify({ requests, emitted }));
} finally {
  manager.cleanup();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
