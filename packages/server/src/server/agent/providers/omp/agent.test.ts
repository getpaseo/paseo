import { describe, expect, test } from "vitest";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AgentStreamEvent } from "../../agent-sdk-types.js";
import type { PaseoToolCatalog } from "../../tools/types.js";
import type { OmpAgentMessage } from "./rpc-types.js";
import type { OmpNoTurnScheduler, OmpProviderIdleScheduler } from "./agent.js";
import type { OmpUsagePollScheduler } from "./usage-poller.js";
import { resolveOmpProviderOptions } from "./provider-config.js";
import { OmpRuntimeEventSchema } from "./rpc-types.js";
import { OmpHarness } from "./test-utils/omp-harness.js";
import { OmpAgentClient } from "./agent.js";
import { FakeOmp } from "./test-utils/fake-omp.js";
import { createTestLogger } from "../../../../test-utils/test-logger.js";

const TURN_LIFECYCLE_EVENTS = new Set<AgentStreamEvent["type"]>([
  "turn_started",
  "turn_completed",
  "turn_failed",
  "turn_canceled",
]);

function isTurnLifecycle(type: AgentStreamEvent["type"]): boolean {
  return TURN_LIFECYCLE_EVENTS.has(type);
}

// What OMP reports for a turn the user stopped: an error message on a terminal
// response whose stop reason says the request was aborted.
const ABORTED_TERMINAL_RESPONSE: OmpAgentMessage = {
  role: "assistant",
  content: [],
  provider: "ai-harness-omp",
  model: "glm-5.3-flash-high",
  responseId: "chatcmpl-aborted",
  stopReason: "aborted",
  errorMessage: "Interrupted by user",
};

test("OMP ready timeout defaults to 20 seconds and RPC timeout overrides both", () => {
  expect(resolveOmpProviderOptions({}).runtimeOptions).toMatchObject({
    readyTimeoutMs: 20_000,
    rpcTimeoutMs: 60_000,
  });
  expect(resolveOmpProviderOptions({ rpcTimeoutMs: 90_000 }).runtimeOptions).toMatchObject({
    readyTimeoutMs: 90_000,
    rpcTimeoutMs: 90_000,
  });
});

test("OMP import uses the runtime's custom agent directory without a configured sessionDir", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-omp-import-dir-"));
  const agentDir = path.join(root, "agent");
  const sessionFile = path.join(agentDir, "sessions", "project", "session.jsonl");
  await mkdir(path.dirname(sessionFile), { recursive: true });
  await writeFile(
    sessionFile,
    JSON.stringify({ type: "session", id: "custom-dir", cwd: root, timestamp: "2026-09-28" }),
  );
  const client = new OmpAgentClient({
    logger: createTestLogger(),
    runtime: new FakeOmp(),
    runtimeSettings: { env: { PI_CODING_AGENT_DIR: agentDir } },
  });

  expect(await client.listImportableSessions({ cwd: root })).toEqual([
    expect.objectContaining({ providerHandleId: sessionFile }),
  ]);
});
class ManualIdleScheduler implements OmpProviderIdleScheduler {
  private readonly retries: Array<() => void> = [];
  private readonly waiters: Array<{ count: number; resolve: () => void }> = [];
  private waitCount = 0;

  waitForRetry(): Promise<void> {
    this.waitCount += 1;
    for (const waiter of this.waiters.splice(0)) {
      if (this.waitCount >= waiter.count) waiter.resolve();
      else this.waiters.push(waiter);
    }
    return new Promise((resolve) => this.retries.push(resolve));
  }

  waitForWaits(count: number): Promise<void> {
    if (this.waitCount >= count) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ count, resolve }));
  }

  retry(): void {
    const resolve = this.retries.shift();
    if (!resolve) throw new Error("OMP has not requested an idle-state retry");
    resolve();
  }
}

class ManualNoTurnScheduler implements OmpNoTurnScheduler {
  private settleResolve: (() => void) | null = null;
  private aborted = false;

  waitForSettle(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      this.aborted = true;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.settleResolve = resolve;
      signal.addEventListener(
        "abort",
        () => {
          this.aborted = true;
          this.settleResolve = null;
          resolve();
        },
        { once: true },
      );
    });
  }

  settle(): void {
    const resolve = this.settleResolve;
    if (!resolve) throw new Error("OMP has not requested a no-turn settle wait");
    this.settleResolve = null;
    resolve();
  }

  wasAborted(): boolean {
    return this.aborted;
  }
}

class ManualUsagePollScheduler implements OmpUsagePollScheduler {
  private readonly polls: Array<{ active: boolean; callback: () => void }> = [];

  schedulePoll(callback: () => void): () => void {
    const poll = { active: true, callback };
    this.polls.push(poll);
    return () => {
      poll.active = false;
    };
  }

  poll(): void {
    const poll = this.polls.shift();
    if (!poll) throw new Error("OMP has not scheduled a context usage poll");
    if (poll.active) poll.callback();
  }

  activePollCount(): number {
    return this.polls.filter((poll) => poll.active).length;
  }
}

function createToolCatalog(): PaseoToolCatalog {
  return {
    tools: new Map([
      [
        "create_agent",
        {
          name: "create_agent",
          description: "Create a Paseo agent.",
          handler: async () => ({ content: [] }),
        },
      ],
    ]),
    getTool: () => undefined,
    executeTool: async () => ({ content: [] }),
  };
}

