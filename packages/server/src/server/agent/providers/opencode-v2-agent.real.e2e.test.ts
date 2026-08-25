import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { findExecutable } from "../../../executable-resolution/executable-resolution.js";
import type { AgentSession, AgentStreamEvent } from "../agent-sdk-types.js";
import { OpenCodeV2AgentClient } from "./opencode-v2-agent.js";
import { createOpenCodeV2Client } from "./opencode-v2/client.js";
import { OpenCodeV2EventConsumer } from "./opencode-v2/event-consumer.js";
import { OpenCodeV2ServerManager } from "./opencode-v2/server-manager.js";

const PINNED_OPENCODE2_VERSION = "0.0.0-beta-18155";
const MODEL = "baseten/deepseek-ai/DeepSeek-V4-Flash-0731";
const NORMAL_SENTINEL = "PASEO_OPENCODE_V2_SENTINEL_7F31";
const TIMEOUT_MS = 240_000;

describe.sequential("OpenCode 2 real e2e", () => {
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
    "normal foreground completes once with incremental text streaming",
    async () => {
      const result = await harness.runScenario(
        "normal",
        [
          "Write a short paragraph (about 100 words) describing the ocean.",
          `End your response with exactly ${NORMAL_SENTINEL} and nothing after it.`,
          "Do not use any tools.",
        ].join("\n"),
      );

      assertParentResult(result.events, NORMAL_SENTINEL);
      expect(hasIncrementalTextDeltas(result.events)).toBe(true);
      harness.writeSummary("normal", summarize(result));
    },
    TIMEOUT_MS,
  );

  test(
    "rewinds conversation and files after real edit turns",
    async () => {
      const { client, rawClient, workspace } = harness;
      const session = await client.createSession({
        provider: "opencode-v2",
        cwd: workspace,
        model: MODEL,
        modeId: "build",
      });
      const events: AgentStreamEvent[] = [];
      session.subscribe(recordAndAutoApprove(session, events));

      const terminalCount = () =>
        events.filter(
          (event) =>
            event.type === "turn_completed" ||
            event.type === "turn_failed" ||
            event.type === "turn_canceled",
        ).length;
      const runTurn = async (prompt: string) => {
        const before = terminalCount();
        await session.startTurn(prompt);
        const started = Date.now();
        while (Date.now() - started < TIMEOUT_MS - 10_000) {
          if (terminalCount() > before) return;
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
        }
        throw new Error(`Timed out waiting for terminal event after: ${prompt}`);
      };

      try {
        await runTurn("Create note.txt containing exactly NOTE_ONE. Use the edit tool.");
        expect(existsSync(path.join(workspace, "note.txt"))).toBe(true);

        await runTurn("Create note2.txt containing exactly NOTE_TWO. Use the edit tool.");
        expect(existsSync(path.join(workspace, "note2.txt"))).toBe(true);

        const firstUserMessage = events.find(
          (event) => event.type === "timeline" && event.item.type === "user_message",
        );
        expect(firstUserMessage?.type).toBe("timeline");
        const messageId =
          firstUserMessage?.type === "timeline" && firstUserMessage.item.type === "user_message"
            ? firstUserMessage.item.messageId
            : undefined;
        expect(messageId).toBeTruthy();

        const sessionId = (await session.getRuntimeInfo()).sessionId;
        expect(sessionId).toBeTruthy();

        // Wait for the session to be idle so the rewind's snapshot capture has
        // fully settled before staging the revert.
        const started = Date.now();
        while (Date.now() - started < 30_000) {
          const info = await rawClient.session.get({ sessionID: sessionId! });
          if (info.status?.type === "idle") break;
          await new Promise<void>((resolve) => setTimeout(resolve, 500));
        }

        const beforeTranscript = await rawClient.message.list({ sessionID: sessionId! });
        const beforeUserAssistant = beforeTranscript.data.filter(
          (message) => message.type === "user" || message.type === "assistant",
        );

        // Rewind to the first user message: files restored + transcript truncated.
        await session.revertBoth({ messageId: messageId! });

        expect(existsSync(path.join(workspace, "note.txt"))).toBe(false);
        expect(existsSync(path.join(workspace, "note2.txt"))).toBe(false);

        const transcript = await rawClient.message.list({ sessionID: sessionId! });
        const userAssistant = transcript.data.filter(
          (message) => message.type === "user" || message.type === "assistant",
        );
        expect(userAssistant.length).toBeLessThan(beforeUserAssistant.length);

        // Session usable after rewind: a new turn completes from the reverted base.
        await runTurn("Reply with exactly: POST_REWIND_OK");
        const postRewind = await rawClient.message.list({ sessionID: sessionId! });
        expect(postRewind.data.some((message) => message.type === "user")).toBe(true);

        // Rewinding to an unknown message errors cleanly.
        await expect(session.revertBoth({ messageId: "msg_does_not_exist" })).rejects.toThrow();
      } finally {
        await session.close().catch(() => undefined);
      }
    },
    TIMEOUT_MS * 2,
  );

  test(
    "resumes a closed session, reconstructs history, lists/imports it, and archives as a no-op",
    async () => {
      const { client, rawClient, workspace } = harness;
      const sessionConfig = {
        provider: "opencode-v2" as const,
        cwd: workspace,
        model: MODEL,
        modeId: "build",
      };
      const session = await client.createSession(sessionConfig);
      const events: AgentStreamEvent[] = [];
      session.subscribe(recordAndAutoApprove(session, events));

      const terminalCount = () =>
        events.filter(
          (event) =>
            event.type === "turn_completed" ||
            event.type === "turn_failed" ||
            event.type === "turn_canceled",
        ).length;
      const runTurn = async (prompt: string) => {
        const before = terminalCount();
        await session.startTurn(prompt);
        const started = Date.now();
        while (Date.now() - started < TIMEOUT_MS - 10_000) {
          if (terminalCount() > before) return;
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
        }
        throw new Error(`Timed out waiting for terminal event after: ${prompt}`);
      };

      try {
        await runTurn("Reply with exactly: RESUME_ONE");
        await runTurn("Reply with exactly: RESUME_TWO");

        const handle = session.describePersistence();
        expect(handle).not.toBeNull();
        expect(handle?.provider).toBe("opencode-v2");
        expect(handle?.sessionId).toBeTruthy();
        expect(handle?.nativeHandle).toBe(handle?.sessionId);

        await session.close().catch(() => undefined);

        // The durable session is discoverable for import from the workspace.
        const importable = await client.listImportableSessions({ cwd: workspace });
        expect(importable.some((entry) => entry.providerHandleId === handle?.sessionId)).toBe(true);

        // Resume restores the conversation: streamHistory reconstructs the
        // prior user turns from message.list.
        const resumed = await client.resumeSession(handle!, sessionConfig);
        const history: AgentStreamEvent[] = [];
        for await (const event of resumed.streamHistory()) {
          history.push(event);
        }
        const userTexts = history
          .filter((event) => event.type === "timeline" && event.item.type === "user_message")
          .map((event) =>
            event.type === "timeline" && event.item.type === "user_message" ? event.item.text : "",
          );
        expect(userTexts).toContain("Reply with exactly: RESUME_ONE");
        expect(userTexts).toContain("Reply with exactly: RESUME_TWO");

        // The resumed session continues on the same opencode2 session.
        const resumedEvents: AgentStreamEvent[] = [];
        resumed.subscribe(recordAndAutoApprove(resumed, resumedEvents));
        await resumed.startTurn("Reply with exactly: RESUME_THREE");
        const started = Date.now();
        while (Date.now() - started < TIMEOUT_MS - 10_000) {
          if (
            resumedEvents.some(
              (event) =>
                event.type === "turn_completed" ||
                event.type === "turn_failed" ||
                event.type === "turn_canceled",
            )
          ) {
            break;
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
        }
        expect(
          resumedEvents.some(
            (event) => event.type === "turn_completed" || event.type === "turn_canceled",
          ),
        ).toBe(true);

        // Import brings the real session into paseo with its history intact.
        const imported = await client.importSession(
          { providerHandleId: handle!.sessionId, cwd: workspace },
          {
            config: sessionConfig,
            storedConfig: sessionConfig,
          },
        );
        expect(imported.persistence.sessionId).toBe(handle?.sessionId);
        const importedUserTexts = imported.timeline
          .filter((entry) => entry.item.type === "user_message")
          .map((entry) => (entry.item.type === "user_message" ? entry.item.text : ""));
        expect(importedUserTexts).toContain("Reply with exactly: RESUME_ONE");

        // archive/unarchive are best-effort no-ops: the durable session is
        // preserved (v2 has no native archive API).
        await client.archiveNativeSession(handle!);
        await client.unarchiveNativeSession(handle!);
        const stillThere = await rawClient.session.get({ sessionID: handle!.sessionId });
        expect(stillThere.id).toBe(handle?.sessionId);

        await imported.session.close().catch(() => undefined);
        await resumed.close().catch(() => undefined);
      } finally {
        await session.close().catch(() => undefined);
      }
    },
    TIMEOUT_MS * 2,
  );
});

