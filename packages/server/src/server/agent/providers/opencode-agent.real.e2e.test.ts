import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, request as httpRequest, type ServerResponse } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { AgentStreamEvent } from "../agent-sdk-types.js";
import { OpenCodeAgentClient } from "./opencode-agent.js";
import { OpenCodeServerManager } from "./opencode/server-manager.js";

const MODEL = "openai/gpt-5.4";
const NORMAL_SENTINEL = "PASEO_NORMAL_RECOVERY_SENTINEL_7F31";
const ROOT_SENTINEL = "PASEO_ROOT_RECOVERY_SENTINEL_8C42";
const CHILD_SENTINEL = "PASEO_CHILD_RECOVERY_SENTINEL_5A19";
const PARENT_SENTINEL = "PASEO_PARENT_RECOVERY_SENTINEL_6B20";
const TIMEOUT_MS = 240_000;

describe.sequential("OpenCode real event recovery", () => {
  let harness: Awaited<ReturnType<typeof createRealHarness>>;

  beforeAll(async () => {
    harness = await createRealHarness();
  }, 30_000);

  afterAll(async () => {
    await harness?.close();
  }, 30_000);

  test("removes disposable runtime state when auth setup fails", () => {
    const observed = { runtimeDir: "" };
    expect(() => createDisposableRuntime(failAuthCopy, recordRuntimeDirectory(observed))).toThrow(
      "induced auth copy failure",
    );
    expect(observed.runtimeDir).not.toBe("");
    expect(existsSync(observed.runtimeDir)).toBe(false);
  });

  test("removes disposable runtime state when the creation hook fails", () => {
    const observed = { runtimeDir: "" };
    expect(() => createDisposableRuntime(copyFileSync, failRuntimeCreation(observed))).toThrow(
      "induced runtime creation failure",
    );
    expect(observed.runtimeDir).not.toBe("");
    expect(existsSync(observed.runtimeDir)).toBe(false);
  });

  test(
    "normal foreground completes once",
    async () => {
      const result = await harness.runScenario(
        "normal",
        `Respond with exactly ${NORMAL_SENTINEL} and no other text.`,
      );

      assertParentResult(result.events, NORMAL_SENTINEL);
      harness.writeSummary("normal", summarize(result));
    },
    TIMEOUT_MS,
  );

  test(
    "recovers a root turn after cutting the active global event stream",
    async () => {
      const result = await harness.runScenario(
        "root-recovery",
        [
          "You must use the bash tool exactly once to run: sleep 4",
          `After the tool completes, respond with exactly ${ROOT_SENTINEL} and no other text.`,
        ].join("\n"),
        (event) => isRunningToolEvent(event),
      );

      assertParentResult(result.events, ROOT_SENTINEL);
      expect(result.activeCutTrigger).toBe(true);
      expect(result.pidAfter).toBe(result.pidBefore);
      expect(result.cuts).toBe(1);
      expect(result.connectionsAfter - result.connectionsBefore).toBe(1);
      harness.writeSummary("root-recovery", summarize(result));
    },
    TIMEOUT_MS,
  );

  test(
    "recovers an active delegated child and its parent once",
    async () => {
      const result = await harness.runScenario(
        "child-recovery",
        [
          "You must delegate this work using the task tool with subagent type general.",
          `Tell the child to use bash to run sleep 4, then return exactly ${CHILD_SENTINEL}.`,
          `After the child finishes, respond with exactly ${PARENT_SENTINEL} and no other text.`,
        ].join("\n"),
        (event) => isRunningChildEvent(event),
      );

      assertParentResult(result.events, PARENT_SENTINEL, true);
      expect(result.activeCutTrigger).toBe(true);
      expect(result.pidAfter).toBe(result.pidBefore);
      expect(result.cuts).toBe(1);
      expect(result.connectionsAfter - result.connectionsBefore).toBe(1);
      const childOutput = result.events
        .flatMap((event) => {
          if (
            event.type !== "provider_subagent" ||
            event.event.type !== "timeline" ||
            event.event.item.type !== "assistant_message"
          ) {
            return [];
          }
          return [event.event.item.text];
        })
        .join("");
      expect(childOutput.trim()).toBe(CHILD_SENTINEL);
      expect(childOutput.split(CHILD_SENTINEL)).toHaveLength(2);
      expect(
        result.events.filter(
          (event) =>
            event.type === "provider_subagent" &&
            event.event.type === "upsert" &&
            event.event.status === "completed",
        ),
      ).toHaveLength(1);
      expect(result.events.some((event) => event.type === "provider_subagent")).toBe(true);
      harness.writeSummary("child-recovery", summarize(result));
    },
    TIMEOUT_MS,
  );
});

