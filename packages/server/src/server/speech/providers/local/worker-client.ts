import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import type pino from "pino";

import type {
  SpeechStreamResult,
  SpeechToTextProvider,
  StreamingTranscriptionSession,
  TextToSpeechProvider,
} from "../../speech-provider.js";
import type { TurnDetectionProvider, TurnDetectionSession } from "../../turn-detection-provider.js";
import { applySherpaLoaderEnv } from "./sherpa/sherpa-runtime-env.js";
import type {
  LocalSpeechCreateSessionResult,
  LocalSpeechSessionKind,
  LocalSpeechTranscriptionResult,
  LocalSpeechTtsResult,
  LocalSpeechWorkerConfig,
  LocalSpeechWorkerRequest,
  LocalSpeechWorkerResponse,
  LocalSpeechWorkerToParentMessage,
} from "./worker-protocol.js";
import { bufferToWorkerBytes, workerBytesToBuffer } from "./worker-bytes.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_IDLE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_LOCAL_SAMPLE_RATE = 16000;
const STDERR_TAIL_MAX_CHARS = 8000;
const USER_ERROR_STDERR_MAX_CHARS = 1000;

type LocalSpeechWorkerRequestInput = LocalSpeechWorkerRequest extends infer Request
  ? Request extends LocalSpeechWorkerRequest
    ? Omit<Request, "requestId">
    : never
  : never;

interface LocalSpeechWorkerProcess {
  connected: boolean;
  killed: boolean;
  pid?: number;
  stderr?: Readable | null;
  send(message: LocalSpeechWorkerRequest, callback: (error: Error | null) => void): boolean;
  disconnect(): void;
  kill(): boolean;
  on(event: "message", listener: (message: LocalSpeechWorkerToParentMessage) => void): this;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  type: LocalSpeechWorkerRequest["type"];
  summary: Record<string, unknown>;
  startedAt: number;
}

interface LocalSpeechWorkerClientOptions {
  config: LocalSpeechWorkerConfig;
  logger: pino.Logger;
  requestTimeoutMs?: number;
  idleTtlMs?: number;
  forkWorker?: () => LocalSpeechWorkerProcess;
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

function forkLocalSpeechWorker(): LocalSpeechWorkerProcess {
  const env = { ...process.env };
  applySherpaLoaderEnv(env);
  return fork(fileURLToPath(resolveWorkerUrl()), [], {
    env,
    execArgv: resolveWorkerExecArgv(),
    serialization: "advanced",
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  }) as LocalSpeechWorkerProcess;
}

function isResponse(
  message: LocalSpeechWorkerToParentMessage,
): message is LocalSpeechWorkerResponse {
  return message.type === "response";
}

function truncateStart(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return value.slice(value.length - maxChars);
}

function summarizeWorkerRequest(message: LocalSpeechWorkerRequest): Record<string, unknown> {
  switch (message.type) {
    case "session.create":
      return { kind: message.kind, sessionId: message.sessionId };
    case "session.append":
      return { sessionId: message.sessionId, audioBytes: message.audio.byteLength };
    case "session.commit":
    case "session.clear":
    case "session.flush":
    case "session.reset":
    case "session.close":
      return { sessionId: message.sessionId };
    case "stt.transcribe":
      return {
        model: message.model,
        audioBytes: message.audio.byteLength,
        format: message.format,
      };
    case "tts.synthesize":
      return { textLength: message.text.length };
  }
}

function formatExitStatus(code: number | null, signal: NodeJS.Signals | null): string {
  const parts: string[] = [];
  if (code !== null) {
    parts.push(`code ${code}`);
  }
  if (signal) {
    parts.push(`signal ${signal}`);
  }
  return parts.length > 0 ? parts.join(", ") : "unknown exit status";
}

function formatPendingRequestForMessage(request: Record<string, unknown>): string {
  const type = typeof request.type === "string" ? request.type : "unknown request";
  const kind = typeof request.kind === "string" ? ` (${request.kind})` : "";
  return `${type}${kind}`;
}

function buildWorkerExitMessage(params: {
  code: number | null;
  signal: NodeJS.Signals | null;
  pendingRequests: Array<Record<string, unknown>>;
  stderrTail: string;
}): string {
  const pending =
    params.pendingRequests.length > 0
      ? ` while handling ${params.pendingRequests
          .slice(0, 3)
          .map(formatPendingRequestForMessage)
          .join(", ")}`
      : "";
  const stderr = params.stderrTail
    ? ` Last stderr: ${truncateStart(params.stderrTail, USER_ERROR_STDERR_MAX_CHARS)}`
    : " Check daemon.log and macOS DiagnosticReports for Paseo Voice crash details.";
  return `Local speech worker exited (${formatExitStatus(params.code, params.signal)})${pending}.${stderr}`;
}

export class LocalSpeechWorkerClient {
  private readonly config: LocalSpeechWorkerConfig;
  private readonly logger: pino.Logger;
  private readonly requestTimeoutMs: number;
  private readonly idleTtlMs: number;
  private readonly forkWorker: () => LocalSpeechWorkerProcess;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly activeSessionIds = new Set<string>();
  private readonly sessionEmitters = new Map<string, EventEmitter>();
  private worker: LocalSpeechWorkerProcess | null = null;
  private workerPid: number | null = null;
  private stderrTail = "";
  private stderrLineBuffer = "";
  private inFlightRequests = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly intentionalWorkerCloses = new WeakSet<LocalSpeechWorkerProcess>();

