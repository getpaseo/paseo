import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  BinaryMuxChannel,
  TerminalBinaryMessageType,
  asUint8Array,
  decodeBinaryMuxFrame,
  encodeBinaryMuxFrame,
} from "../shared/binary-mux.js";

const wsModuleMock = vi.hoisted(() => {
  class MockWebSocketServer {
    static instances: MockWebSocketServer[] = [];
    readonly handlers = new Map<string, (...args: any[]) => void>();

    constructor(_options: unknown) {
      MockWebSocketServer.instances.push(this);
    }

    on(event: string, handler: (...args: any[]) => void) {
      this.handlers.set(event, handler);
      return this;
    }

    close() {
      // no-op
    }
  }

  return { MockWebSocketServer };
});

const sessionMock = vi.hoisted(() => {
  const instances: MockSession[] = [];

  class MockSession {
    cleanup = vi.fn(async () => {});
    handleMessage = vi.fn(async () => {});
    handleBinaryFrame = vi.fn((_frame: unknown) => {});
    getClientActivity = vi.fn(() => null);
    readonly args: Record<string, unknown>;

    constructor(args: Record<string, unknown>) {
      this.args = args;
      instances.push(this);
    }
  }

  return { MockSession, instances };
});

vi.mock("ws", () => ({
  WebSocketServer: wsModuleMock.MockWebSocketServer,
}));

vi.mock("./session.js", () => ({
  Session: sessionMock.MockSession,
}));

vi.mock("./push/token-store.js", () => ({
  PushTokenStore: class {
    getAllTokens(): string[] {
      return [];
    }
  },
}));

vi.mock("./push/push-service.js", () => ({
  PushService: class {
    async sendPush(): Promise<void> {
      // no-op
    }
  },
}));

import {
  VoiceAssistantWebSocketServer,
  type ExternalSocketMetadata,
} from "./websocket-server";
import { parseServerInfoStatusPayload } from "./messages.js";
import type { SpeechReadinessSnapshot } from "./speech/speech-runtime.js";

const TEST_DAEMON_VERSION = "1.2.3-test";

class MockSocket {
  readyState = 1;
  sent: unknown[] = [];
  private listeners = new Map<string, Array<(...args: any[]) => void>>();

  on(event: "message" | "close" | "error", listener: (...args: any[]) => void): void {
    const handlers = this.listeners.get(event) ?? [];
    handlers.push(listener);
    this.listeners.set(event, handlers);
  }

  once(event: "close" | "error", listener: (...args: any[]) => void): void {
    const wrapped = (...args: any[]) => {
      this.off(event, wrapped);
      listener(...args);
    };
    this.on(event, wrapped);
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.emit("close", code ?? 1000, reason ?? "");
  }

  emit(event: "message" | "close" | "error", ...args: any[]): void {
    const handlers = this.listeners.get(event) ?? [];
    for (const handler of [...handlers]) {
      handler(...args);
    }
  }

  private off(event: "close" | "error", listener: (...args: any[]) => void): void {
    const handlers = this.listeners.get(event) ?? [];
    this.listeners.set(
      event,
      handlers.filter((handler) => handler !== listener)
    );
  }
}