describe("OMP agent client and session", () => {
  test("owns launch configuration and registers native host tools", async () => {
    const omp = new OmpHarness();
    await omp.start({ modeId: "ask" }, createToolCatalog());

    expect(omp.launchConfiguration()).toEqual({
      cwd: "/tmp/paseo-omp-agent-test",
      protocolMode: "rpc-ui",
      modeId: "ask",
      argv: ["omp", "--mode", "rpc-ui", "--approval-mode", "always-ask"],
    });
    expect(omp.registeredHostTools()).toEqual([
      [expect.objectContaining({ name: "create_agent" })],
    ]);
    expect(omp.capabilities()).toMatchObject({
      supportsMcpServers: true,
      supportsNativePaseoTools: true,
    });
  });

  test("preserves max as the selected thinking option", async () => {
    const omp = new OmpHarness();
    await omp.start({ thinkingOptionId: "max" });

    expect(omp.launchConfiguration().argv).toEqual(expect.arrayContaining(["--thinking", "max"]));
  });

  test("launches with auto thinking when auto is selected", async () => {
    const omp = new OmpHarness();
    await omp.start({ thinkingOptionId: "auto" });

    expect(omp.launchConfiguration().argv).toEqual(expect.arrayContaining(["--thinking", "auto"]));
  });

  test("keeps auto thinking when resuming a session", async () => {
    const omp = new OmpHarness();
    await omp.resume(
      {
        user: { id: "user-auto", text: "continue" },
        assistant: { id: "assistant-auto", text: "ready" },
      },
      { thinkingOptionId: "auto" },
    );

    expect(omp.launchConfiguration().argv).toEqual(expect.arrayContaining(["--thinking", "auto"]));
  });

  test("launches with write approval mode", async () => {
    const omp = new OmpHarness();
    await omp.start({ modeId: "write" });

    expect(omp.launchConfiguration()).toEqual({
      cwd: "/tmp/paseo-omp-agent-test",
      protocolMode: "rpc-ui",
      modeId: "write",
      argv: ["omp", "--mode", "rpc-ui", "--approval-mode", "write"],
    });
  });

  test("passes --thinking when a thinking option is provided", async () => {
    const omp = new OmpHarness();
    await omp.start({ modeId: "ask", thinkingOptionId: "xhigh" }, createToolCatalog());

    expect(omp.launchConfiguration().argv).toEqual([
      "omp",
      "--mode",
      "rpc-ui",
      "--approval-mode",
      "always-ask",
      "--thinking",
      "xhigh",
    ]);
  });

  test("streams a prompt through completion", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await expect(omp.runPrompt("hello OMP", "hello from OMP")).resolves.toMatchObject({
      finalText: "hello from OMP",
    });
    expect(omp.timeline()).toEqual([
      { type: "user_message", text: "hello OMP", messageId: "user-1" },
      { type: "assistant_message", text: "hello from OMP", messageId: "omp-assistant-1" },
    ]);
    expect(omp.eventTypes().slice(0, 2)).toEqual(["turn_started", "timeline"]);
    expect(omp.completedTurnCount()).toBe(1);
  });

  test("streams OMP advisor messages as distinct tool-call blocks", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await omp.runPromptWithCustomMessage(
      "review this",
      {
        role: "custom",
        content: '<advisory severity="concern">Exercise the failure path.</advisory>',
        customType: "advisor",
        id: "advisor-live-1",
        display: true,
        details: {
          notes: [{ note: "Exercise the failure path.", severity: "concern" }],
        },
      },
      "fixed",
    );

    expect(omp.timeline()).toEqual([
      { type: "user_message", text: "review this", messageId: "user-1" },
      {
        type: "tool_call",
        callId: "omp-advisor:advisor-live-1",
        name: "advisor",
        status: "completed",
        detail: {
          type: "plain_text",
          label: "Advisor · 1 note",
          text: "[concern] Exercise the failure path.",
          icon: "brain",
        },
        metadata: {
          synthetic: true,
          source: "omp_advisor",
          noteCount: 1,
          blockerCount: 0,
        },
        error: null,
      },
      { type: "assistant_message", text: "fixed", messageId: "omp-assistant-1" },
    ]);
  });

  test("completes a streamed assistant turn when agent_end omits messages", async () => {
    const omp = new OmpHarness();
    await omp.start();

    const { completion } = await omp.startPromptWithEmptyAgentEnd(
      "hello OMP",
      "empty terminal payload recovered",
    );
    await expect(completion).resolves.toMatchObject({
      finalText: "empty terminal payload recovered",
    });
    expect(omp.completedTurnCount()).toBe(1);
  });

  test("starts and stops context usage polling with the active turn", async () => {
    const scheduler = new ManualUsagePollScheduler();
    const omp = new OmpHarness({ usagePollScheduler: scheduler });
    await omp.start();
    omp.runtime().stats = {
      contextUsage: { tokens: 130, contextWindow: 200_000 },
    };
    omp.runtime().state.contextUsage = { tokens: 99, contextWindow: 100_000 };
    await omp.requireStartTurn("keep working");
    expect(scheduler.activePollCount()).toBe(1);
    scheduler.poll();
    await waitForImmediate();
    expect(omp.usageUpdates()).toEqual([
      {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        totalCostUsd: 0,
        contextWindowMaxTokens: 200_000,
        contextWindowUsedTokens: 130,
      },
    ]);
    expect(scheduler.activePollCount()).toBe(1);
    omp.runtime().abortError = new Error("abort unavailable");
    await expect(omp.interrupt()).rejects.toThrow("abort unavailable");
    expect(scheduler.activePollCount()).toBe(1);
    omp.runtime().abortError = null;
    await omp.interrupt();
    expect(scheduler.activePollCount()).toBe(0);

    await omp.runPrompt("finish normally", "done");
    expect(scheduler.activePollCount()).toBe(0);

    await omp.requireStartTurn("close the session");
    expect(scheduler.activePollCount()).toBe(1);
    await omp.close();
    expect(scheduler.activePollCount()).toBe(0);
  });

  test("does not accept a follow-up until OMP reports stable idle", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await omp.runPrompt("first", "first done", [
      { isStreaming: true, isCompacting: false },
      { isStreaming: false, isCompacting: false },
      { isStreaming: false, isCompacting: false },
    ]);
    await expect(omp.runPrompt("follow-up", "follow-up done")).resolves.toMatchObject({
      finalText: "follow-up done",
    });
  });

  test("stays active while OMP remains busy", async () => {
    const scheduler = new ManualIdleScheduler();
    const omp = new OmpHarness({ providerIdleScheduler: scheduler });
    await omp.start();

    const { completion } = await omp.startPromptUntilProviderIdle("first", "first done", {
      isStreaming: true,
      isCompacting: false,
    });
    await omp.waitForProviderStateChecks(2);
    await scheduler.waitForWaits(1);

    expect(omp.completedTurnCount()).toBe(0);
    scheduler.retry();
    await omp.waitForProviderStateChecks(3);
    await scheduler.waitForWaits(2);
    expect(omp.completedTurnCount()).toBe(0);

    omp.reportProviderState({ isStreaming: false, isCompacting: false });
    scheduler.retry();
    await expect(completion).resolves.toMatchObject({ finalText: "first done" });
  });

  test("stays active when OMP state checks fail", async () => {
    const scheduler = new ManualIdleScheduler();
    const omp = new OmpHarness({ providerIdleScheduler: scheduler });
    await omp.start();
    omp.failProviderStateChecks(new Error("state unavailable"));

    const { completion } = await omp.startPromptUntilProviderIdle("first", "first done", {
      isStreaming: true,
      isCompacting: false,
    });
    await omp.waitForProviderStateChecks(2);
    await scheduler.waitForWaits(1);
    expect(omp.completedTurnCount()).toBe(0);

    omp.failProviderStateChecks(null);
    omp.reportProviderState({ isStreaming: false, isCompacting: false });
    scheduler.retry();
    await expect(completion).resolves.toMatchObject({ finalText: "first done" });
  });

  test("fails a turn when the provider idle gate passes its deadline", async () => {
    const scheduler = new ManualIdleScheduler();
    const omp = new OmpHarness({ providerIdleScheduler: scheduler, providerIdleDeadlineMs: 1 });
    await omp.start();
    const { completion } = await omp.startPromptUntilProviderIdle("first", "first done", {
      isStreaming: true,
      isCompacting: false,
    });
    await scheduler.waitForWaits(1);
    omp.runtime().emit({
      type: "tool_execution_start",
      toolCallId: "tool-at-deadline",
      toolName: "bash",
      args: { command: "sleep 30" },
    });
    expect(omp.runningToolCallIds()).toEqual(["tool-at-deadline"]);
    await new Promise((resolve) => setTimeout(resolve, 2));
    scheduler.retry();
    await expect(completion).rejects.toThrow(/provider idle/i);
    expect(omp.runningToolCallIds()).toEqual([]);
  });

  test("steers a running turn and correlates a template-expanded echo exactly once", async () => {
    const omp = new OmpHarness();
    await omp.start();
    const session = omp.requireSession();
    const { turnId } = await session.startTurn("first", { clientMessageId: "client-first" });
    const runtime = omp.runtime();
    runtime.beginTurn();
    runtime.acceptPrompt("first", "native-first");
    await expect(
      session.steerActiveTurn?.("expand template", {
        expectedTurnId: turnId,
        clientMessageId: "client-steer",
      }),
    ).resolves.toEqual({ status: "accepted" });
    runtime.acceptPrompt("expanded prompt", "native-steer");
    runtime.acceptPrompt("expanded prompt", "native-steer");
    expect(omp.timeline().filter((item) => item.type === "user_message")).toEqual([
      expect.objectContaining({ messageId: "native-first", clientMessageId: "client-first" }),
      expect.objectContaining({ messageId: "native-steer", clientMessageId: "client-steer" }),
    ]);
  });

  test("reports a rejected steer as unavailable", async () => {
    const omp = new OmpHarness();
    await omp.start();
    const session = omp.requireSession();
    const { turnId } = await session.startTurn("first");
    omp.runtime().steerError = new Error("extension command cannot be steered");
    await expect(
      session.steerActiveTurn?.("extension input", { expectedTurnId: turnId }),
    ).resolves.toEqual({ status: "unavailable" });
  });

  test("propagates an OMP steer transport timeout", async () => {
    const omp = new OmpHarness();
    await omp.start();
    const session = omp.requireSession();
    const { turnId } = await session.startTurn("first");
    const timeout = new Error(
      "OMP RPC request timed out phase=steer elapsedMs=60000 timeoutMs=60000",
    );
    omp.runtime().steerError = timeout;
    await expect(session.steerActiveTurn?.("second", { expectedTurnId: turnId })).rejects.toBe(
      timeout,
    );
  });

  test("shows OMP's fallback model without persisting it as the selected model", async () => {
    const omp = new OmpHarness();
    await omp.start({ model: "openrouter/google/gemini-3.8-flash" });
    const runtime = omp.runtime();
    runtime.state = {
      ...runtime.state,
      model: { provider: "openrouter", id: "google/gemini-3.8-flash" },
    };
    runtime.emit({
      type: "retry_fallback_applied",
      from: "openrouter/google/gemini-3.8-flash",
      to: "openrouter/other/model",
      role: "primary",
    });
    runtime.state = { ...runtime.state, model: { provider: "openrouter", id: "other/model" } };
    runtime.state = { ...runtime.state, fastModeEnabled: true, fastModeActive: false };
    runtime.emit({ type: "model_changed" });
    await waitForImmediate();
    expect(omp.eventTypes()).toContain("model_changed");
    expect((await omp.requireSession().getRuntimeInfo()).model).toBe("openrouter/other/model");
    expect(omp.requireSession().describePersistence()?.metadata?.model).toBe(
      "openrouter/google/gemini-3.8-flash",
    );
    expect(omp.requireSession().features).toEqual([
      expect.objectContaining({
        value: true,
        description: expect.stringMatching(/does not apply/i),
      }),
    ]);
  });

  test("Fast stays selected when OMP says it is inactive for the current model", async () => {
    const omp = new OmpHarness();
    await omp.start({ model: "openrouter/google/gemini-3.8-flash" });
    const session = omp.requireSession();
    omp.runtime().fastModeResult = { enabled: true, active: false };
    await session.setFeature?.("fast_mode", true);
    expect(omp.runtime().setFastModeRequests).toEqual([true]);
    expect(session.features).toEqual([
      expect.objectContaining({
        id: "fast_mode",
        value: true,
        description: expect.stringMatching(/does not apply to this model/i),
        tooltip: expect.stringMatching(/does not apply to this model/i),
      }),
    ]);
  });

  test("shows Fast only when OMP reports its state fields", async () => {
    const omp = new OmpHarness();
    await omp.start();
    const session = omp.requireSession();
    const {
      fastModeEnabled: _enabled,
      fastModeActive: _active,
      ...olderState
    } = omp.runtime().state;
    omp.runtime().state = olderState;
    await session.getRuntimeInfo();
    expect(session.features).toEqual([]);
    await expect(session.setFeature?.("fast_mode", true)).rejects.toThrow(/unavailable/i);
    omp.runtime().state = { ...olderState, fastModeEnabled: false, fastModeActive: false };
    await session.getRuntimeInfo();
    expect(session.features).toHaveLength(1);
  });

  test("switching model refreshes whether Fast applies", async () => {
    const omp = new OmpHarness();
    await omp.start({ model: "openrouter/google/gemini-3.8-flash" });
    const session = omp.requireSession();
    omp.runtime().fastModeResult = { enabled: true, active: true };
    await session.setFeature?.("fast_mode", true);
    expect(session.features).toEqual([expect.objectContaining({ value: true })]);

    omp.runtime().setModelResult = { provider: "openrouter", id: "other/model" };
    omp.runtime().queueStateReports([
      {
        ...omp.runtime().state,
        model: omp.runtime().setModelResult,
        fastModeEnabled: true,
        fastModeActive: false,
      },
    ]);
    await session.setModel?.("openrouter/other/model");
    expect(session.features).toEqual([
      expect.objectContaining({
        value: true,
        description: expect.stringMatching(/does not apply/i),
      }),
    ]);
  });

  test("restores Fast from the initial OMP state on create and resume", async () => {
    const created = new OmpHarness();
    await created.start({ featureValues: { fast_mode: true } });
    expect(created.runtime().setFastModeRequests).toEqual([true]);
    expect(created.runtime().getStateRequestCount).toBe(1);

    const resumed = new OmpHarness();
    await resumed.resume(
      { user: { id: "user-1", text: "hello" }, assistant: { id: "assistant-1", text: "hi" } },
      { featureValues: { fast_mode: true } },
    );
    expect(resumed.runtime().setFastModeRequests).toEqual([true]);
    expect(resumed.runtime().getStateRequestCount).toBe(1);
  });

  test("does not complete on OMP's extension-notice agent_end", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await expect(
      omp.runPromptAfterExtensionNotice("hello OMP", "model turn completed"),
    ).resolves.toMatchObject({ finalText: expect.stringContaining("model turn completed") });
    expect(omp.completedTurnCount()).toBe(1);
  });

  test("does not complete a turn when a custom message arrives before its user message", async () => {
    const omp = new OmpHarness();
    await omp.start();
    await omp.requireStartTurn("hello OMP");

    const runtime = omp.runtime();
    runtime.beginTurn();
    runtime.acceptCustomMessage("startup notice");

    expect(omp.completedTurnCount()).toBe(0);

    runtime.acceptPrompt("hello OMP", "user-1");
    runtime.streamAssistantText("model turn completed");
    runtime.finishTurn();
    await waitForImmediate();

    expect(omp.completedTurnCount()).toBe(1);
  });

  test("omits live custom messages when display is false", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await expect(
      omp.runPromptAfterExtensionNotice("hello OMP", "model turn completed", false),
    ).resolves.toMatchObject({ finalText: expect.stringContaining("model turn completed") });
    expect(omp.timeline()).toEqual([
      { type: "user_message", text: "hello OMP", messageId: "user-1" },
      {
        type: "assistant_message",
        text: "model turn completed",
        messageId: "omp-assistant-1",
      },
    ]);
  });

  test("renders a live system-notice custom message as a notification", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await omp.runPrompt("hello OMP", "done");
    omp
      .runtime()
      .acceptCustomMessage(
        [
          "<system-notice>",
          "Background job DocsSmokeTwo has completed.",
          '<task-result id="DocsSmokeTwo" agent="explore" status="completed" duration="21.6s">',
          "<output>done</output>",
          "</task-result>",
          "</system-notice>",
        ].join("\n"),
      );
    omp.runtime().acceptCustomMessage("plain custom status text");

    expect(omp.timeline().filter((item) => item.type === "notification")).toEqual([
      {
        type: "notification",
        level: "info",
        message: "Background job DocsSmokeTwo completed",
      },
    ]);
    // Non-notice custom messages still fall through as assistant messages with
    // their own id so the stream coalescer never glues them onto the open reply.
    expect(omp.timeline().filter((item) => item.type === "assistant_message")).toEqual([
      { type: "assistant_message", text: "done", messageId: "omp-assistant-1" },
      { type: "assistant_message", text: "plain custom status text", messageId: "omp-custom-1" },
    ]);
  });

  test("shows a concise error for a failed tool while keeping shell output", async () => {
    const omp = new OmpHarness();
    await omp.start();
    omp.emit({
      type: "tool_execution_start",
      toolCallId: "failed-shell",
      toolName: "bash",
      args: { command: "false" },
    });
    omp.emit({
      type: "tool_execution_end",
      toolCallId: "failed-shell",
      toolName: "bash",
      result: {
        content: [{ type: "text", text: "Command exited with code 1" }],
        details: {},
        isError: true,
        exitCode: 1,
      },
      isError: true,
    });
    expect(omp.timeline().at(-1)).toMatchObject({
      type: "tool_call",
      status: "failed",
      error: "Command exited with code 1",
      detail: { type: "shell", command: "false", exitCode: 1 },
    });
  });

  test("uses the exit message when a failed shell has no output", async () => {
    const omp = new OmpHarness();
    await omp.start();
    omp.emit({
      type: "tool_execution_start",
      toolCallId: "empty-shell",
      toolName: "bash",
      args: { command: "false" },
    });
    omp.emit({
      type: "tool_execution_end",
      toolCallId: "empty-shell",
      toolName: "bash",
      result: {
        content: [
          {
            type: "text",
            text: "(no output)\n\nWall time: 0.02 seconds\n\nCommand exited with code 1",
          },
        ],
        isError: true,
      },
      isError: true,
    });
    expect(omp.timeline().at(-1)).toMatchObject({ error: "Command exited with code 1" });
  });

  test("does not duplicate the typed invocation for a live skill expansion", async () => {
    const omp = new OmpHarness();
    await omp.start();
    await omp.runPromptWithCustomMessage(
      "hello",
      {
        role: "custom",
        content: "[IMPORTANT] Full skill body",
        customType: "skill-prompt",
        attribution: "user",
        details: { name: "commit" },
        display: true,
        id: "skill-1",
      },
      "done",
    );
    expect(omp.timeline().filter((item) => item.type === "user_message")).toEqual([
      { type: "user_message", text: "hello", messageId: "user-1" },
    ]);
    expect(omp.timeline()).not.toContainEqual(
      expect.objectContaining({ text: "[IMPORTANT] Full skill body" }),
    );
  });

  test.each([
    { kind: "initial", priorPrompt: false },
    { kind: "follow-up", priorPrompt: true },
  ])("correlates a $kind skill invocation without a user echo", async ({ priorPrompt }) => {
    const omp = new OmpHarness();
    await omp.start();
    if (priorPrompt) {
      await omp.runPrompt("Reply OK", "OK");
    }

    const typed = "/skill:tldr Summarize: hi.";
    const runtime = omp.runtime();
    const promptStarted = runtime.nextPrompt();
    const run = omp.requireSession().run(typed, { clientMessageId: "client-skill" });
    await promptStarted;
    runtime.beginTurn();
    runtime.emit({
      type: "message_end",
      message: {
        role: "custom",
        content: "[IMPORTANT] Full skill body",
        customType: "skill-prompt",
        attribution: "user",
        details: { name: "tldr", args: "Summarize: hi." },
        display: true,
        id: "skill-1",
      },
    });
    runtime.streamAssistantText("done");
    runtime.finishTurn();
    await run;

    expect(omp.timeline().filter((item) => item.type === "user_message")).toEqual([
      ...(priorPrompt ? [{ type: "user_message", text: "Reply OK", messageId: "user-1" }] : []),
      { type: "user_message", text: typed, clientMessageId: "client-skill" },
    ]);
  });

  test("marks an OMP web search details error as failed even without isError", async () => {
    const omp = new OmpHarness();
    await omp.start();
    omp.emit({
      type: "tool_execution_start",
      toolCallId: "search-failed",
      toolName: "web_search",
      args: { query: "Paseo" },
    });
    omp.emit({
      type: "tool_execution_end",
      toolCallId: "search-failed",
      toolName: "web_search",
      result: {
        content: [{ type: "text", text: "Error: All web search providers failed" }],
        details: {
          response: { provider: "mojeek", sources: [] },
          error: "All web search providers failed",
        },
      },
      isError: false,
    });
    expect(omp.timeline().at(-1)).toMatchObject({
      type: "tool_call",
      status: "failed",
      error: "All web search providers failed",
      detail: { type: "search", query: "Paseo" },
    });
  });

  test("does not complete a queued model turn from OMP's local-only hint", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await expect(
      omp.runPromptAfterFalseLocalOnlyHint("hello OMP", "queued model turn completed"),
    ).resolves.toMatchObject({ finalText: "queued model turn completed" });
    expect(omp.completedTurnCount()).toBe(1);
  });

  test("completes a local-only prompt when no OMP turn begins", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await expect(omp.runPromptWithoutTurn("/model")).resolves.toMatchObject({ finalText: "" });
    expect(omp.completedTurnCount()).toBe(1);
  });

  test("completes a no-turn notify with one notification and no assistant text", async () => {
    const scheduler = new ManualNoTurnScheduler();
    const omp = new OmpHarness({ noTurnScheduler: scheduler });
    await omp.start();
    const prompt = await omp.startPromptWithFalseLocalOnlyResult("/autoresearch off");
    omp.emit({
      type: "extension_ui_request",
      id: "local-notify",
      method: "notify",
      message: "Autoresearch mode disabled",
      notifyType: "info",
    });

    scheduler.settle();
    await expect(prompt.completion).resolves.toMatchObject({ finalText: "" });
    expect(omp.completedTurnCount()).toBe(1);
    expect(omp.timeline().filter((item) => item.type === "notification")).toEqual([
      { type: "notification", level: "info", message: "Autoresearch mode disabled" },
    ]);
    expect(omp.timeline().filter((item) => item.type === "assistant_message")).toEqual([]);
  });

  test("waits for a delayed queued model turn after OMP's local-only result", async () => {
    const omp = new OmpHarness();
    await omp.start();

    const completion = await omp.runPromptAfterDelayedFalseLocalOnlyResult(
      "hello OMP",
      "delayed queued model turn completed",
    );

    expect(completion.completedBeforeTurn).toBe(false);
    expect(completion.result).toMatchObject({ finalText: "delayed queued model turn completed" });
    expect(omp.completedTurnCount()).toBe(1);
  });

  test("completes an async local-only result after the settle window", async () => {
    const scheduler = new ManualNoTurnScheduler();
    const omp = new OmpHarness({ noTurnScheduler: scheduler });
    await omp.start();
    const prompt = await omp.startPromptWithFalseLocalOnlyResult("local-only");

    expect(prompt.completed()).toBe(false);
    scheduler.settle();
    await expect(prompt.completion).resolves.toMatchObject({ finalText: "" });
    expect(omp.completedTurnCount()).toBe(1);
  });

  test("cancels an async local-only settle when the OMP session closes", async () => {
    const scheduler = new ManualNoTurnScheduler();
    const omp = new OmpHarness({ noTurnScheduler: scheduler });
    await omp.start();
    const prompt = await omp.startPromptWithFalseLocalOnlyResult("local-only");

    await omp.close();

    expect(scheduler.wasAborted()).toBe(true);
    expect(prompt.completed()).toBe(false);
    expect(omp.completedTurnCount()).toBe(0);
  });

  test("preserves a correlated invoked result over a local-only prompt ack", async () => {
    const omp = new OmpHarness();
    await omp.start();

    const completion = await omp.runPromptAfterCorrelatedTrueResult(
      "hello OMP",
      "correlated model turn completed",
    );

    expect(completion.completedBeforeTurn).toBe(false);
    expect(completion.result).toMatchObject({ finalText: "correlated model turn completed" });
    expect(omp.completedTurnCount()).toBe(1);
  });

  test("completes an autonomous OMP turn without a foreground turn ID", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await omp.runAutonomousTurn("autonomous turn completed");

    expect(omp.completedTurnCount()).toBe(1);
    expect(omp.timeline()).toContainEqual({
      type: "assistant_message",
      text: "autonomous turn completed",
      messageId: "omp-assistant-1",
    });
  });

  test("reads OMP history from the session file without launching a runtime", async () => {
    const omp = new OmpHarness();

    const history = await omp.readPersistedHistory(
      {
        user: { id: "user-history", text: "continue the audit" },
        assistant: { id: "assistant-history", text: "audit context restored" },
      },
      { cwd: "/workspace/resumed" },
    );

    expect(history.flatMap((event) => (event.type === "timeline" ? [event.item] : []))).toEqual([
      { type: "user_message", text: "continue the audit", messageId: "user-history" },
      {
        type: "assistant_message",
        text: "audit context restored",
        messageId: "assistant-history",
      },
    ]);
    // A dedicated history read replays the transcript off disk, so it must never
    // start an OMP runtime against the archived session.
    expect(omp.runtimeLaunches()).toEqual([]);
  });

  test("rejects an OMP history read without a native session file", async () => {
    const omp = new OmpHarness();

    await expect(
      omp.readHistoryHandle({ provider: "omp", sessionId: "omp-session-history" }),
    ).rejects.toThrow("OMP history read requires a native session file handle");

    expect(omp.runtimeLaunches()).toEqual([]);
  });

  test("resumes an OMP session and replays its history", async () => {
    const omp = new OmpHarness();
    await omp.resume(
      {
        user: { id: "user-history", text: "continue the audit" },
        assistant: { id: "assistant-history", text: "audit context restored" },
      },
      { cwd: "/workspace/resumed", modeId: "ask", thinkingOptionId: "high" },
    );

    expect(omp.launchConfiguration()).toEqual({
      cwd: "/workspace/resumed",
      protocolMode: "rpc-ui",
      modeId: "ask",
      session: expect.stringMatching(/[\\/]paseo-omp-resume-.*[\\/]session\.jsonl$/),
      argv: [
        "omp",
        "--mode",
        "rpc-ui",
        "--approval-mode",
        "always-ask",
        "--thinking",
        "high",
        "--session",
        expect.stringMatching(/[\\/]paseo-omp-resume-.*[\\/]session\.jsonl$/),
      ],
    });
    await expect(omp.history()).resolves.toEqual([
      { type: "user_message", text: "continue the audit", messageId: "user-history" },
      {
        type: "assistant_message",
        text: "audit context restored",
        messageId: "assistant-history",
      },
    ]);
  });

  test("maps permissions and sends the selected OMP response", async () => {
    const omp = new OmpHarness();
    await omp.start();

    omp.requestToolApproval({ id: "approval-1", tool: "bash", detail: "git status" });
    expect(omp.pendingPermissions()).toEqual([
      expect.objectContaining({ id: "approval-1", name: "bash", kind: "tool" }),
    ]);

    await omp.respondToPermission("approval-1", { behavior: "allow" });
    expect(omp.extensionUiResponses()).toEqual([
      { id: "approval-1", response: { value: "Approve" } },
    ]);
  });

  test("shows OMP notifications during a turn and while idle with their levels", async () => {
    const omp = new OmpHarness();
    await omp.start();
    await omp.startTurn("work");
    omp.runtime().beginTurn();
    omp.emit({
      type: "extension_ui_request",
      id: "n1",
      method: "notify",
      message: "Working",
      notifyType: "warning",
    });
    omp.runtime().finishTurn();
    omp.emit({
      type: "extension_ui_request",
      id: "n2",
      method: "notify",
      message: "Done",
      notifyType: "info",
    });
    expect(omp.timeline().filter((item) => item.type === "notification")).toEqual([
      { type: "notification", level: "warning", message: "Working" },
      { type: "notification", level: "info", message: "Done" },
    ]);
    expect(omp.timeline().filter((item) => item.type === "assistant_message")).toEqual([]);
  });

  test("maps legacy select options without descriptions and preserves ordinary responses", async () => {
    const omp = new OmpHarness();
    await omp.start();

    omp.emit({
      type: "extension_ui_request",
      id: "select-legacy",
      method: "select",
      title: "Choose",
      options: ["Approve", "Deny"],
    });

    expect(omp.pendingPermissions()[0]?.input).toMatchObject({
      questions: [{ options: [{ label: "Approve" }, { label: "Deny" }] }],
    });
    await omp.respondToPermission("select-legacy", {
      behavior: "allow",
      updatedInput: { answers: { Response: "Deny" } },
    });
    expect(omp.extensionUiResponses()).toContainEqual({
      id: "select-legacy",
      response: { value: "Deny" },
    });
  });

  test("maps described and mixed select metadata by option index", async () => {
    const omp = new OmpHarness();
    await omp.start();

    omp.emit({
      type: "extension_ui_request",
      id: "select-described",
      method: "select",
      title: "Choose",
      options: ["First", "Second", "Third"],
      optionDetails: [{ description: "First detail" }, {}, { description: " \t" }],
    });

    expect(omp.pendingPermissions()[0]?.input?.questions?.[0]?.options).toStrictEqual([
      { label: "First", description: "First detail" },
      { label: "Second" },
      { label: "Third" },
    ]);
  });

  test("accepts malformed or misaligned optional metadata and falls back to labels", async () => {
    const omp = new OmpHarness();
    await omp.start();
    const parsed = OmpRuntimeEventSchema.safeParse({
      type: "extension_ui_request",
      id: "select-malformed",
      method: "select",
      options: ["First", "Second"],
      optionDetails: [{ description: 42 }, { description: "\n\t" }, { description: "extra" }],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("Expected malformed metadata event to parse");

    omp.emit(parsed.data);
    expect(omp.pendingPermissions()[0]?.input?.questions?.[0]?.options).toStrictEqual([
      { label: "First" },
      { label: "Second" },
    ]);
  });

  test("exposes OMP modes and commands through the domain session", async () => {
    const omp = new OmpHarness();
    omp.queueCommands([{ name: "review", description: "Review changes", source: "skill" }]);
    await omp.start();

    await expect(omp.availableModes()).resolves.toEqual([
      expect.objectContaining({ id: "full" }),
      expect.objectContaining({ id: "write" }),
      expect.objectContaining({ id: "ask" }),
    ]);
    await expect(omp.commands()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "handoff" }),
        expect.objectContaining({ name: "review", kind: "skill" }),
      ]),
    );
    await expect(omp.setMode("ask")).resolves.toBeUndefined();
    await expect(omp.currentMode()).resolves.toBe("ask");
    expect(omp.runtimeLaunches()[1]?.argv).toContain("--approval-mode");
    expect(omp.runtimeLaunches()[1]?.argv).toContain("always-ask");
  });

  test("restarts the same conversation after an idle process exit", async () => {
    const omp = new OmpHarness();
    await omp.start({ modeId: "full" });
    const previousId = omp.runtime().state.sessionId;
    omp.processExit("OMP RPC process exited with code null and signal SIGKILL\nBun crashed");
    expect(omp.turnFailures()).toEqual([
      "OMP RPC process exited with code null and signal SIGKILL\nBun crashed",
    ]);

    await omp.startTurn("remember the conversation");
    expect(omp.runtimeLaunches()).toHaveLength(2);
    expect(omp.runtimeLaunches()[1]?.session).toBe("/tmp/omp-session");
    expect(omp.runtime().state.sessionId).toBe(previousId);
    expect(omp.threadStartedSessionIds()).toEqual([]);
    expect(omp.runtime().prompts).toEqual([
      { message: "remember the conversation", imageCount: 0 },
    ]);
  });

  test("reports a mid-turn process exit and resumes on the following prompt", async () => {
    const omp = new OmpHarness();
    await omp.start();
    await omp.requireStartTurn("sleep 30");
    omp.runtime().beginTurn();
    omp.processExit("OMP RPC process exited with code 137 and signal null\nOOM");
    expect(omp.turnFailures()).toEqual([
      "OMP RPC process exited with code 137 and signal null\nOOM",
    ]);
    await omp.startTurn("continue");
    expect(omp.runtimeLaunches()).toHaveLength(2);
    expect(omp.runtime().prompts).toEqual([{ message: "continue", imageCount: 0 }]);
  });

  test("reports an immediate relaunch failure without retrying in a loop", async () => {
    const omp = new OmpHarness();
    await omp.start();
    omp.processExit("OMP RPC process exited with code null and signal SIGKILL");
    omp.failNextStart(new Error("Bun failed during startup"));
    await omp.startTurn("continue");
    expect(omp.turnFailures()).toEqual([
      "OMP RPC process exited with code null and signal SIGKILL",
      "Bun failed during startup",
    ]);
    expect(omp.runtimeLaunches()).toHaveLength(1);
  });

  test("closes a replacement process if the session closes during relaunch", async () => {
    const omp = new OmpHarness();
    await omp.start();
    omp.processExit("OMP RPC process exited with code 1 and signal null");
    const turn = omp.startTurnDetached("continue");
    await omp.close();
    await turn;
    await waitForImmediate();
    expect(omp.runtimeSessions().every((session) => session.closed)).toBe(true);
  });

  test("announces a fresh native session when an internal agent recovers", async () => {
    const omp = new OmpHarness();
    await omp.start({ internal: true });
    const previousId = omp.runtime().state.sessionId;
    omp.processExit("OMP RPC process exited with code 1 and signal null");
    await omp.startTurn("continue");
    expect(omp.runtimeLaunches()[1]?.argv).toContain("--no-session");
    expect(omp.runtime().state.sessionId).not.toBe(previousId);
    expect(omp.threadStartedSessionIds()).toEqual([omp.runtime().state.sessionId]);
  });

  test("leaves the current approval mode in place when relaunch fails", async () => {
    const omp = new OmpHarness();
    await omp.start({ modeId: "full" });
    omp.failNextStart(new Error("OMP launch failed"));
    await expect(omp.setMode("ask")).rejects.toThrow("OMP launch failed");
    expect(await omp.currentMode()).toBe("full");
    expect(omp.runtimeLaunches()).toHaveLength(1);
  });

  test("rejects a running approval-mode change until the turn ends", async () => {
    const omp = new OmpHarness();
    await omp.start({ modeId: "full" });
    await omp.requireStartTurn("work");
    await expect(omp.setMode("ask")).resolves.toEqual({
      type: "warning",
      message: "Change approval mode once the current turn ends",
    });
    expect(omp.runtimeLaunches()).toHaveLength(1);
    expect(await omp.currentMode()).toBe("full");
  });

  test("rewinds natively, interrupts, and shuts down", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await omp.rewind("user-history", "from history");
    expect(omp.branchRequests()).toEqual(["user-history"]);

    await omp.interruptActiveTurn("stop me");
    expect(omp.wasAborted()).toBe(true);
    expect(omp.canceledTurnCount()).toBe(1);

    await omp.close();
    expect(omp.isClosed()).toBe(true);
  });

  test("interrupt terminalizes in-flight tool calls and running subagents", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await omp.requireStartTurn("run something slow");
    const runtime = omp.runtime();
    runtime.beginTurn();
    runtime.emit({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "bash",
      args: { command: "sleep 30" },
    });
    runtime.emit({
      type: "subagent_lifecycle",
      payload: {
        id: "child-1",
        agent: "worker",
        status: "started",
        parentToolCallId: "tool-1",
        index: 0,
      },
    });
    expect(omp.runningToolCallIds()).toEqual(["tool-1"]);
    expect(omp.subagentUpserts()).toEqual([{ id: "child-1", status: "running" }]);

    await omp.interrupt();

    expect(omp.canceledTurnCount()).toBe(1);
    expect(omp.runningToolCallIds()).toEqual([]);
    expect(omp.subagentUpserts()).toEqual([
      { id: "child-1", status: "running" },
      { id: "child-1", status: "canceled" },
    ]);

    // Late progress after interrupt must not resurrect a running card.
    runtime.emit({
      type: "subagent_progress",
      payload: {
        id: "child-1",
        agent: "worker",
        index: 0,
        progress: { id: "child-1", status: "running" },
        parentToolCallId: "tool-1",
      },
    });
    expect(omp.runningToolCallIds()).toEqual([]);
  });

  test("an interrupt that OMP reports as an aborted turn cancels instead of failing", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await omp.requireStartTurn("do something long");
    const runtime = omp.runtime();
    runtime.beginTurn();
    runtime.emit({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "bash",
      args: { command: "sleep 30" },
    });
    runtime.streamAssistantText("working on it");
    // OMP ends the turn with an aborted terminal response before answering the abort.
    runtime.onAbort = () => {
      runtime.emit({ type: "message_end", message: ABORTED_TERMINAL_RESPONSE });
      runtime.finishTurn(ABORTED_TERMINAL_RESPONSE);
    };

    await omp.interrupt();
    await waitForImmediate();
    await waitForImmediate();

    expect(omp.eventTypes().filter(isTurnLifecycle)).toEqual(["turn_started", "turn_canceled"]);
    expect(omp.runningToolCallIds()).toEqual([]);
  });

  test("an aborted turn that settles after the interrupt cancels exactly once", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await omp.requireStartTurn("do something long");
    const runtime = omp.runtime();
    runtime.beginTurn();
    runtime.streamAssistantText("working on it");
    // The provider-idle check is still in flight when the abort is acknowledged.
    const releaseState = runtime.holdStateRequests();
    runtime.emit({ type: "message_end", message: ABORTED_TERMINAL_RESPONSE });
    runtime.finishTurn(ABORTED_TERMINAL_RESPONSE);

    await omp.interrupt();
    releaseState();
    await waitForImmediate();
    await waitForImmediate();

    expect(omp.eventTypes().filter(isTurnLifecycle)).toEqual(["turn_started", "turn_canceled"]);
  });

  test("an autonomous OMP turn aborted with no client turn id cancels", async () => {
    const omp = new OmpHarness();
    await omp.start();

    const runtime = omp.runtime();
    runtime.beginTurn();
    runtime.streamAssistantText("autonomous work");
    runtime.onAbort = () => {
      runtime.emit({ type: "message_end", message: ABORTED_TERMINAL_RESPONSE });
      runtime.finishTurn(ABORTED_TERMINAL_RESPONSE);
    };

    await omp.interrupt();
    await waitForImmediate();
    await waitForImmediate();

    expect(omp.eventTypes().filter(isTurnLifecycle)).toEqual(["turn_started", "turn_canceled"]);
  });

  test("a resumed session does not re-emit replayed events as live timeline items", async () => {
    const omp = new OmpHarness();
    await omp.resume({
      user: { id: "user-history", text: "continue the audit" },
      assistant: { id: "assistant-history", text: "audit context restored" },
    });

    const runtime = omp.runtime();
    // OMP replays pre-existing conversation on startup with --session.
    runtime.acceptPrompt("continue the audit", "user-history");
    runtime.streamAssistantText("audit context restored", "assistant-history");
    expect(omp.timeline()).toEqual([]);

    // The first live prompt flows normally.
    await expect(omp.runPrompt("next step", "on it")).resolves.toMatchObject({
      finalText: "on it",
    });
    expect(omp.timeline()).toEqual([
      { type: "user_message", text: "next step", messageId: "user-1" },
      { type: "assistant_message", text: "on it", messageId: "omp-assistant-1" },
    ]);
  });

  test("re-emitted user message_end frames dedupe by native entry id", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await expect(omp.runPrompt("hello OMP", "hello from OMP")).resolves.toMatchObject({
      finalText: "hello from OMP",
    });
    // OMP can re-send message_end for an entry it already surfaced.
    omp.runtime().acceptPrompt("hello OMP", "user-1");
    expect(omp.timeline().filter((item) => item.type === "user_message")).toEqual([
      { type: "user_message", text: "hello OMP", messageId: "user-1" },
    ]);
  });
});
