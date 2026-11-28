import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { expect, test } from "vitest";
import pino from "pino";
import { OpenAISTT } from "./stt.js";

test.each(["before", "after"])(
  "retains later PCM when stop is %s the first response",
  async (stop) => {
    const uploads: Buffer[] = [];
    const responses: ServerResponse[] = [];
    // A transcription service fake on the SDK's HTTP interface. The SDK, WAV encoding,
    // temporary files, session buffer, and event handling all run unchanged.
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const wav = body.subarray(body.indexOf(Buffer.from("RIFF")));
      uploads.push(wav.subarray(44, 44 + wav.readUInt32LE(40)));
      responses.push(response);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server address");
    const logger = pino({ level: "silent" });
    const session = new OpenAISTT(
      { apiKey: "test", baseUrl: `http://127.0.0.1:${address.port}/v1` },
      logger,
    ).createSession({ logger });
    const transcripts: string[] = [];
    session.on("transcript", (event) => {
      if (event.isFinal) transcripts.push(event.transcript);
    });
    const finish = (index: number, text: string) => {
      responses[index]!.writeHead(200, { "Content-Type": "application/json" });
      responses[index]!.end(JSON.stringify({ text }));
    };
    try {
      await session.connect();
      session.appendPcm16(Buffer.from([1, 0, 2, 0]));
      session.commit();
      await expect.poll(() => uploads.length).toBe(1);
      session.appendPcm16(Buffer.from([3, 0, 4, 0]));
      if (stop === "after") {
        finish(0, "first");
        await expect.poll(() => transcripts.length).toBe(1);
      }
      session.commit();
      await expect.poll(() => uploads.length, { timeout: 1000 }).toBe(2);
      expect(uploads.map((pcm) => Array.from(pcm))).toEqual([
        [1, 0, 2, 0],
        [3, 0, 4, 0],
      ]);
      if (stop === "before") finish(0, "first");
      finish(1, "second");
      await expect.poll(() => transcripts.length).toBe(2);
    } finally {
      session.close();
      for (const response of responses)
        if (!response.writableEnded) response.end(JSON.stringify({ text: "" }));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