async function createRealHarness() {
  const artifactDir = mkdtempSync(path.join(os.tmpdir(), "paseo-opencode-v2-"));
  const runtime = createDisposableRuntime();
  const { runtimeDir, home, paseoHome, xdgConfig, xdgData, xdgCache, xdgState, workspace } =
    runtime;

  let setupManager: OpenCodeV2ServerManager | null = null;
  try {
    const openCode2Command = await resolveOpenCode2Command();
    // v2 snapshots files for rewind, so the workspace must be a git repo from
    // the start (every session's snapshot capture depends on it).
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: workspace,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.name", "Paseo Test"], {
      cwd: workspace,
      stdio: "ignore",
    });
    writeFileSync(path.join(workspace, "base.txt"), "BASE\n", "utf8");
    execFileSync("git", ["add", "base.txt"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: workspace, stdio: "ignore" });
    const isolatedEnv = {
      ...process.env,
      HOME: home,
      PASEO_HOME: paseoHome,
      XDG_CONFIG_HOME: xdgConfig,
      XDG_DATA_HOME: xdgData,
      XDG_CACHE_HOME: xdgCache,
      XDG_STATE_HOME: xdgState,
    };
    const openCode2Version = execFileSync(openCode2Command, ["--version"], {
      env: isolatedEnv,
      encoding: "utf8",
    }).trim();
    expect(openCode2Version).toContain(PINNED_OPENCODE2_VERSION);

    const manager = new OpenCodeV2ServerManager({
      logger: pino({ level: "silent" }),
      resolveCommandPrefix: async () => ({ command: openCode2Command, args: [] }),
      resolveHomeDir: () => home,
      resolveCredentialSourcePath: () =>
        path.join(os.homedir(), ".local", "share", "opencode", "auth.json"),
      createEventSource: (options) =>
        new OpenCodeV2EventConsumer({ ...options, createClient: createOpenCodeV2Client }),
    });
    setupManager = manager;
    const lease = await manager.acquireCurrent();
    const client = new OpenCodeV2AgentClient(pino({ level: "silent" }), undefined, {
      serverManager: manager,
    });
    // Raw v2 client bound to the current server, used by the rewind scenario to
    // read the transcript directly after `revertBoth` truncates it.
    const rawClient = createOpenCodeV2Client({
      baseUrl: lease.server.url,
      authorization: lease.server.authorization,
    });

    return {
      artifactDir,
      manager,
      client,
      rawClient,
      workspace,
      writeSummary(name: string, summary: unknown) {
        writeFileSync(
          path.join(artifactDir, `${name}.summary.json`),
          JSON.stringify(summary, null, 2),
        );
      },
      async runScenario(name: string, prompt: string) {
        const sessionConfig = {
          provider: "opencode-v2",
          cwd: workspace,
          model: MODEL,
          modeId: "build",
        } as const;
        const session = await client.createSession(sessionConfig);
        const events: AgentStreamEvent[] = [];
        const eventPath = path.join(artifactDir, `${name}.events.jsonl`);
        session.subscribe((event) => {
          events.push(event);
          writeFileSync(eventPath, `${JSON.stringify(event)}\n`, { flag: "a" });
          // Auto-approve tool permissions so a real session can complete
          // unattended (mirrors the v1 harness's auto_accept feature value).
          if (event.type === "permission_requested") {
            void session.respondToPermission(event.request.id, { behavior: "allow" }).catch(() => {
              // A permission that was already resolved is a no-op.
            });
          }
        });
        try {
          await session.startTurn(prompt);
          await waitForTerminal(events, TIMEOUT_MS - 10_000);
          return { events };
        } finally {
          await session.close().catch(() => undefined);
        }
      },
      async close() {
        try {
          await lease.release().catch(() => undefined);
          await manager.shutdown().catch(() => undefined);
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
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), "paseo-opencode-v2-runtime-"));
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
    // Seed the real user's opencode2 credentials into the isolated home's data
    // dir so credentialed-provider models (Baseten) work. The server manager
    // re-seeds the same file at spawn (and seeds the credential DB); copying
    // here keeps the failure-injection tests in line with the v1 harness.
    const isolatedAuthDirectory = path.join(home, ".local", "share", "opencode");
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