function createLogger() {
  const logger = {
    child: vi.fn(() => logger),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger;
}

function createServer(options?: { speechReadiness?: SpeechReadinessSnapshot | null }) {
  const speechReadiness = options?.speechReadiness ?? null;
  return new VoiceAssistantWebSocketServer(
    {} as any,
    createLogger() as any,
    "srv_test",
    {
      setAgentAttentionCallback: vi.fn(),
      getAgent: vi.fn(() => null),
    } as any,
    {} as any,
    {} as any,
    "/tmp/paseo-test",
    async () => ({} as any),
    { allowedOrigins: new Set() },
    undefined,
    undefined,
    undefined,
    speechReadiness
      ? {
          getSpeechReadiness: () => speechReadiness,
        }
      : undefined,
    undefined,
    TEST_DAEMON_VERSION
  );
}

function createReadySpeechReadinessSnapshot(): SpeechReadinessSnapshot {
  return {
    generatedAt: "2026-02-14T00:00:00.000Z",
    requiredLocalModelIds: [],
    missingLocalModelIds: [],
    download: {
      inProgress: false,
      error: null,
    },
    dictation: {
      enabled: true,
      available: true,
      reasonCode: "ready",
      message: "Dictation is ready.",
      retryable: false,
      missingModelIds: [],
    },
    realtimeVoice: {
      enabled: true,
      available: true,
      reasonCode: "ready",
      message: "Realtime voice is ready.",
      retryable: false,
      missingModelIds: [],
    },
    voiceFeature: {
      enabled: true,
      available: true,
      reasonCode: "ready",
      message: "Voice features are ready.",
      retryable: false,
      missingModelIds: [],
    },
  };
}

function createDownloadInProgressSpeechReadinessSnapshot(): SpeechReadinessSnapshot {
  return {
    generatedAt: "2026-02-14T00:00:00.000Z",
    requiredLocalModelIds: [
      "sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20",
    ],
    missingLocalModelIds: [
      "sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20",
    ],
    download: {
      inProgress: true,
      error: null,
    },
    dictation: {
      enabled: true,
      available: false,
      reasonCode: "stt_unavailable",
      message: "Dictation is unavailable: speech-to-text service is not ready.",
      retryable: false,
      missingModelIds: [],
    },
    realtimeVoice: {
      enabled: true,
      available: false,
      reasonCode: "stt_unavailable",
      message: "Realtime voice is unavailable: speech-to-text service is not ready.",
      retryable: false,
      missingModelIds: [],
    },
    voiceFeature: {
      enabled: true,
      available: false,
      reasonCode: "model_download_in_progress",
      message:
        "Voice features are unavailable while models download in the background (sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20).",
      retryable: true,
      missingModelIds: ["sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20"],
    },
  };
}

describe("relay external socket reconnect behavior", () => {
  beforeEach(() => {
    sessionMock.instances.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("keeps the same session when relay reconnects within grace window", async () => {
    const server = createServer();
    const metadata: ExternalSocketMetadata = {
      transport: "relay",
      externalSessionKey: "relay:client-1",
    };

    const socket1 = new MockSocket();
    await server.attachExternalSocket(socket1, metadata);
    expect(sessionMock.instances).toHaveLength(1);
    const session = sessionMock.instances[0]!;

    socket1.emit("close", 1006, "");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(session.cleanup).not.toHaveBeenCalled();

    const socket2 = new MockSocket();
    await server.attachExternalSocket(socket2, metadata);
    expect(sessionMock.instances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(session.cleanup).not.toHaveBeenCalled();

    await server.close();
  });

  test("cleans up relay session when reconnect grace expires", async () => {
    const server = createServer();
    const metadata: ExternalSocketMetadata = {
      transport: "relay",
      externalSessionKey: "relay:client-2",
    };

    const socket1 = new MockSocket();
    await server.attachExternalSocket(socket1, metadata);
    expect(sessionMock.instances).toHaveLength(1);
    const session = sessionMock.instances[0]!;

    socket1.emit("close", 1006, "");
    await vi.advanceTimersByTimeAsync(90_000);
    expect(session.cleanup).toHaveBeenCalledTimes(1);

    await server.close();
  });

  test("includes voice capabilities in server_info when speech readiness exists", async () => {
    const speechReadiness = createReadySpeechReadinessSnapshot();
    const server = createServer({ speechReadiness });
    const metadata: ExternalSocketMetadata = {
      transport: "relay",
      externalSessionKey: "relay:client-server-info-capabilities",
    };

    const socket = new MockSocket();
    await server.attachExternalSocket(socket, metadata);

    expect(socket.sent).toHaveLength(1);
    expect(typeof socket.sent[0]).toBe("string");
    const envelope = JSON.parse(socket.sent[0] as string) as {
      type?: unknown;
      message?: {
        type?: unknown;
        payload?: unknown;
      };
    };
    expect(envelope.type).toBe("session");
    expect(envelope.message?.type).toBe("status");

    const payload = parseServerInfoStatusPayload(envelope.message?.payload);
    expect(payload?.status).toBe("server_info");
    expect(payload?.version).toBe(TEST_DAEMON_VERSION);
    expect(payload?.capabilities?.voice?.dictation.enabled).toBe(
      speechReadiness.dictation.enabled
    );
    expect(payload?.capabilities?.voice?.dictation.reason).toBe("");
    expect(payload?.capabilities?.voice?.voice.enabled).toBe(
      speechReadiness.realtimeVoice.enabled
    );
    expect(payload?.capabilities?.voice?.voice.reason).toBe("");

    await server.close();
  });

  test("broadcasts updated server_info when capabilities change", async () => {
    const server = createServer();
    const metadata: ExternalSocketMetadata = {
      transport: "relay",
      externalSessionKey: "relay:client-server-info-broadcast",
    };

    const socket = new MockSocket();
    await server.attachExternalSocket(socket, metadata);
    expect(socket.sent).toHaveLength(1);

    const speechReadiness = createReadySpeechReadinessSnapshot();
    server.publishSpeechReadiness(speechReadiness);
    expect(socket.sent).toHaveLength(2);

    const secondEnvelope = JSON.parse(socket.sent[1] as string) as {
      message?: { payload?: unknown };
    };
    const secondPayload = parseServerInfoStatusPayload(secondEnvelope.message?.payload);
    expect(secondPayload?.capabilities?.voice?.dictation.enabled).toBe(true);
    expect(secondPayload?.capabilities?.voice?.voice.enabled).toBe(true);

    // Same readiness should not produce another server_info broadcast.
    server.publishSpeechReadiness(speechReadiness);
    expect(socket.sent).toHaveLength(2);

    await server.close();
  });

  test("includes temporary retry guidance while models are downloading", async () => {
    const server = createServer();
    const metadata: ExternalSocketMetadata = {
      transport: "relay",
      externalSessionKey: "relay:client-server-info-download-guidance",
    };
    const socket = new MockSocket();
    await server.attachExternalSocket(socket, metadata);
    expect(socket.sent).toHaveLength(1);

    server.publishSpeechReadiness(createDownloadInProgressSpeechReadinessSnapshot());
    expect(socket.sent).toHaveLength(2);

    const envelope = JSON.parse(socket.sent[1] as string) as {
      message?: { payload?: unknown };
    };
    const payload = parseServerInfoStatusPayload(envelope.message?.payload);
    expect(payload?.capabilities?.voice?.dictation.enabled).toBe(true);
    expect(payload?.capabilities?.voice?.voice.enabled).toBe(true);
    expect(payload?.capabilities?.voice?.dictation.reason).toContain(
      "Try again in a few minutes."
    );
    expect(payload?.capabilities?.voice?.voice.reason).toContain(
      "Try again in a few minutes."
    );

    await server.close();
  });

  test("routes inbound binary mux frames to session.handleBinaryFrame", async () => {
    const server = createServer();
    const metadata: ExternalSocketMetadata = {
      transport: "relay",
      externalSessionKey: "relay:client-binary-inbound",
    };

    const socket = new MockSocket();
    await server.attachExternalSocket(socket, metadata);
    expect(sessionMock.instances).toHaveLength(1);
    const session = sessionMock.instances[0]!;

    socket.emit(
      "message",
      Buffer.from(
        encodeBinaryMuxFrame({
          channel: BinaryMuxChannel.Terminal,
          messageType: TerminalBinaryMessageType.InputUtf8,
          streamId: 9,
          offset: 0,
          payload: new TextEncoder().encode("ls\r"),
        })
      )
    );
    await Promise.resolve();

    expect(session.handleBinaryFrame).toHaveBeenCalledTimes(1);
    const frame = session.handleBinaryFrame.mock.calls[0]?.[0] as {
      channel: number;
      messageType: number;
      streamId: number;
      offset: number;
    };
    expect(frame.channel).toBe(BinaryMuxChannel.Terminal);
    expect(frame.messageType).toBe(TerminalBinaryMessageType.InputUtf8);
    expect(frame.streamId).toBe(9);
    expect(frame.offset).toBe(0);

    await server.close();
  });

  test("sends outbound binary mux frames from session over websocket", async () => {
    const server = createServer();
    const metadata: ExternalSocketMetadata = {
      transport: "relay",
      externalSessionKey: "relay:client-binary-outbound",
    };

    const socket = new MockSocket();
    await server.attachExternalSocket(socket, metadata);
    expect(sessionMock.instances).toHaveLength(1);
    const session = sessionMock.instances[0]!;

    const onBinaryMessage = session.args.onBinaryMessage as
      | ((frame: {
          channel: number;
          messageType: number;
          streamId: number;
          offset: number;
          payload?: Uint8Array;
        }) => void)
      | undefined;
    expect(onBinaryMessage).toBeTypeOf("function");

    onBinaryMessage?.({
      channel: BinaryMuxChannel.Terminal,
      messageType: TerminalBinaryMessageType.OutputUtf8,
      streamId: 11,
      offset: 42,
      payload: new TextEncoder().encode("ok"),
    });

    expect(socket.sent).toHaveLength(2);
    const binaryPayload = asUint8Array(socket.sent[1]);
    expect(binaryPayload).not.toBeNull();
    const frame = decodeBinaryMuxFrame(binaryPayload!);
    expect(frame).not.toBeNull();
    expect(frame!.channel).toBe(BinaryMuxChannel.Terminal);
    expect(frame!.messageType).toBe(TerminalBinaryMessageType.OutputUtf8);
    expect(frame!.streamId).toBe(11);
    expect(frame!.offset).toBe(42);
    expect(new TextDecoder().decode(frame!.payload ?? new Uint8Array())).toBe("ok");

    await server.close();
  });
});
