import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { Writable } from "node:stream";
import pino from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createHubcodeDaemon, parseListenString, type HubcodeDaemonConfig } from "./bootstrap.js";
import { createTestHubcodeDaemon } from "./test-utils/hubcode-daemon.js";
import { createTestAgentClients } from "./test-utils/fake-agent-client.js";

describe("hubcode daemon bootstrap", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("starts and serves health endpoint", async () => {
    const daemonHandle = await createTestHubcodeDaemon({
      openai: { apiKey: "test-openai-api-key" },
      speech: {
        providers: {
          dictationStt: { provider: "openai", explicit: true },
          voiceStt: { provider: "openai", explicit: true },
          voiceTts: { provider: "openai", explicit: true },
        },
      },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${daemonHandle.port}/api/health`, {
        headers: daemonHandle.agentMcpAuthHeader
          ? { Authorization: daemonHandle.agentMcpAuthHeader }
          : undefined,
      });
      expect(response.ok).toBe(true);
      const payload = await response.json();
      expect(payload.status).toBe("ok");
      expect(typeof payload.timestamp).toBe("string");
    } finally {
      await daemonHandle.close();
    }
  });

  test("fails fast when OpenAI speech provider is configured without credentials", async () => {
    const hubcodeHomeRoot = await mkdtemp(path.join(os.tmpdir(), "hubcode-openai-config-"));
    const hubcodeHome = path.join(hubcodeHomeRoot, ".hubcode");
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "hubcode-static-"));
    await mkdir(hubcodeHome, { recursive: true });

    const config: HubcodeDaemonConfig = {
      listen: "127.0.0.1:0",
      hubcodeHome,
      corsAllowedOrigins: [],
      allowedHosts: true,
      mcpEnabled: false,
      staticDir,
      mcpDebug: false,
      agentClients: createTestAgentClients(),
      agentStoragePath: path.join(hubcodeHome, "agents"),
      relayEnabled: false,
      appBaseUrl: "https://app.hubcode.ai",
      openai: undefined,
      speech: {
        providers: {
          dictationStt: { provider: "openai", explicit: true },
          voiceStt: { provider: "openai", explicit: true },
          voiceTts: { provider: "openai", explicit: true },
        },
      },
    };

    try {
      await expect(createHubcodeDaemon(config, pino({ level: "silent" }))).rejects.toThrow(
        "Missing OpenAI credentials",
      );
    } finally {
      await rm(hubcodeHomeRoot, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
    }
  });

  test("does not block daemon start on local speech model downloads", async () => {
    const originalFetch = globalThis.fetch;
    let releaseFetch: ((value: Response) => void) | null = null;
    const fetchGate = new Promise<Response>((resolve) => {
      releaseFetch = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => fetchGate),
    );

    const daemonHandle = await createTestHubcodeDaemon({
      speech: {
        providers: {
          dictationStt: { provider: "local", explicit: true, enabled: true },
          voiceTurnDetection: { provider: "local", explicit: true, enabled: false },
          voiceStt: { provider: "local", explicit: true, enabled: false },
          voiceTts: { provider: "local", explicit: true, enabled: false },
        },
        local: {
          modelsDir: path.join(os.tmpdir(), `hubcode-missing-models-${Date.now()}`),
          models: {
            dictationStt: "parakeet-tdt-0.6b-v3-int8",
            voiceStt: "parakeet-tdt-0.6b-v3-int8",
            voiceTts: "kokoro-en-v0_19",
          },
        },
      },
    });

    try {
      const response = await originalFetch(`http://127.0.0.1:${daemonHandle.port}/api/health`);
      expect(response.ok).toBe(true);
    } finally {
      releaseFetch?.(
        new Response(null, {
          status: 500,
          statusText: "test cleanup",
        }),
      );
      await daemonHandle.close();
    }
  });

  test("parses whitespace-padded numeric port strings", () => {
    expect(parseListenString(" 6767 ")).toEqual({
      type: "tcp",
      host: "127.0.0.1",
      port: 6767,
    });
  });

  test("rejects Windows absolute paths that are not named pipes", () => {
    // A Windows drive path like C:\daemon must NOT be silently parsed as TCP
    // (split(":") would yield host="C" and port="\\daemon" which is nonsensical).
    expect(() => parseListenString(String.raw`C:\daemon`)).toThrow();
    expect(() => parseListenString(String.raw`D:\Users\foo\.hubcode\daemon.sock`)).toThrow();
    // Single-letter "host" with no valid port is not a valid listen string
    expect(() => parseListenString(String.raw`C:\some\path`)).toThrow();
  });

  test("parses Windows named pipes as managed IPC listen targets", () => {
    expect(parseListenString(String.raw`\\.\pipe\hubcode-managed-test`)).toEqual({
      type: "pipe",
      path: String.raw`\\.\pipe\hubcode-managed-test`,
    });
    expect(parseListenString(`pipe://${String.raw`\\.\pipe\hubcode-managed-test`}`)).toEqual({
      type: "pipe",
      path: String.raw`\\.\pipe\hubcode-managed-test`,
    });
  });

  test("emits a relay pairing offer for unix socket listeners", async () => {
    const hubcodeHomeRoot = await mkdtemp(path.join(os.tmpdir(), "hubcode-socket-relay-"));
    const hubcodeHome = path.join(hubcodeHomeRoot, ".hubcode");
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "hubcode-static-"));
    const socketPath = path.join(hubcodeHomeRoot, "run", "hubcode.sock");
    await mkdir(path.dirname(socketPath), { recursive: true });
    await mkdir(hubcodeHome, { recursive: true });

    const lines: string[] = [];
    const logger = pino(
      { level: "info" },
      new Writable({
        write(chunk, _encoding, callback) {
          lines.push(chunk.toString("utf8"));
          callback();
        },
      }),
    );

    const config: HubcodeDaemonConfig = {
      listen: socketPath,
      hubcodeHome,
      corsAllowedOrigins: [],
      allowedHosts: true,
      mcpEnabled: false,
      staticDir,
      mcpDebug: false,
      agentClients: createTestAgentClients(),
      agentStoragePath: path.join(hubcodeHome, "agents"),
      relayEnabled: true,
      relayEndpoint: "127.0.0.1:9",
      relayPublicEndpoint: "127.0.0.1:9",
      appBaseUrl: "https://app.hubcode.ai",
      openai: undefined,
      speech: undefined,
    };

    const daemon = await createHubcodeDaemon(config, logger);

    try {
      await daemon.start();
      expect(lines.some((line) => line.includes('"msg":"pairing_offer"'))).toBe(true);
    } finally {
      await daemon.stop().catch(() => undefined);
      await daemon.agentManager.flush().catch(() => undefined);
      await rm(hubcodeHomeRoot, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
    }
  });
});
