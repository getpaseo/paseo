import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

import { parsePcm16MonoWav, wordSimilarity } from "../../../test-utils/dictation-e2e.js";
import { ensureSherpaOnnxModels } from "./sherpa/model-downloader.js";
import { applySherpaLoaderEnv } from "./sherpa/sherpa-runtime-env.js";
import type {
  LocalSpeechWorkerConfig,
  LocalSpeechWorkerRequest,
  LocalSpeechWorkerToParentMessage,
} from "./worker-protocol.js";
import { bufferToWorkerBytes } from "./worker-bytes.js";

const modelsDir =
  process.env.PASEO_LOCAL_MODELS_DIR ?? path.join(homedir(), ".paseo", "models", "local-speech");
const shouldDownload = process.env.PASEO_SPEECH_E2E_DOWNLOAD === "1";
const workerSpeechTest = hasParakeetModel(modelsDir) || shouldDownload ? test : test.skip;

function hasParakeetModel(dir: string): boolean {
  return (
    existsSync(path.join(dir, "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8", "encoder.int8.onnx")) &&
    existsSync(path.join(dir, "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8", "tokens.txt"))
  );
}

function fixturePath(fileName: string): string {
  return path.resolve(process.cwd(), "..", "app", "e2e", "fixtures", fileName);
}

function resolveWorkerUrl(): URL {
  const currentUrl = import.meta.url;
  if (currentUrl.endsWith(".ts")) {
    return new URL("./worker-process.ts", currentUrl);
  }
  return new URL("./worker-process.js", currentUrl);
}

function resolveWorkerExecArgv(): string[] {
  if (!import.meta.url.endsWith(".ts")) {
    return [];
  }
  const loaderUrl = new URL("../../../../terminal/terminal-ts-loader.mjs", import.meta.url).href;
  const importSource = [
    'import { register } from "node:module";',
    'import { pathToFileURL } from "node:url";',
    `register(${JSON.stringify(loaderUrl)}, pathToFileURL("./"));`,
  ].join(" ");
  return [
    "--experimental-strip-types",
    "--import",
    `data:text/javascript,${encodeURIComponent(importSource)}`,
  ];
}