async function createRealHarness() {
  const artifactDir = mkdtempSync(path.join(os.tmpdir(), "paseo-opencode-recovery-"));
  const runtime = createDisposableRuntime();
  const { runtimeDir, home, paseoHome, xdgConfig, xdgData, xdgCache, xdgState, workspace } =
    runtime;

  let setupManager: OpenCodeServerManager | null = null;
  let setupProxy: Awaited<ReturnType<typeof createCutProxy>> | null = null;
  try {
    const upstreamPort = await reservePort();
    const proxy = await createCutProxy(upstreamPort, path.join(artifactDir, "proxy.jsonl"));
    setupProxy = proxy;
    const isolatedEnv = {
      ...process.env,
      HOME: home,
      PASEO_HOME: paseoHome,
      XDG_CONFIG_HOME: xdgConfig,
      XDG_DATA_HOME: xdgData,
      XDG_CACHE_HOME: xdgCache,
      XDG_STATE_HOME: xdgState,
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_AUTO_UPDATE: "1",
    };
    const openCodeVersion = execFileSync("opencode", ["--version"], {
      env: isolatedEnv,
      encoding: "utf8",
    }).trim();
    expect(openCodeVersion).toBe("1.14.33");
    const selectedModels = new Set<string>();
    let child: ChildProcess | null = null;
    const manager = new OpenCodeServerManager({
      logger: pino({ level: "silent" }),
      portAllocator: async () => proxy.port,
      resolveCommandPrefix: async () => ({ command: "opencode", args: [] }),
      resolveHomeDir: () => home,
      spawnServerProcess: () => {
        child = spawn("opencode", ["serve", "--port", String(upstreamPort)], {
          cwd: workspace,
          env: isolatedEnv,
          stdio: ["ignore", "pipe", "pipe"],
        });
        child.stdout?.pipe(createWriteStream(path.join(artifactDir, "opencode.stdout.log")));
        child.stderr?.pipe(createWriteStream(path.join(artifactDir, "opencode.stderr.log")));
        return child;
      },
    });
    setupManager = manager;
    const lease = await manager.acquireCurrent();
    const client = new OpenCodeAgentClient(pino({ level: "silent" }), undefined, {
      serverManager: manager,
    });

    return {
      artifactDir,
      manager,
      proxy,
      writeSummary(name: string, summary: unknown) {
        writeFileSync(
          path.join(artifactDir, `${name}.summary.json`),
          JSON.stringify(summary, null, 2),
        );
      },
      async runScenario(
        name: string,
        prompt: string,
        cutWhen?: (event: AgentStreamEvent) => boolean,
      ) {
        const sessionConfig = {
          provider: "opencode",
          cwd: workspace,
          model: MODEL,
          modeId: "build",
          featureValues: { auto_accept: true },
        } as const;
        selectedModels.add(sessionConfig.model);
        const session = await client.createSession(sessionConfig);
        const events: AgentStreamEvent[] = [];
        const eventPath = path.join(artifactDir, `${name}.events.jsonl`);
        const pidBefore = child?.pid;
        const connectionsBefore = proxy.connections;
        const cutsBefore = proxy.cuts;
        let activeCutTrigger = false;
        session.subscribe((event) => {
          events.push(event);
          writeFileSync(eventPath, `${JSON.stringify(event)}\n`, { flag: "a" });
          if (!activeCutTrigger && cutWhen?.(event)) {
            activeCutTrigger = true;
            proxy.cutActiveGlobalEvent();
          }
        });
        try {
          await session.startTurn(prompt);
          await waitForTerminal(events, TIMEOUT_MS - 10_000);
          return {
            events,
            activeCutTrigger,
            pidBefore,
            pidAfter: child?.pid,
            cuts: proxy.cuts - cutsBefore,
            connectionsBefore,
            connectionsAfter: proxy.connections,
          };
        } finally {
          await session.close().catch(() => undefined);
        }
      },
      async close() {
        try {
          await lease.release().catch(() => undefined);
          await manager.shutdown().catch(() => undefined);
          await proxy.close();
          writeFileSync(
            path.join(artifactDir, "run.summary.json"),
            JSON.stringify(
              { pid: child?.pid, cuts: proxy.cuts, connections: proxy.connections },
              null,
              2,
            ),
          );
          writeFileSync(
            path.join(artifactDir, "run-metadata.summary.json"),
            JSON.stringify(
              {
                openCodeVersion,
                models: [...selectedModels],
                pid: child?.pid,
                scenarios: ["normal", "root-recovery", "child-recovery"],
              },
              null,
              2,
            ),
          );
        } finally {
          rmSync(runtimeDir, { recursive: true, force: true });
        }
        const credentialScan = scanRetainedArtifacts(artifactDir);
        writeFileSync(
          path.join(artifactDir, "credential-scan.summary.json"),
          JSON.stringify(credentialScan, null, 2),
        );
        expect(credentialScan.credentialPatternFiles).toBe(0);
      },
    };
  } catch (error) {
    await setupManager?.shutdown().catch(() => undefined);
    await setupProxy?.close().catch(() => undefined);
    rmSync(runtimeDir, { recursive: true, force: true });
    throw error;
  }
}

