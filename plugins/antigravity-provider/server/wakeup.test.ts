import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROVIDER_CAPABILITIES,
  ProviderEventSchema,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderLaunch,
  type ProviderPersistence,
} from "@getpaseo/plugin/server/provider";
import { createAntigravityProvider } from "./provider.js";
import { Usage } from "./usage.js";

const fakeAgy = fileURLToPath(new URL("../test/agy.mjs", import.meta.url));
const LIVE_SUBAGENT_C1 = "11111111-2222-4333-8444-555555555555";
const LIVE_SUBAGENT_C2 = "22222222-3333-4444-8555-666666666666";
const LIVE_SUBAGENT_C3 = "33333333-4444-4555-8666-777777777777";

const temporary: string[] = [];
const connections: ProviderConnection[] = [];

afterEach(async () => {
  await Promise.all(connections.splice(0).map((conn) => conn.close()));
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setupHarness(env: Record<string, string> = {}) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "agy-wakeup-test-"));
  temporary.push(cwd);
  const dataDir = path.join(cwd, "agy-data");
  const logFile = path.join(cwd, "agy-log.ndjson");
  await mkdir(dataDir, { recursive: true });
  const usage = new Usage();
  const provider = createAntigravityProvider(usage);

  const launch: ProviderLaunch = {
    command: process.execPath,
    args: [fakeAgy],
    env: {
      ANTIGRAVITY_EXECUTABLE_DATA_DIR: dataDir,
      AGY_TEST_LOG: logFile,
      ...env,
    },
  };

  const connection = await provider.connect({
    versions: [1],
    capabilities: PROVIDER_CAPABILITIES,
    launch,
  });
  connections.push(connection);

  const events: ProviderEvent[] = [];
  connection.onEvent((event) => {
    ProviderEventSchema.parse(event);
    events.push(event);
  });

  async function wait<T extends ProviderEvent = ProviderEvent>(
    predicate: (event: ProviderEvent) => boolean,
    timeout = 4500,
  ): Promise<T> {
    await expect.poll(() => events.some(predicate), { timeout, interval: 10 }).toBe(true);
    const found = events.find(predicate);
    if (!found) throw new Error("Expected event not found");
    return found as T;
  }

  async function sendRequest(input: ProviderInput) {
    await connection.send(input);
    if ("requestId" in input) {
      return wait(
        (event) =>
          "requestId" in event &&
          event.requestId === input.requestId &&
          (event.type === "request.completed" ||
            event.type === "request.failed" ||
            event.type === "session.ready" ||
            event.type === "session.can_stop_runtime" ||
            event.type === "catalog"),
      );
    }
    return undefined;
  }

  async function open(
    restored?: ProviderPersistence,
    sessionId = "s",
    mode?: string,
    history: "replay" | "skip" = "replay",
  ) {
    await sendRequest({
      type: "session.open",
      requestId: `open-${events.length}`,
      sessionId,
      persistence: restored,
      history,
      config: {
        cwd,
        env: {},
        settings: {},
        mcpServers: {},
        persist: true,
        ...(mode ? { mode } : {}),
      },
    });
  }

  async function prompt(text: string, sessionId = "s") {
    const clientMessageId = `prompt-${events.length}`;
    await connection.send({
      type: "session.prompt",
      sessionId,
      prompt: {
        clientMessageId,
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text }] },
      },
    });
    const admitted = await wait<Extract<ProviderEvent, { type: "session.prompt_result" }>>(
      (event) =>
        event.type === "session.prompt_result" && event.clientMessageId === clientMessageId,
    );
    if (admitted.result.type !== "turn") {
      throw new Error(`Prompt rejected: ${JSON.stringify(admitted.result)}`);
    }
    const turnId = admitted.result.turnId;
    await wait(
      (event) =>
        event.type === "session.turn" &&
        event.sessionId === sessionId &&
        event.turnId === turnId &&
        event.state !== "started",
    );
    return turnId;
  }

  async function canStopRuntime(sessionId = "s"): Promise<boolean> {
    const reqId = `can-stop-${events.length}-${Math.random().toString(36).slice(2, 7)}`;
    const reply = (await sendRequest({
      type: "session.can_stop_runtime",
      requestId: reqId,
      sessionId,
    })) as Extract<ProviderEvent, { type: "session.can_stop_runtime" }>;
    return reply.canStop;
  }

  function rootPersistence(sessionId = "s"): ProviderPersistence {
    const opened = events.find(
      (e) => e.type === "session.opened" && e.sessionId === sessionId && Boolean(e.persistence),
    );
    if (!opened || opened.type !== "session.opened" || !opened.persistence) {
      throw new Error("Missing root persistence");
    }
    return opened.persistence;
  }

  async function records(): Promise<Array<Record<string, unknown>>> {
    try {
      const content = await readFile(logFile, "utf8");
      return content
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    } catch {
      return [];
    }
  }

  return {
    connection,
    usage,
    events,
    cwd,
    dataDir,
    wait,
    sendRequest,
    open,
    prompt,
    canStopRuntime,
    rootPersistence,
    records,
  };
}