function forkWorker(): ChildProcess {
  const env = { ...process.env, PASEO_LOG_LEVEL: "silent" };
  applySherpaLoaderEnv(env);
  const worker = fork(fileURLToPath(resolveWorkerUrl()), [], {
    env,
    execArgv: resolveWorkerExecArgv(),
    serialization: "advanced",
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  worker.setMaxListeners(100);
  return worker;
}

workerSpeechTest(
  "transcribes PCM through the real local speech worker process",
  async () => {
    if (!hasParakeetModel(modelsDir)) {
      await ensureSherpaOnnxModels({
        modelsDir,
        modelIds: ["parakeet-tdt-0.6b-v2-int8"],
      });
    }

    const worker = forkWorker();
    let stderr = "";
    worker.stderr?.on("data", (chunk) => {
      stderr += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    });

    const messages: LocalSpeechWorkerToParentMessage[] = [];
    worker.on("message", (message: LocalSpeechWorkerToParentMessage) => {
      messages.push(message);
    });

    try {
      const config: LocalSpeechWorkerConfig = {
        modelsDir,
        voiceSttModel: "parakeet-tdt-0.6b-v2-int8",
        dictationSttModel: "parakeet-tdt-0.6b-v2-int8",
        voiceTtsModel: "kokoro-en-v0_19",
      };
      const sessionId = randomUUID();

      await sendRequest(
        worker,
        messages,
        {
          type: "session.create",
          config,
          sessionId,
          kind: "dictationStt",
        },
        () => stderr,
      );

      const wav = await readFile(fixturePath("recording.wav"));
      const { sampleRate, pcm16 } = parsePcm16MonoWav(wav);
      expect(sampleRate).toBe(16000);

      const chunkBytes = 3200;
      const appendPromises: Promise<unknown>[] = [];
      for (let offset = 0; offset < pcm16.length; offset += chunkBytes) {
        const audio = pcm16.subarray(offset, Math.min(pcm16.length, offset + chunkBytes));
        appendPromises.push(
          sendRequest(
            worker,
            messages,
            {
              type: "session.append",
              sessionId,
              audio: bufferToWorkerBytes(audio),
            },
            () => stderr,
          ),
        );
      }
      await Promise.all(appendPromises);

      await sendRequest(
        worker,
        messages,
        {
          type: "session.commit",
          sessionId,
        },
        () => stderr,
      );

      const finalTranscript = await waitForFinalTranscript(worker, messages, sessionId, stderr);
      const baseline = await readFile(fixturePath("recording.baseline.txt"), "utf8");
      expect(wordSimilarity(finalTranscript, baseline)).toBeGreaterThan(0.45);
    } finally {
      if (worker.connected) {
        worker.disconnect();
      }
      if (!worker.killed) {
        worker.kill();
      }
    }
  },
  120_000,
);

type RequestInput = LocalSpeechWorkerRequest extends infer Request
  ? Request extends LocalSpeechWorkerRequest
    ? Omit<Request, "requestId">
    : never
  : never;

async function sendRequest(
  worker: ChildProcess,
  messages: LocalSpeechWorkerToParentMessage[],
  input: RequestInput,
  getStderr: () => string,
): Promise<unknown> {
  const requestId = randomUUID();
  const message = { ...input, requestId } as LocalSpeechWorkerRequest;
  worker.send(message);
  return waitForResponse(worker, messages, requestId, getStderr);
}

function waitForResponse(
  worker: ChildProcess,
  messages: LocalSpeechWorkerToParentMessage[],
  requestId: string,
  getStderr: () => string,
): Promise<unknown> {
  const existing = messages.find(
    (message) => message.type === "response" && message.requestId === requestId,
  );
  if (existing?.type === "response") {
    if (existing.ok) {
      return Promise.resolve(existing.result);
    }
    return Promise.reject(new Error(existing.error));
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for local speech worker response: ${requestId}`));
    }, 30_000);

    const onMessage = (message: LocalSpeechWorkerToParentMessage) => {
      if (message.type !== "response" || message.requestId !== requestId) {
        return;
      }
      cleanup();
      if (message.ok) {
        resolve(message.result);
      } else {
        reject(new Error(message.error));
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `Local speech worker exited before response: code=${code} signal=${signal}\n${getStderr()}`,
        ),
      );
    };

    function cleanup() {
      clearTimeout(timeout);
      worker.off("message", onMessage);
      worker.off("exit", onExit);
    }

    worker.on("message", onMessage);
    worker.once("exit", onExit);
  });
}

function waitForFinalTranscript(
  worker: ChildProcess,
  messages: LocalSpeechWorkerToParentMessage[],
  sessionId: string,
  stderr: string,
): Promise<string> {
  const existing = messages.find(
    (message) =>
      message.type === "session.transcript" &&
      message.sessionId === sessionId &&
      message.payload.isFinal,
  );
  if (existing?.type === "session.transcript") {
    return Promise.resolve(existing.payload.transcript);
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for final transcript. Worker stderr:\n${stderr}`));
    }, 60_000);

    const onMessage = (message: LocalSpeechWorkerToParentMessage) => {
      if (message.type === "session.error" && message.sessionId === sessionId) {
        cleanup();
        reject(new Error(message.error));
        return;
      }
      if (
        message.type !== "session.transcript" ||
        message.sessionId !== sessionId ||
        !message.payload.isFinal
      ) {
        return;
      }
      cleanup();
      resolve(message.payload.transcript);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `Local speech worker exited before final transcript: code=${code} signal=${signal}\n${stderr}`,
        ),
      );
    };

    function cleanup() {
      clearTimeout(timeout);
      worker.off("message", onMessage);
      worker.off("exit", onExit);
    }

    worker.on("message", onMessage);
    worker.once("exit", onExit);
  });
}