  constructor(options: LocalSpeechWorkerClientOptions) {
    this.config = options.config;
    this.logger = options.logger.child({ component: "local-speech-worker-client" });
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.forkWorker = options.forkWorker ?? forkLocalSpeechWorker;
  }

  async synthesizeSpeech(text: string): Promise<SpeechStreamResult> {
    const result = await this.sendRequest<LocalSpeechTtsResult>({
      type: "tts.synthesize",
      config: this.config,
      text,
    });
    return {
      stream: Readable.from([workerBytesToBuffer(result.audio)]),
      format: result.format,
    };
  }

  transcribeVoice(audio: Buffer, format: string): Promise<LocalSpeechTranscriptionResult> {
    return this.sendRequest<LocalSpeechTranscriptionResult>({
      type: "stt.transcribe",
      config: this.config,
      model: "voice",
      audio: bufferToWorkerBytes(audio),
      format,
    });
  }

  async createSession(
    kind: LocalSpeechSessionKind,
    emitter: EventEmitter,
  ): Promise<{ sessionId: string; requiredSampleRate: number }> {
    const sessionId = randomUUID();
    this.activeSessionIds.add(sessionId);
    this.sessionEmitters.set(sessionId, emitter);
    try {
      const result = await this.sendRequest<LocalSpeechCreateSessionResult>({
        type: "session.create",
        config: this.config,
        sessionId,
        kind,
      });
      return { sessionId, requiredSampleRate: result.requiredSampleRate };
    } catch (err) {
      this.activeSessionIds.delete(sessionId);
      this.sessionEmitters.delete(sessionId);
      this.scheduleIdleShutdownIfReady();
      throw err;
    }
  }

  appendSessionAudio(sessionId: string, audio: Buffer): void {
    void this.sendRequest({
      type: "session.append",
      sessionId,
      audio: bufferToWorkerBytes(audio),
    }).catch((err) => {
      this.emitSessionError(sessionId, err);
    });
  }

  commitSession(sessionId: string): void {
    void this.sendRequest({ type: "session.commit", sessionId }).catch((err) => {
      this.emitSessionError(sessionId, err);
    });
  }

  clearSession(sessionId: string): void {
    void this.sendRequest({ type: "session.clear", sessionId }).catch((err) => {
      this.emitSessionError(sessionId, err);
    });
  }

  flushSession(sessionId: string): void {
    void this.sendRequest({ type: "session.flush", sessionId }).catch((err) => {
      this.emitSessionError(sessionId, err);
    });
  }

  resetSession(sessionId: string): void {
    void this.sendRequest({ type: "session.reset", sessionId }).catch((err) => {
      this.emitSessionError(sessionId, err);
    });
  }

