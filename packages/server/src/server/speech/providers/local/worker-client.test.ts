import { EventEmitter } from "node:events";
import { once } from "node:events";
import pino from "pino";
import { describe, expect, it } from "vitest";

import {
  LocalSpeechWorkerClient,
  WorkerBackedSpeechToTextProvider,
  WorkerBackedTextToSpeechProvider,
  WorkerBackedTurnDetectionProvider,
} from "./worker-client.js";
import type {
  LocalSpeechWorkerRequest,
  LocalSpeechWorkerToParentMessage,
} from "./worker-protocol.js";

class FakeLocalSpeechWorker extends EventEmitter {
  public connected = true;
  public killed = false;
  public readonly sent: LocalSpeechWorkerRequest[] = [];
  public disconnects = 0;
  public kills = 0;

  send(message: LocalSpeechWorkerRequest, callback: (error: Error | null) => void): boolean {
    this.sent.push(message);
    queueMicrotask(() => callback(null));
    return true;
  }

  disconnect(): void {
    this.disconnects++;
    this.connected = false;
  }

  kill(): boolean {
    this.kills++;
    this.killed = true;
    this.connected = false;
    return true;
  }

  respond(request: LocalSpeechWorkerRequest, result?: unknown): void {
    this.emit("message", {
      type: "response",
      requestId: request.requestId,
      ok: true,
      result,
    } satisfies LocalSpeechWorkerToParentMessage);
  }

  emitWorkerMessage(message: LocalSpeechWorkerToParentMessage): void {
    this.emit("message", message);
  }
}

function createClient(options?: { idleTtlMs?: number }) {
  const workers: FakeLocalSpeechWorker[] = [];
  const client = new LocalSpeechWorkerClient({
    config: {
      modelsDir: "/tmp/models",
      voiceSttModel: "parakeet-tdt-0.6b-v2-int8",
      dictationSttModel: "parakeet-tdt-0.6b-v2-int8",
      voiceTtsModel: "kokoro-en-v0_19",
    },
    requestTimeoutMs: 1000,
    idleTtlMs: options?.idleTtlMs ?? 1000,
    forkWorker: () => {
      const worker = new FakeLocalSpeechWorker();
      workers.push(worker);
      return worker;
    },
  });
  return { client, workers };
}

async function waitForMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("LocalSpeechWorkerClient", () => {
  it("does not spawn the worker until first local speech use", () => {
    const { workers } = createClient();

    expect(workers).toHaveLength(0);
  });

  it("sends TTS requests through the worker and returns the audio stream", async () => {
    const { client, workers } = createClient();
    const provider = new WorkerBackedTextToSpeechProvider(client);

    const pending = provider.synthesizeSpeech("hello");
    expect(workers).toHaveLength(1);
    const request = workers[0].sent[0];
    expect(request).toMatchObject({
      type: "tts.synthesize",
      text: "hello",
      config: {
        modelsDir: "/tmp/models",
        voiceTtsModel: "kokoro-en-v0_19",
      },
    });

    workers[0].respond(request, {
      audio: Buffer.from([1, 2, 3, 4]),
      format: "pcm;rate=24000",
    });

    const result = await pending;
    const chunks: Buffer[] = [];
    for await (const chunk of result.stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    expect(result.format).toBe("pcm;rate=24000");
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it("forwards STT session audio and transcript events through IPC", async () => {
    const { client, workers } = createClient();
    const provider = new WorkerBackedSpeechToTextProvider(client, "voiceStt");
    const session = provider.createSession({ logger: pino({ level: "silent" }) });

    const transcriptPromise = once(session as EventEmitter, "transcript");
    const committedPromise = once(session as EventEmitter, "committed");

    const connect = session.connect();
    const createRequest = workers[0].sent[0];
    expect(createRequest).toMatchObject({ type: "session.create", kind: "voiceStt" });
    workers[0].respond(createRequest, { requiredSampleRate: 16000 });
    await connect;

    session.appendPcm16(Buffer.from([9, 8, 7, 6]));
    await waitForMicrotasks();
    expect(workers[0].sent[1]).toMatchObject({
      type: "session.append",
      sessionId: createRequest.sessionId,
      audio: Buffer.from([9, 8, 7, 6]),
    });

    session.commit();
    await waitForMicrotasks();
    expect(workers[0].sent[2]).toMatchObject({
      type: "session.commit",
      sessionId: createRequest.sessionId,
    });

    workers[0].emitWorkerMessage({
      type: "session.committed",
      sessionId: createRequest.sessionId,
      payload: { segmentId: "seg-1", previousSegmentId: null },
    });
    workers[0].emitWorkerMessage({
      type: "session.transcript",
      sessionId: createRequest.sessionId,
      payload: { segmentId: "seg-1", transcript: "hello", isFinal: true },
    });

    await expect(committedPromise).resolves.toEqual([
      { segmentId: "seg-1", previousSegmentId: null },
    ]);
    await expect(transcriptPromise).resolves.toEqual([
      { segmentId: "seg-1", transcript: "hello", isFinal: true },
    ]);
  });

  it("forwards VAD session events through the shared worker", async () => {
    const { client, workers } = createClient();
    const provider = new WorkerBackedTurnDetectionProvider(client);
    const session = provider.createSession({ logger: pino({ level: "silent" }) });
    const startedPromise = once(session as EventEmitter, "speech_started");
    const stoppedPromise = once(session as EventEmitter, "speech_stopped");

    const connect = session.connect();
    const createRequest = workers[0].sent[0];
    expect(createRequest).toMatchObject({ type: "session.create", kind: "vad" });
    workers[0].respond(createRequest, { requiredSampleRate: 16000 });
    await connect;

    workers[0].emitWorkerMessage({
      type: "session.speech_started",
      sessionId: createRequest.sessionId,
    });
    workers[0].emitWorkerMessage({
      type: "session.speech_stopped",
      sessionId: createRequest.sessionId,
    });

    await expect(startedPromise).resolves.toEqual([]);
    await expect(stoppedPromise).resolves.toEqual([]);
  });

  it("kills an idle worker and respawns on later use", async () => {
    const { client, workers } = createClient({ idleTtlMs: 5 });

    const first = client.synthesizeSpeech("first");
    workers[0].respond(workers[0].sent[0], {
      audio: Buffer.from([1]),
      format: "pcm;rate=24000",
    });
    await first;

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(workers[0].kills).toBe(1);

    const second = client.synthesizeSpeech("second");
    expect(workers).toHaveLength(2);
    workers[1].respond(workers[1].sent[0], {
      audio: Buffer.from([2]),
      format: "pcm;rate=24000",
    });
    await second;
  });
});