function createDisposableRuntime(
  copyAuth: typeof copyFileSync = copyFileSync,
  onCreate?: (runtimeDir: string) => void,
) {
  let runtimeDir: string | null = null;
  try {
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), "paseo-opencode-runtime-"));
    onCreate?.(runtimeDir);
    const home = path.join(runtimeDir, "home");
    const paseoHome = path.join(runtimeDir, "paseo-home");
    const xdgConfig = path.join(runtimeDir, "xdg-config");
    const xdgData = path.join(runtimeDir, "xdg-data");
    const xdgCache = path.join(runtimeDir, "xdg-cache");
    const xdgState = path.join(runtimeDir, "xdg-state");
    const workspace = path.join(runtimeDir, "workspace");
    for (const directory of [home, paseoHome, xdgConfig, xdgData, xdgCache, xdgState, workspace]) {
      mkdirSync(directory, { recursive: true });
    }
    const isolatedAuthDirectory = path.join(xdgData, "opencode");
    mkdirSync(isolatedAuthDirectory, { recursive: true });
    copyAuth(
      path.join(os.homedir(), ".local", "share", "opencode", "auth.json"),
      path.join(isolatedAuthDirectory, "auth.json"),
    );
    return { runtimeDir, home, paseoHome, xdgConfig, xdgData, xdgCache, xdgState, workspace };
  } catch (error) {
    if (runtimeDir) {
      rmSync(runtimeDir, { recursive: true, force: true });
    }
    throw error;
  }
}

function failAuthCopy(): never {
  throw new Error("induced auth copy failure");
}

function recordRuntimeDirectory(observed: { runtimeDir: string }) {
  return (runtimeDir: string) => {
    observed.runtimeDir = runtimeDir;
  };
}

function failRuntimeCreation(observed: { runtimeDir: string }) {
  return (runtimeDir: string): never => {
    observed.runtimeDir = runtimeDir;
    throw new Error("induced runtime creation failure");
  };
}