  closeSession(sessionId: string): void {
    this.activeSessionIds.delete(sessionId);
    this.sessionEmitters.delete(sessionId);
    void this.sendRequest({ type: "session.close", sessionId }).catch(() => {
      // Closing is best-effort; the parent already dropped the session.
    });
    this.scheduleIdleShutdownIfReady();
  }

  shutdown(): void {
    this.clearIdleTimer();
    this.rejectAllPending(new Error("Local speech worker shut down"));
    this.activeSessionIds.clear();
    this.sessionEmitters.clear();
    const worker = this.worker;
    this.worker = null;
    this.workerPid = null;
    if (worker && !worker.killed) {
      this.intentionalWorkerCloses.add(worker);
      try {
        worker.disconnect();
      } catch {
        // ignore
      }
      try {
        worker.kill();
      } catch {
        // ignore
      }
    }
  }

  private sendRequest<T = void>(input: LocalSpeechWorkerRequestInput): Promise<T> {
    const worker = this.ensureWorker();
    const requestId = randomUUID();
    const message = { ...input, requestId } as LocalSpeechWorkerRequest;
    const requestSummary = summarizeWorkerRequest(message);
    this.inFlightRequests++;
    this.clearIdleTimer();

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        this.inFlightRequests = Math.max(0, this.inFlightRequests - 1);
        this.scheduleIdleShutdownIfReady();
        reject(new Error(`Local speech worker request timed out: ${input.type}`));
      }, this.requestTimeoutMs);
      this.pendingRequests.set(requestId, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
        type: message.type,
        summary: requestSummary,
        startedAt: Date.now(),
      });

      worker.send(message, (error) => {
        if (!error) {
          return;
        }
        const pending = this.pendingRequests.get(requestId);
        if (!pending) {
          return;
        }
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(requestId);
        this.inFlightRequests = Math.max(0, this.inFlightRequests - 1);
        this.scheduleIdleShutdownIfReady();
        pending.reject(error);
      });
    });
  }

  private ensureWorker(): LocalSpeechWorkerProcess {
    if (this.worker && !this.worker.killed && this.worker.connected) {
      return this.worker;
    }
    const worker = this.forkWorker();
    this.worker = worker;
    this.workerPid = worker.pid ?? null;
    this.stderrTail = "";
    this.stderrLineBuffer = "";
    this.logger.info(
      {
        workerPid: this.workerPid,
        modelsDir: this.config.modelsDir,
        voiceSttModel: this.config.voiceSttModel,
        dictationSttModel: this.config.dictationSttModel,
        voiceTtsModel: this.config.voiceTtsModel,
      },
      "Local speech worker spawned",
    );
    worker.stderr?.on("data", (chunk: Buffer | string) => this.handleWorkerStderr(chunk));
    worker.on("message", (message) => this.handleWorkerMessage(message));
    worker.on("close", (code, signal) => this.handleWorkerExit(worker, code, signal));
    return worker;
  }

  private handleWorkerStderr(chunk: Buffer | string): void {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    this.stderrTail = truncateStart(this.stderrTail + text, STDERR_TAIL_MAX_CHARS);

    this.stderrLineBuffer += text;
    const lines = this.stderrLineBuffer.split(/\r?\n/);
    this.stderrLineBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      this.logger.warn(
        { workerPid: this.workerPid, stderr: trimmed },
        "Local speech worker stderr",
      );
    }
  }

  private handleWorkerMessage(message: LocalSpeechWorkerToParentMessage): void {
    if (isResponse(message)) {
      const pending = this.pendingRequests.get(message.requestId);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(message.requestId);
      this.inFlightRequests = Math.max(0, this.inFlightRequests - 1);
      this.scheduleIdleShutdownIfReady();
      if (message.ok) {
        pending.resolve(message.result);
      } else {
        pending.reject(new Error(message.error));
      }
      return;
    }

    const emitter = this.sessionEmitters.get(message.sessionId);
    if (!emitter) {
      return;
    }
    switch (message.type) {
      case "session.committed":
        emitter.emit("committed", message.payload);
        return;
      case "session.transcript":
        emitter.emit("transcript", message.payload);
        return;
      case "session.speech_started":
        emitter.emit("speech_started");
        return;
      case "session.speech_stopped":
        emitter.emit("speech_stopped");
        return;
      case "session.error":
        emitter.emit("error", new Error(message.error));
        return;
    }
  }

  private handleWorkerExit(
    worker: LocalSpeechWorkerProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    const wasCurrentWorker = this.worker === worker;
    const wasIntentionalClose = this.intentionalWorkerCloses.has(worker);
    this.intentionalWorkerCloses.delete(worker);
    const workerPid = worker.pid ?? (wasCurrentWorker ? this.workerPid : null);
    const pendingRequests = this.describePendingRequests();
    const activeSessionCount = this.activeSessionIds.size;
    const stderrTail = this.getStderrTail();

    if (wasIntentionalClose) {
      this.logger.info(
        {
          workerPid,
          code,
          signal,
          pendingRequests,
          activeSessionCount,
          stderrTail: stderrTail || null,
        },
        "Local speech worker closed after shutdown",
      );
      if (wasCurrentWorker) {
        this.worker = null;
        this.workerPid = null;
      }
      return;
    }

    if (!wasCurrentWorker) {
      this.logger.warn(
        {
          workerPid,
          code,
          signal,
          pendingRequests,
          activeSessionCount,
          stderrTail: stderrTail || null,
        },
        "Stale local speech worker closed",
      );
      return;
    }

    const error = new Error(
      buildWorkerExitMessage({
        code,
        signal,
        pendingRequests,
        stderrTail,
      }),
    );

    this.logger.error(
      {
        err: error,
        workerPid,
        code,
        signal,
        pendingRequests,
        activeSessionCount,
        stderrTail: stderrTail || null,
      },
      "Local speech worker exited",
    );

    if (wasCurrentWorker) {
      this.worker = null;
      this.workerPid = null;
    }
    this.clearIdleTimer();
    this.rejectAllPending(error);
    for (const [sessionId, emitter] of this.sessionEmitters) {
      if (this.activeSessionIds.has(sessionId)) {
        this.emitErrorIfObserved(sessionId, emitter, error, workerPid);
      }
    }
    this.activeSessionIds.clear();
    this.sessionEmitters.clear();
    this.inFlightRequests = 0;
  }

  private describePendingRequests(): Array<Record<string, unknown>> {
    const now = Date.now();
    return Array.from(this.pendingRequests.entries()).map(([requestId, request]) =>
      Object.assign(
        {
          requestId,
          type: request.type,
          ageMs: Math.max(0, now - request.startedAt),
        },
        request.summary,
      ),
    );
  }

  private getStderrTail(): string {
    return truncateStart(this.stderrTail.trim(), STDERR_TAIL_MAX_CHARS);
  }

  private rejectAllPending(error: Error): void {
    for (const [requestId, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pendingRequests.delete(requestId);
    }
  }

  private emitSessionError(sessionId: string, error: unknown): void {
    const emitter = this.sessionEmitters.get(sessionId);
    if (!emitter) {
      return;
    }
    this.emitErrorIfObserved(
      sessionId,
      emitter,
      error instanceof Error ? error : new Error(String(error)),
    );
  }

  private emitErrorIfObserved(
    sessionId: string,
    emitter: EventEmitter,
    error: Error,
    workerPid: number | null = this.workerPid,
  ): void {
    if (emitter.listenerCount("error") > 0) {
      emitter.emit("error", error);
      return;
    }
    this.logger.warn(
      { err: error, workerPid, sessionId },
      "Local speech worker session error had no listener",
    );
  }

  private scheduleIdleShutdownIfReady(): void {
    if (!this.worker || this.inFlightRequests > 0 || this.activeSessionIds.size > 0) {
      return;
    }
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      if (this.inFlightRequests === 0 && this.activeSessionIds.size === 0) {
        this.shutdown();
      }
    }, this.idleTtlMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}