describe("antigravity wakeups, subagents, usage, and runtime safety", () => {
  it("reports cachedReadTokens + contextWindowUsedTokens and captures session tier for Usage", async () => {
    const h = await setupHarness({ AGY_TEST_TIER: "Google AI Ultra" });
    await h.open();
    await writeFile(path.join(h.dataDir, "jetski_state.pbtxt"), 'tier: "ultra"\n', "utf8");

    const turnId = await h.prompt("PROMPT_CACHED_USAGE");
    const usageEvent = h.events.find(
      (e): e is Extract<ProviderEvent, { type: "session.usage" }> =>
        e.type === "session.usage" && e.turnId === turnId,
    );
    expect(usageEvent?.usage).toMatchObject({
      inputTokens: 15000,
      cachedInputTokens: 8000,
      outputTokens: 300,
      contextWindowUsedTokens: 23300,
    });

    const reg = h.usage.registration();
    const [account] = await reg.discover({ kind: "global" });
    const report = await reg.fetch(account!.input);
    expect(report).toMatchObject({
      status: "available",
      planLabel: "Google AI Ultra",
    });
  });

  it("wakes up autonomously when a background run_command (task-*) finishes after turn end", async () => {
    const h = await setupHarness();
    await h.open();

    await h.prompt("BG_RUN_COMMAND_WAKEUP");
    // Immediately after foreground turn ends, task-1 is still running: runtime must NOT stop
    expect(await h.canStopRuntime()).toBe(false);

    // Wait for autonomous wakeup turn triggered strictly from transcript.jsonl (streamFence closed)
    const wakeupStarted = await h.wait<Extract<ProviderEvent, { type: "session.turn" }>>(
      (e) =>
        e.type === "session.turn" &&
        e.sessionId === "s" &&
        e.turnId.startsWith("wakeup-") &&
        e.state === "started",
    );
    await h.wait(
      (e) =>
        e.type === "session.turn" &&
        e.sessionId === "s" &&
        e.turnId === wakeupStarted.turnId &&
        e.state === "completed",
    );

    expect(
      h.events.some(
        (e) =>
          e.type === "timeline.item" &&
          e.sessionId === "s" &&
          e.item.type === "reasoning" &&
          e.item.text.includes("Task-1 finished cleanly."),
      ),
    ).toBe(true);
    expect(
      h.events.some(
        (e) =>
          e.type === "timeline.item" &&
          e.sessionId === "s" &&
          e.item.type === "assistant_message" &&
          e.item.text === "BG_COMMAND_WAKEUP_COMPLETE",
      ),
    ).toBe(true);
    expect(
      h.events.some(
        (e) =>
          e.type === "session.usage" &&
          e.turnId === wakeupStarted.turnId &&
          e.usage.cachedInputTokens === 4000,
      ),
    ).toBe(true);

    expect(await h.canStopRuntime()).toBe(true);
  });

  it("wakes up autonomously for one-shot schedule timers and persistent IsDaemon crons", async () => {
    const h = await setupHarness();
    await h.open();

    // 1. One-shot timer wakeup
    await h.prompt("BG_SCHEDULE_ONESHOT_WAKEUP");
    expect(await h.canStopRuntime()).toBe(false);

    await h.wait(
      (e) =>
        e.type === "timeline.item" &&
        e.sessionId === "s" &&
        e.item.type === "assistant_message" &&
        e.item.text === "ONESHOT_TIMER_FIRED",
    );
    await h.wait(
      (e) =>
        e.type === "session.turn" &&
        e.sessionId === "s" &&
        e.turnId === "wakeup-1" &&
        e.state === "completed",
    );
    expect(await h.canStopRuntime()).toBe(true);

    // 2. Persistent IsDaemon cron firing multiple ticks across idle gaps
    await h.prompt("BG_SCHEDULE_DAEMON_WAKEUP");
    expect(await h.canStopRuntime()).toBe(false);

    await h.wait(
      (e) =>
        e.type === "timeline.item" &&
        e.sessionId === "s" &&
        e.item.type === "assistant_message" &&
        e.item.text === "DAEMON_CRON_TICK_1",
    );
    await h.wait(
      (e) =>
        e.type === "session.turn" &&
        e.sessionId === "s" &&
        e.turnId === "wakeup-2" &&
        e.state === "completed",
    );
    // Still false after tick 1 because IsDaemon cron remains active!
    expect(await h.canStopRuntime()).toBe(false);

    await h.wait(
      (e) =>
        e.type === "timeline.item" &&
        e.sessionId === "s" &&
        e.item.type === "assistant_message" &&
        e.item.text === "DAEMON_CRON_TICK_2",
    );
    await h.wait(
      (e) =>
        e.type === "session.turn" &&
        e.sessionId === "s" &&
        e.turnId === "wakeup-3" &&
        e.state === "completed",
    );
    expect(await h.canStopRuntime()).toBe(false);

    // Killing the daemon schedule releases runtime stop lock
    await h.prompt("KILL_DAEMON_SCHEDULE");
    expect(await h.canStopRuntime()).toBe(true);
  });

  it("splits in-turn wakeup assistant bubbles and handles unsolicited post-turn ACP updates", async () => {
    const h = await setupHarness();
    await h.open();

    await h.prompt("IN_TURN_WAKEUP_SPLIT");
    const splitMessages = h.events
      .filter(
        (e): e is Extract<ProviderEvent, { type: "timeline.item" }> =>
          e.type === "timeline.item" && e.sessionId === "s" && e.item.type === "assistant_message",
      )
      .map((e) =>
        e.item.type === "assistant_message" ? { id: e.item.id, text: e.item.text } : null,
      )
      .filter((x): x is { id: string; text: string } => x !== null);

    const beforeMsg = splitMessages.find((m) => m.text === "BEFORE_WAKEUP");
    const afterMsg = splitMessages.find((m) => m.text === "AFTER_WAKEUP");
    expect(beforeMsg).toBeDefined();
    expect(afterMsg).toBeDefined();
    expect(beforeMsg!.id).not.toBe(afterMsg!.id);

    await h.prompt("ACP_UNSOLICITED_WAKEUP");
    await h.wait(
      (e) =>
        e.type === "timeline.item" &&
        e.sessionId === "s" &&
        e.item.type === "assistant_message" &&
        e.item.text === "ACP_WAKEUP_HELLO",
    );
    await h.wait(
      (e) =>
        e.type === "session.turn" &&
        e.sessionId === "s" &&
        e.turnId === "wakeup-1" &&
        e.state === "completed",
    );
  });

  it("bridges native subagents, nested children, post-turn child permissions, send_message, kill, and load replay", async () => {
    const h = await setupHarness();
    await h.open();

    await h.prompt("SUBAGENT_LIVE_AND_WAKEUP");
    // Child c1 is still running after parent foreground turn finishes
    expect(await h.canStopRuntime()).toBe(false);

    // Verify c1 and nested c2 opened in Subagents track
    const c1Opened = await h.wait<Extract<ProviderEvent, { type: "session.opened" }>>(
      (e) => e.type === "session.opened" && e.sessionId === LIVE_SUBAGENT_C1,
    );
    expect(c1Opened).toMatchObject({
      parentSessionId: "s",
      title: "Security Lead",
      restoration: "parent",
    });

    const c2Opened = await h.wait<Extract<ProviderEvent, { type: "session.opened" }>>(
      (e) => e.type === "session.opened" && e.sessionId === LIVE_SUBAGENT_C2,
    );
    expect(c2Opened).toMatchObject({
      parentSessionId: LIVE_SUBAGENT_C1,
      title: "Crypto Auditor",
      restoration: "parent",
    });

    // Child c1 requests tool permission AFTER parent foreground turn already finished!
    const childPerm = await h.wait<Extract<ProviderEvent, { type: "session.permission" }>>(
      (e) => e.type === "session.permission" && e.sessionId === "s",
    );
    expect(childPerm.request.detail).toMatchObject({
      type: "shell",
      command: "npm audit",
    });
    await h.connection.send({
      type: "session.permission",
      sessionId: "s",
      permissionId: childPerm.request.id,
      response: { behavior: "allow" },
    });

    // Child c1 finishes and wakes up parent session "s"
    await h.wait(
      (e) =>
        e.type === "session.turn" && e.sessionId === LIVE_SUBAGENT_C1 && e.state === "completed",
    );
    await h.wait(
      (e) =>
        e.type === "timeline.item" &&
        e.sessionId === "s" &&
        e.item.type === "assistant_message" &&
        e.item.text === "PARENT_RECEIVED_SUBAGENT_RESULT",
    );
    await h.wait(
      (e) =>
        e.type === "session.turn" &&
        e.sessionId === "s" &&
        e.turnId.startsWith("wakeup-") &&
        e.state === "completed",
    );
    expect(await h.canStopRuntime()).toBe(true);

    // Follow-up send_message re-awakens c1 ("running" -> "completed") and wakes parent again
    const countC1Starts = () => {
      let total = 0;
      for (const e of h.events) {
        if (
          e.type === "session.turn" &&
          e.sessionId === LIVE_SUBAGENT_C1 &&
          e.state === "started"
        ) {
          total += 1;
        }
      }
      return total;
    };
    const prevC1Starts = countC1Starts();

    await h.prompt("SUBAGENT_SEND_MESSAGE");
    await h.wait(() => countC1Starts() > prevC1Starts);
    await h.wait(
      (e) =>
        e.type === "timeline.item" &&
        e.sessionId === LIVE_SUBAGENT_C1 &&
        e.item.type === "assistant_message" &&
        e.item.text === "Dependencies clean",
    );
    await h.wait(
      (e) =>
        e.type === "timeline.item" &&
        e.sessionId === "s" &&
        e.item.type === "assistant_message" &&
        e.item.text === "PARENT_FOLLOWUP_DONE",
    );

    // Killing a running subagent marks it canceled
    await h.prompt("SUBAGENT_KILL");
    await h.wait(
      (e) =>
        e.type === "session.turn" && e.sessionId === LIVE_SUBAGENT_C3 && e.state === "canceled",
    );

    // Close and reload session with history: "replay" -> reconstructs subagent hierarchy before session.ready
    const savedPersistence = h.rootPersistence("s");
    await h.sendRequest({
      type: "session.close",
      requestId: "close-s",
      sessionId: "s",
    });

    const replayStartIdx = h.events.length;
    await h.open(savedPersistence, "s-reloaded", undefined, "replay");
    const replaySlice = h.events.slice(replayStartIdx);

    const rootOpenIdx = replaySlice.findIndex(
      (e) => e.type === "session.opened" && e.sessionId === "s-reloaded",
    );
    const c1ReplayIdx = replaySlice.findIndex(
      (e) => e.type === "session.opened" && e.sessionId === LIVE_SUBAGENT_C1,
    );
    const c2ReplayIdx = replaySlice.findIndex(
      (e) => e.type === "session.opened" && e.sessionId === LIVE_SUBAGENT_C2,
    );
    const rootReadyIdx = replaySlice.findIndex(
      (e) => e.type === "session.ready" && e.sessionId === "s-reloaded",
    );

    expect(rootOpenIdx).toBeGreaterThanOrEqual(0);
    expect(c1ReplayIdx).toBeGreaterThan(rootOpenIdx);
    expect(c2ReplayIdx).toBeGreaterThan(c1ReplayIdx);
    expect(rootReadyIdx).toBeGreaterThan(c2ReplayIdx);
  });

  it("executes shell tools inside post-turn autonomous wakeups in full-access mode (--dangerously-skip-permissions) and syncs accept-edits via session/set_mode", async () => {
    const h = await setupHarness();
    await h.open(undefined, "s", "default");

    const initialLaunches = (await h.records()).filter(
      (r) => Array.isArray(r.args) && r.args.includes("acp"),
    );
    expect(initialLaunches).toHaveLength(1);
    expect(initialLaunches[0]!.args).not.toContain("--dangerously-skip-permissions");

    // Switching default -> accept-edits calls session/set_mode without respawning
    await h.sendRequest({
      type: "session.configure",
      requestId: "cfg-accept-edits",
      sessionId: "s",
      changes: { mode: "accept-edits" },
    });
    const afterAcceptEdits = await h.records();
    expect(
      afterAcceptEdits.some(
        (r) =>
          typeof r.rpc === "object" &&
          r.rpc !== null &&
          (r.rpc as { method?: string }).method === "session/set_mode" &&
          (r.rpc as { params?: { modeId?: string } }).params?.modeId === "accept-edits",
      ),
    ).toBe(true);
    expect(
      afterAcceptEdits.filter((r) => Array.isArray(r.args) && r.args.includes("acp")),
    ).toHaveLength(1);

    // Switching to full-access recycles driver with --dangerously-skip-permissions so post-turn shell tools succeed
    await h.sendRequest({
      type: "session.configure",
      requestId: "cfg-full-access",
      sessionId: "s",
      changes: { mode: "full-access" },
    });

    await h.prompt("BG_WAKEUP_SHELL_TOOL");
    expect(await h.canStopRuntime()).toBe(false);

    await h.wait(
      (e) =>
        e.type === "timeline.item" &&
        e.sessionId === "s" &&
        e.item.type === "assistant_message" &&
        e.item.text === "WAKEUP_SHELL_TOOL_OK: 2026-11-11 17:01:50",
    );
    await h.wait(
      (e) =>
        e.type === "session.turn" &&
        e.sessionId === "s" &&
        e.turnId === "wakeup-1" &&
        e.state === "completed",
    );

    const shellCompleted = h.events.find(
      (e) =>
        e.type === "timeline.item" &&
        e.sessionId === "s" &&
        e.item.type === "tool_call" &&
        e.item.id === "wakeup-shell-1" &&
        e.item.status === "completed",
    );
    expect(shellCompleted).toBeDefined();
    expect(await h.canStopRuntime()).toBe(true);

    const allLaunches = (await h.records()).filter(
      (r) => Array.isArray(r.args) && r.args.includes("acp"),
    );
    expect(allLaunches).toHaveLength(2);
    expect(allLaunches[1]!.args).toContain("--dangerously-skip-permissions");
  });

  it("aborts stalled post-turn unpromptable tools in default mode via session/cancel and settles cleanly instead of hanging", async () => {
    const h = await setupHarness({ AGY_AUTONOMOUS_TOOL_STALL_TIMEOUT_MS: "180" });
    await h.open(undefined, "s", "default");

    await h.prompt("BG_WAKEUP_SHELL_TOOL");
    expect(await h.canStopRuntime()).toBe(false);

    const failedTool = await h.wait<Extract<ProviderEvent, { type: "timeline.item" }>>(
      (e) =>
        e.type === "timeline.item" &&
        e.sessionId === "s" &&
        e.item.type === "tool_call" &&
        e.item.id === "wakeup-shell-1" &&
        e.item.status === "failed",
    );
    expect(JSON.stringify(failedTool)).toContain("Full access");

    await h.wait(
      (e) =>
        e.type === "session.turn" &&
        e.sessionId === "s" &&
        e.turnId === "wakeup-1" &&
        e.state === "completed",
    );
    expect(await h.canStopRuntime()).toBe(true);

    const logs = await h.records();
    expect(
      logs.some(
        (r) =>
          typeof r.rpc === "object" &&
          r.rpc !== null &&
          (r.rpc as { method?: string }).method === "session/cancel",
      ),
    ).toBe(true);
  });
});
