import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { describe, expect, test } from "vitest";

import type { AgentSessionConfig } from "../../agent-sdk-types.js";
import { FakePi } from "../pi/test-utils/fake-pi.js";
import type { PiRuntime } from "../pi/runtime.js";
import { OmpRpcAgentClient } from "./agent.js";

function createClientWithOmpAgentDir(agentDir: string): OmpRpcAgentClient {
  return new OmpRpcAgentClient({
    logger: pino({ level: "silent" }),
    runtime: new FakePi(),
    runtimeSettings: { env: { OMP_CODING_AGENT_DIR: agentDir } },
  });
}

function createConfig(overrides: Partial<AgentSessionConfig> = {}): AgentSessionConfig {
  return {
    provider: "omp",
    cwd: "/tmp/paseo-omp-rpc-test",
    ...overrides,
  };
}

describe("OmpRpcAgentClient", () => {
  test("identifies itself with the omp provider id", () => {
    const client = new OmpRpcAgentClient({
      logger: pino({ level: "silent" }),
      runtime: new FakePi(),
    });
    expect(client.provider).toBe("omp");
  });

  test("creates a session that reports the omp provider", async () => {
    const client = new OmpRpcAgentClient({
      logger: pino({ level: "silent" }),
      runtime: new FakePi(),
    });

    const session = await client.createSession(createConfig());
    expect(session.provider).toBe("omp");
    await session.close();
  });

  test("lists persisted OMP sessions from the configured OMP agent directory", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paseo-omp-client-"));
    const cwd = path.join(root, "workspace");
    const agentDir = path.join(root, "agent");
    const sessionsDir = path.join(agentDir, "sessions", "--workspace--");
    mkdirSync(sessionsDir, { recursive: true });
    const sessionFile = path.join(sessionsDir, "20260101_session.jsonl");
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "omp-session",
          timestamp: "2026-01-01T00:00:00.000Z",
          cwd,
        }),
        JSON.stringify({
          type: "message",
          id: "entry-1",
          parentId: null,
          timestamp: "2026-01-01T00:00:01.000Z",
          message: { role: "user", content: "remember this" },
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    const client = createClientWithOmpAgentDir(agentDir);

    await expect(client.listPersistedAgents({ cwd })).resolves.toMatchObject([
      {
        provider: "omp",
        sessionId: "omp-session",
        cwd,
        persistence: {
          provider: "omp",
          sessionId: "omp-session",
          nativeHandle: sessionFile,
          metadata: { provider: "omp", cwd },
        },
        timeline: [{ type: "user_message", text: "remember this" }],
      },
    ]);
  });

  test("ignores PI_CODING_AGENT_DIR when running as the OMP provider", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paseo-omp-isolation-"));
    const cwd = path.join(root, "workspace");
    const piAgentDir = path.join(root, "pi-agent");
    const ompAgentDir = path.join(root, "omp-agent");
    const piSessionsDir = path.join(piAgentDir, "sessions");
    const ompSessionsDir = path.join(ompAgentDir, "sessions");
    mkdirSync(piSessionsDir, { recursive: true });
    mkdirSync(ompSessionsDir, { recursive: true });

    const sessionRecord = (id: string) =>
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id,
          timestamp: "2026-01-01T00:00:00.000Z",
          cwd,
        }),
        JSON.stringify({
          type: "message",
          id: "entry-1",
          parentId: null,
          timestamp: "2026-01-01T00:00:01.000Z",
          message: { role: "user", content: id },
        }),
      ].join("\n") + "\n";
    writeFileSync(path.join(piSessionsDir, "pi.jsonl"), sessionRecord("pi-only"), "utf8");
    writeFileSync(path.join(ompSessionsDir, "omp.jsonl"), sessionRecord("omp-only"), "utf8");

    const client = new OmpRpcAgentClient({
      logger: pino({ level: "silent" }),
      runtime: new FakePi(),
      runtimeSettings: {
        env: {
          PI_CODING_AGENT_DIR: piAgentDir,
          OMP_CODING_AGENT_DIR: ompAgentDir,
        },
      },
    });

    const descriptors = await client.listPersistedAgents({ cwd });
    expect(descriptors.map((d) => d.sessionId)).toEqual(["omp-only"]);
  });

  test("isAvailable resolves only the binary, without starting an RPC session", async () => {
    const throwingRuntime = {
      startSession() {
        throw new Error("isAvailable must not start an RPC session");
      },
    } as unknown as PiRuntime;
    const client = new OmpRpcAgentClient({
      logger: pino({ level: "silent" }),
      runtime: throwingRuntime,
      runtimeSettings: { command: { mode: "replace", argv: [process.execPath] } },
    });

    await expect(client.isAvailable()).resolves.toBe(true);
  });
});