export class WorkerBackedTextToSpeechProvider implements TextToSpeechProvider {
  constructor(private readonly client: LocalSpeechWorkerClient) {}

  synthesizeSpeech(text: string): Promise<SpeechStreamResult> {
    return this.client.synthesizeSpeech(text);
  }
}

export class WorkerBackedSpeechToTextProvider implements SpeechToTextProvider {
  public readonly id = "local" as const;

  constructor(
    private readonly client: LocalSpeechWorkerClient,
    private readonly kind: Extract<LocalSpeechSessionKind, "voiceStt" | "dictationStt">,
  ) {}

  createSession(_params: {
    logger: pino.Logger;
    language?: string;
    prompt?: string;
  }): StreamingTranscriptionSession {
    return new WorkerBackedTranscriptionSession(this.client, this.kind);
  }
}

export class WorkerBackedTurnDetectionProvider implements TurnDetectionProvider {
  public readonly id = "local" as const;

  constructor(private readonly client: LocalSpeechWorkerClient) {}

  createSession(_params: { logger: pino.Logger }): TurnDetectionSession {
    return new WorkerBackedTurnDetectionSession(this.client);
  }
}

class WorkerBackedTranscriptionSession
  extends EventEmitter
  implements StreamingTranscriptionSession
{
  public requiredSampleRate = DEFAULT_LOCAL_SAMPLE_RATE;
  private connectedSessionId: string | null = null;
  private connecting: Promise<void> | null = null;

  constructor(
    private readonly client: LocalSpeechWorkerClient,
    private readonly kind: Extract<LocalSpeechSessionKind, "voiceStt" | "dictationStt">,
  ) {
    super();
  }

  async connect(): Promise<void> {
    if (this.connectedSessionId) {
      return;
    }
    if (!this.connecting) {
      this.connecting = this.connectRemoteSession();
    }
    await this.connecting;
  }

  private async connectRemoteSession(): Promise<void> {
    try {
      const result = await this.client.createSession(this.kind, this);
      this.connectedSessionId = result.sessionId;
      this.requiredSampleRate = result.requiredSampleRate;
    } finally {
      this.connecting = null;
    }
  }

  appendPcm16(pcm16le: Buffer): void {
    const sessionId = this.connectedSessionId;
    if (!sessionId) {
      this.emit("error", new Error("Local STT session not connected"));
      return;
    }
    this.client.appendSessionAudio(sessionId, pcm16le);
  }

  commit(): void {
    const sessionId = this.connectedSessionId;
    if (!sessionId) {
      this.emit("error", new Error("Local STT session not connected"));
      return;
    }
    this.client.commitSession(sessionId);
  }

  clear(): void {
    const sessionId = this.connectedSessionId;
    if (sessionId) {
      this.client.clearSession(sessionId);
    }
  }

  close(): void {
    const sessionId = this.connectedSessionId;
    this.connectedSessionId = null;
    if (sessionId) {
      this.client.closeSession(sessionId);
    }
  }
}