/**
 * Subscribe handler for real sessions: records every event and auto-approves
 * tool permissions so a real session can complete unattended.
 */
function recordAndAutoApprove(
  session: AgentSession,
  events: AgentStreamEvent[],
): (event: AgentStreamEvent) => void {
  return (event) => {
    events.push(event);
    if (event.type === "permission_requested") {
      void session.respondToPermission(event.request.id, { behavior: "allow" }).catch(() => {
        // A permission that was already resolved is a no-op.
      });
    }
  };
}

function assertParentResult(events: AgentStreamEvent[], sentinel: string): void {
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
  expect(output.trim().endsWith(sentinel)).toBe(true);
  expect(output.split(sentinel)).toHaveLength(2);
}

function hasIncrementalTextDeltas(events: AgentStreamEvent[]): boolean {
  const deltaCounts = new Map<string, number>();
  for (const event of events) {
    if (event.type !== "timeline" || event.item.type !== "assistant_message") continue;
    const messageId = event.item.messageId;
    deltaCounts.set(messageId, (deltaCounts.get(messageId) ?? 0) + 1);
  }
  return Array.from(deltaCounts.values()).some((count) => count > 1);
}

function summarize(result: { events: AgentStreamEvent[] }) {
  return {
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

async function resolveOpenCode2Command(): Promise<string> {
  const found = await findExecutable("opencode2");
  if (!found) {
    throw new Error("opencode2 binary not found on PATH");
  }
  return found;
}