function scanRetainedArtifacts(artifactDir: string) {
  const credentialFilename = /(?:auth|credential|secret|token)/i;
  const credentialContent =
    /(?:authorization\s*[:=]\s*["']?(?:bearer|basic)|["'](?:access_token|refresh_token|api[_-]?key|client_secret)["']\s*:)/i;
  const files = readdirSync(artifactDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter(
      (name) =>
        credentialFilename.test(name) ||
        credentialContent.test(readFileSync(path.join(artifactDir, name), "utf8")),
    )
    .sort();
  return { credentialPatternFiles: files.length, files };
}

async function createCutProxy(upstreamPort: number, artifactPath: string) {
  let connections = 0;
  let cuts = 0;
  let activeGlobal: { upstream: NodeJS.ReadableStream; downstream: ServerResponse } | null = null;
  const record = (value: unknown) =>
    writeFileSync(artifactPath, `${JSON.stringify({ at: Date.now(), ...value })}\n`, { flag: "a" });
  const server = createServer((incoming, outgoing) => {
    const globalEvent = incoming.url?.startsWith("/global/event") === true;
    if (globalEvent) {
      connections += 1;
      record({ type: "global-connect", connection: connections });
    }
    const upstream = httpRequest(
      {
        host: "127.0.0.1",
        port: upstreamPort,
        method: incoming.method,
        path: incoming.url,
        headers: incoming.headers,
      },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        if (globalEvent) {
          activeGlobal = { upstream: response, downstream: outgoing };
          let buffer = "";
          response.on("data", (chunk: Buffer) => {
            buffer += chunk.toString();
            for (;;) {
              const boundary = buffer.indexOf("\n\n");
              if (boundary < 0) break;
              const raw = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              record({ type: "global-record", connection: connections, raw });
            }
          });
        }
        response.pipe(outgoing);
        response.on("close", () => {
          if (activeGlobal?.upstream === response) activeGlobal = null;
        });
      },
    );
    upstream.on("error", (error) => {
      record({ type: "proxy-upstream-error", message: error.message });
      outgoing.destroy();
    });
    incoming.pipe(upstream);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Proxy did not bind");
  return {
    port: address.port,
    get connections() {
      return connections;
    },
    get cuts() {
      return cuts;
    },
    cutActiveGlobalEvent() {
      if (!activeGlobal) throw new Error("No active global event connection to cut");
      cuts += 1;
      record({ type: "global-cut", connection: connections, cut: cuts });
      activeGlobal.upstream.destroy();
      activeGlobal.downstream.destroy();
      activeGlobal = null;
    },
    close: async () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function isRunningToolEvent(event: AgentStreamEvent): boolean {
  return (
    event.type === "timeline" &&
    event.item.type === "tool_call" &&
    (event.item.status === "running" || event.item.status === "pending")
  );
}

function isRunningChildEvent(event: AgentStreamEvent): boolean {
  return (
    event.type === "provider_subagent" &&
    event.event.type === "upsert" &&
    event.event.status === "running"
  );
}

function assertParentResult(
  events: AgentStreamEvent[],
  sentinel: string,
  assertFinalMessageOnly = false,
): void {
  expect(events.filter((event) => event.type === "turn_started")).toHaveLength(1);
  expect(events.filter((event) => event.type === "turn_completed")).toHaveLength(1);
  expect(events.filter((event) => event.type === "turn_failed")).toHaveLength(0);
  expect(events.filter((event) => event.type === "turn_canceled")).toHaveLength(0);
  const messages = new Map<string, string>();
  for (const event of events) {
    if (event.type !== "timeline" || event.item.type !== "assistant_message") continue;
    messages.set(
      event.item.messageId,
      `${messages.get(event.item.messageId) ?? ""}${event.item.text}`,
    );
  }
  const output = Array.from(messages.values()).join("");
  const assertedOutput = assertFinalMessageOnly ? Array.from(messages.values()).at(-1) : output;
  expect(assertedOutput?.trim()).toBe(sentinel);
  expect(output.split(sentinel)).toHaveLength(2);
}

function summarize(result: {
  events: AgentStreamEvent[];
  pidBefore?: number;
  pidAfter?: number;
  cuts: number;
  connectionsBefore: number;
  connectionsAfter: number;
}) {
  return {
    pidBefore: result.pidBefore,
    pidAfter: result.pidAfter,
    cuts: result.cuts,
    connections: result.connectionsAfter - result.connectionsBefore,
    started: result.events.filter((event) => event.type === "turn_started").length,
    completed: result.events.filter((event) => event.type === "turn_completed").length,
    failed: result.events.filter((event) => event.type === "turn_failed").length,
    canceled: result.events.filter((event) => event.type === "turn_canceled").length,
  };
}

async function waitForTerminal(events: AgentStreamEvent[], timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (
      events.some(
        (event) =>
          event.type === "turn_completed" ||
          event.type === "turn_failed" ||
          event.type === "turn_canceled",
      )
    ) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for terminal event`);
}

async function reservePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Port reservation failed");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