class WorkerBackedTurnDetectionSession extends EventEmitter implements TurnDetectionSession {
  public requiredSampleRate = DEFAULT_LOCAL_SAMPLE_RATE;
  private connectedSessionId: string | null = null;
  private connecting: Promise<void> | null = null;

  constructor(private readonly client: LocalSpeechWorkerClient) {
    super();
  }

  async connect(): Promise<void> {
    if (this.connectedSessionId) {
      return;
    }
    if (!this.connecting) {
      this.connecting = this.connectRemoteSession();
    }
    await this.connecting;
  }

  private async connectRemoteSession(): Promise<void> {
    try {
      const result = await this.client.createSession("vad", this);
      this.connectedSessionId = result.sessionId;
      this.requiredSampleRate = result.requiredSampleRate;
    } finally {
      this.connecting = null;
    }
  }

  appendPcm16(pcm16le: Buffer): void {
    const sessionId = this.connectedSessionId;
    if (!sessionId) {
      this.emit("error", new Error("Local turn-detection session not connected"));
      return;
    }
    this.client.appendSessionAudio(sessionId, pcm16le);
  }

  flush(): void {
    const sessionId = this.connectedSessionId;
    if (sessionId) {
      this.client.flushSession(sessionId);
    }
  }

  reset(): void {
    const sessionId = this.connectedSessionId;
    if (sessionId) {
      this.client.resetSession(sessionId);
    }
  }

  close(): void {
    const sessionId = this.connectedSessionId;
    this.connectedSessionId = null;
    if (sessionId) {
      this.client.closeSession(sessionId);
    }
  }
}
