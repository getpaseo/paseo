import { describe, expect, test } from "vitest";
import { setImmediate as waitForImmediate } from "node:timers/promises";

import type { PaseoToolCatalog } from "../../tools/types.js";
import type { OmpNoTurnScheduler, OmpProviderIdleScheduler } from "./agent.js";
import type { OmpUsagePollScheduler } from "./usage-poller.js";
import { resolveOmpProviderParams } from "./provider-config.js";
import { OmpHarness } from "./test-utils/omp-harness.js";

test("OMP ready timeout defaults to 20 seconds and RPC timeout overrides both", () => {
  expect(resolveOmpProviderParams({}).runtimeProviderParams).toMatchObject({
    readyTimeoutMs: 20_000,
    rpcTimeoutMs: 60_000,
  });
  expect(resolveOmpProviderParams({ rpcTimeoutMs: 90_000 }).runtimeProviderParams).toMatchObject({
    readyTimeoutMs: 90_000,
    rpcTimeoutMs: 90_000,
  });
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
      supportsMcpServers: false,
      supportsNativePaseoTools: true,
    });
  });

  test("preserves max as the selected thinking option", async () => {
    const omp = new OmpHarness();
    await omp.start({ thinkingOptionId: "max" });

    expect(omp.launchConfiguration().argv).toEqual(expect.arrayContaining(["--thinking", "max"]));
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

  test("does not complete on OMP's extension-notice agent_end", async () => {
    const omp = new OmpHarness();
    await omp.start();

    await expect(
      omp.runPromptAfterExtensionNotice("hello OMP", "model turn completed"),
    ).resolves.toMatchObject({ finalText: expect.stringContaining("model turn completed") });
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
    // Non-notice custom messages still fall through as assistant messages.
    expect(omp.timeline().filter((item) => item.type === "assistant_message")).toMatchObject([
      { text: "done" },
      { text: "plain custom status text" },
    ]);
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
    await expect(omp.setMode("ask")).resolves.toEqual({
      type: "warning",
      message: "Start a new OMP session to change approval mode",
    });
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

describe("OMP active-turn steering", () => {
  function userMessages(omp: OmpHarness) {
    return omp.timeline().filter((item) => item.type === "user_message");
  }

  test("steers the active turn and correlates the echoed user message", async () => {
    const omp = new OmpHarness();
    await omp.start();
    const runtime = omp.runtime();
    const turnId = await omp.startTrackedTurn("fix the tests", {
      clientMessageId: "client-prompt-1",
    });
    runtime.beginTurn();
    runtime.acceptPrompt("fix the tests", "user-prompt-1");

    const result = await omp.steer("steer this turn", {
      expectedTurnId: turnId,
      clientMessageId: "client-steer-1",
    });
    expect(result).toEqual({ status: "accepted" });
    expect(runtime.steerActiveTurnRequests).toEqual([
      { message: "steer this turn", imageCount: 0 },
    ]);

    runtime.acceptPrompt("steer this turn", "entry-steer-1");
    expect(userMessages(omp)).toEqual([
      {
        type: "user_message",
        text: "fix the tests",
        messageId: "user-prompt-1",
        clientMessageId: "client-prompt-1",
      },
      {
        type: "user_message",
        text: "steer this turn",
        messageId: "entry-steer-1",
        clientMessageId: "client-steer-1",
      },
    ]);
  });

  test("forwards steer images when the model supports image input", async () => {
    const omp = new OmpHarness();
    await omp.start();
    const runtime = omp.runtime();
    runtime.state = {
      ...runtime.state,
      model: { provider: "anthropic", id: "claude", name: "claude", input: ["text", "image"] },
    };
    await omp.syncRuntimeState();
    const turnId = await omp.startTrackedTurn("work");
    runtime.beginTurn();

    const result = await omp.steer(
      [
        { type: "text", text: "look at this" },
        { type: "image", data: "aGk=", mimeType: "image/png" },
      ],
      { expectedTurnId: turnId },
    );

    expect(result).toEqual({ status: "accepted" });
    expect(runtime.steerActiveTurnRequests).toEqual([{ message: "look at this", imageCount: 1 }]);
  });

  test("reports unavailable for stale and idle turns without sending a steer", async () => {
    const omp = new OmpHarness();
    await omp.start();
    const runtime = omp.runtime();
    const turnId = await omp.startTrackedTurn("run");
    runtime.beginTurn();
    runtime.acceptPrompt("run", "user-1");

    const stale = await omp.steer("steer", { expectedTurnId: "turn-that-ended" });
    expect(stale).toEqual({ status: "unavailable" });

    runtime.streamAssistantText("done");
    runtime.finishTurn();
    await omp.settleTurnCompletion();
    const idle = await omp.steer("steer", { expectedTurnId: turnId });
    expect(idle).toEqual({ status: "unavailable" });
    expect(runtime.steerActiveTurnRequests).toEqual([]);
  });

  test("keeps slash-command steers on the interrupt fallback", async () => {
    const omp = new OmpHarness();
    await omp.start();
    const runtime = omp.runtime();
    const turnId = await omp.startTrackedTurn("run");
    runtime.beginTurn();

    const result = await omp.steer("/model", { expectedTurnId: turnId });

    expect(result).toEqual({ status: "unavailable" });
    expect(runtime.steerActiveTurnRequests).toEqual([]);
  });

  test("reports unavailable when the ready frame did not advertise steering", async () => {
    const omp = new OmpHarness();
    await omp.start();
    const runtime = omp.runtime();
    runtime.capabilities.activeTurnSteering = false;
    const turnId = await omp.startTrackedTurn("run");
    runtime.beginTurn();

    const result = await omp.steer("steer", { expectedTurnId: turnId });

    expect(result).toEqual({ status: "unavailable" });
    expect(runtime.steerActiveTurnRequests).toEqual([]);
  });

  test("correlates a steered echo that arrives before the RPC response", async () => {
    const omp = new OmpHarness();
    await omp.start();
    const runtime = omp.runtime();
    const turnId = await omp.startTrackedTurn("work", { clientMessageId: "client-prompt-1" });
    runtime.beginTurn();
    runtime.acceptPrompt("work", "user-prompt-1");

    runtime.holdNextSteerResponse();
    const steering = omp.steer("redirect", {
      expectedTurnId: turnId,
      clientMessageId: "client-steer-1",
    });
    runtime.acceptPrompt("redirect", "entry-steer-1");
    await runtime.releaseHeldSteerResponse({ accepted: true });

    await expect(steering).resolves.toEqual({ status: "accepted" });
    expect(userMessages(omp)).toContainEqual({
      type: "user_message",
      text: "redirect",
      messageId: "entry-steer-1",
      clientMessageId: "client-steer-1",
    });
  });

  test("orders foreground before steer when their texts are identical", async () => {
    const omp = new OmpHarness();
    await omp.start();
    const runtime = omp.runtime();
    const turnId = await omp.startTrackedTurn("do it", { clientMessageId: "client-prompt-1" });
    runtime.beginTurn();

    // The steer is admitted before OMP has echoed the foreground prompt and
    // carries the exact same text.
    const result = await omp.steer("do it", {
      expectedTurnId: turnId,
      clientMessageId: "client-steer-1",
    });
    expect(result).toEqual({ status: "accepted" });

    // OMP echoes in provider order: foreground prompt first, then the steer.
    runtime.acceptPrompt("do it", "entry-foreground");
    runtime.acceptPrompt("do it", "entry-steer");

    expect(userMessages(omp)).toEqual([
      {
        type: "user_message",
        text: "do it",
        messageId: "entry-foreground",
        clientMessageId: "client-prompt-1",
      },
      {
        type: "user_message",
        text: "do it",
        messageId: "entry-steer",
        clientMessageId: "client-steer-1",
      },
    ]);
  });

  test("correlates an expanded foreground echo and a following steer", async () => {
    const omp = new OmpHarness();
    await omp.start();
    const runtime = omp.runtime();
    const turnId = await omp.startTrackedTurn("/plan ship it", {
      clientMessageId: "client-prompt-1",
    });
    runtime.beginTurn();

    // OMP expands slash/template prompts before echoing the user entry, so the
    // foreground echo text differs from the submitted prompt.
    runtime.acceptPrompt("Expanded plan instructions: ship it", "entry-foreground");

    const result = await omp.steer("focus on tests", {
      expectedTurnId: turnId,
      clientMessageId: "client-steer-1",
    });
    expect(result).toEqual({ status: "accepted" });
    runtime.acceptPrompt("focus on tests", "entry-steer");

    expect(userMessages(omp)).toEqual([
      {
        type: "user_message",
        text: "Expanded plan instructions: ship it",
        messageId: "entry-foreground",
        clientMessageId: "client-prompt-1",
      },
      {
        type: "user_message",
        text: "focus on tests",
        messageId: "entry-steer",
        clientMessageId: "client-steer-1",
      },
    ]);
  });

  test("a re-emitted no-ID echo does not consume a pending steer correlation", async () => {
    const omp = new OmpHarness();
    await omp.start();
    const runtime = omp.runtime();
    const turnId = await omp.startTrackedTurn("work", { clientMessageId: "client-prompt-1" });
    runtime.beginTurn();
    runtime.branchMessages = [{ entryId: "entry-work", text: "work" }];
    runtime.acceptPromptWithoutId("work");
    await waitForImmediate();

    // A steer with the same text as the already-surfaced foreground entry.
    await omp.steer("work", { expectedTurnId: turnId, clientMessageId: "client-steer-1" });

    // Hold the duplicate lookup while the genuine same-text echo arrives. The
    // duplicate sees only the old entry and must not reserve the steer identity.
    runtime.holdNextBranchMessageResponses(2);
    runtime.acceptPromptWithoutId("work");
    runtime.acceptPromptWithoutId("work");
    expect(runtime.getBranchMessagesRequestCount).toBe(3);
    await runtime.releaseHeldBranchMessageResponse(0, [{ entryId: "entry-work", text: "work" }]);
    await runtime.releaseHeldBranchMessageResponse(0, [
      { entryId: "entry-work", text: "work" },
      { entryId: "entry-steer", text: "work" },
    ]);
    expect(userMessages(omp)).toEqual([
      {
        type: "user_message",
        text: "work",
        messageId: "entry-work",
        clientMessageId: "client-prompt-1",
      },
      {
        type: "user_message",
        text: "work",
        messageId: "entry-steer",
        clientMessageId: "client-steer-1",
      },
    ]);
  });

  test("repeated identical steers resolve distinct native entries without IDs", async () => {
    const omp = new OmpHarness();
    await omp.start();
    const runtime = omp.runtime();
    const turnId = await omp.startTrackedTurn("work", { clientMessageId: "client-prompt-1" });
    runtime.beginTurn();
    runtime.branchMessages = [{ entryId: "entry-work", text: "work" }];
    runtime.acceptPromptWithoutId("work");
    await waitForImmediate();

    await omp.steer("again", { expectedTurnId: turnId, clientMessageId: "client-steer-1" });
    await omp.steer("again", { expectedTurnId: turnId, clientMessageId: "client-steer-2" });
    runtime.branchMessages = [
      { entryId: "entry-work", text: "work" },
      { entryId: "entry-again-1", text: "again" },
      { entryId: "entry-again-2", text: "again" },
    ];
    // Resolve both native-ID lookups in reverse order. Emission still waits
    // for the first echo so the provider/client identity pairs remain FIFO.
    runtime.holdNextBranchMessageResponses(2);
    runtime.acceptPromptWithoutId("again");
    runtime.acceptPromptWithoutId("again");
    expect(runtime.getBranchMessagesRequestCount).toBe(3);
    await runtime.releaseHeldBranchMessageResponse(1);
    await waitForImmediate();
    expect(userMessages(omp).filter((row) => row.text === "again")).toEqual([]);
    await runtime.releaseHeldBranchMessageResponse(0);

    const again = userMessages(omp).filter((row) => row.text === "again");
    expect(again).toEqual([
      {
        type: "user_message",
        text: "again",
        messageId: "entry-again-1",
        clientMessageId: "client-steer-1",
      },
      {
        type: "user_message",
        text: "again",
        messageId: "entry-again-2",
        clientMessageId: "client-steer-2",
      },
    ]);
  });

  test("keeps identical steer texts correlated in admission order", async () => {
    const omp = new OmpHarness();
    await omp.start();
    const runtime = omp.runtime();
    const turnId = await omp.startTrackedTurn("work");
    runtime.beginTurn();
    runtime.acceptPrompt("work", "user-prompt-1");

    await omp.steer("again", { expectedTurnId: turnId, clientMessageId: "client-steer-1" });
    await omp.steer("again", { expectedTurnId: turnId, clientMessageId: "client-steer-2" });
    runtime.acceptPrompt("again", "entry-1");
    runtime.acceptPrompt("again", "entry-2");

    expect(userMessages(omp)).toEqual([
      { type: "user_message", text: "work", messageId: "user-prompt-1" },
      {
        type: "user_message",
        text: "again",
        messageId: "entry-1",
        clientMessageId: "client-steer-1",
      },
      {
        type: "user_message",
        text: "again",
        messageId: "entry-2",
        clientMessageId: "client-steer-2",
      },
    ]);
  });

  test("does not reuse the foreground client ID for a steer without one", async () => {
    const omp = new OmpHarness();
    await omp.start();
    const runtime = omp.runtime();
    const turnId = await omp.startTrackedTurn("work", { clientMessageId: "client-prompt-1" });
    runtime.beginTurn();
    runtime.acceptPrompt("work", "user-prompt-1");

    await omp.steer("steer without a client ID", { expectedTurnId: turnId });
    runtime.acceptPrompt("steer without a client ID", "entry-steer-1");

    expect(userMessages(omp)).toContainEqual({
      type: "user_message",
      text: "steer without a client ID",
      messageId: "entry-steer-1",
    });
  });

  test("removes exactly the rejected provisional entry on accepted:false", async () => {
    const omp = new OmpHarness();
    await omp.start();
    const runtime = omp.runtime();
    const turnId = await omp.startTrackedTurn("work");
    runtime.beginTurn();
    runtime.acceptPrompt("work", "user-prompt-1");

    runtime.steerAccepted = false;
    const rejected = await omp.steer("dup", {
      expectedTurnId: turnId,
      clientMessageId: "client-steer-1",
    });
    expect(rejected).toEqual({ status: "unavailable" });

    runtime.steerAccepted = true;
    const accepted = await omp.steer("dup", {
      expectedTurnId: turnId,
      clientMessageId: "client-steer-2",
    });
    expect(accepted).toEqual({ status: "accepted" });

    runtime.acceptPrompt("dup", "entry-1");
    expect(userMessages(omp)).toContainEqual({
      type: "user_message",
      text: "dup",
      messageId: "entry-1",
      clientMessageId: "client-steer-2",
    });
  });

  test("surfaces an ambiguous transport failure and keeps the correlation", async () => {
    const omp = new OmpHarness();
    await omp.start();
    const runtime = omp.runtime();
    const turnId = await omp.startTrackedTurn("work");
    runtime.beginTurn();
    runtime.acceptPrompt("work", "user-prompt-1");

    runtime.steerActiveTurnError = new Error("OMP RPC request timed out");
    await expect(
      omp.steer("maybe delivered", { expectedTurnId: turnId, clientMessageId: "client-steer-1" }),
    ).rejects.toThrow("OMP RPC request timed out");

    // If OMP did read the steer despite the transport failure, its echo still
    // correlates because the provisional entry survives until terminal cleanup.
    runtime.acceptPrompt("maybe delivered", "entry-steer-1");
    expect(userMessages(omp)).toContainEqual({
      type: "user_message",
      text: "maybe delivered",
      messageId: "entry-steer-1",
      clientMessageId: "client-steer-1",
    });
  });

  test("throws when OMP accepts a steer for a turn that ended meanwhile", async () => {
    const omp = new OmpHarness();
    await omp.start();
    const runtime = omp.runtime();
    const turnId = await omp.startTrackedTurn("work");
    runtime.beginTurn();
    runtime.acceptPrompt("work", "user-prompt-1");

    runtime.holdNextSteerResponse();
    const steering = omp.steer("late steer", {
      expectedTurnId: turnId,
      clientMessageId: "client-steer-1",
    });
    // The steer's fate is ambiguous; unavailable would trigger the manager's
    // interrupt-and-replace fallback and deliver the message twice.
    const rejection = expect(steering).rejects.toThrow(
      "OMP accepted a steer for a turn that is no longer active",
    );
    runtime.streamAssistantText("done");
    runtime.finishTurn();
    await omp.settleTurnCompletion();
    await runtime.releaseHeldSteerResponse({ accepted: true });

    await rejection;
    expect(runtime.controlRequests).toEqual([]);
  });

  test("denies pending permissions only after the steer is accepted", async () => {
    const omp = new OmpHarness();
    await omp.start();
    const runtime = omp.runtime();
    const turnId = await omp.startTrackedTurn("work");
    runtime.beginTurn();
    omp.requestToolApproval({ id: "perm-1", tool: "bash", detail: "rm -rf build" });
    expect(omp.pendingPermissions()).toHaveLength(1);

    runtime.holdNextSteerResponse();
    const steering = omp.steer("answer instead", {
      expectedTurnId: turnId,
      clearPendingPermissions: true,
    });
    await waitForImmediate();
    expect(omp.extensionUiResponses()).toEqual([]);

    await runtime.releaseHeldSteerResponse({ accepted: true });
    await expect(steering).resolves.toEqual({ status: "accepted" });
    expect(omp.extensionUiResponses()).toEqual([{ id: "perm-1", response: { value: "Deny" } }]);
    expect(omp.pendingPermissions()).toEqual([]);
  });

  test("leaves permissions open for a steer without the clearing flag", async () => {
    const omp = new OmpHarness();
    await omp.start();
    const runtime = omp.runtime();
    const turnId = await omp.startTrackedTurn("work");
    runtime.beginTurn();
    omp.requestToolApproval({ id: "perm-1", tool: "bash", detail: "rm -rf build" });

    const result = await omp.steer("answer instead", { expectedTurnId: turnId });

    expect(result).toEqual({ status: "accepted" });
    expect(omp.extensionUiResponses()).toEqual([]);
    expect(omp.pendingPermissions()).toHaveLength(1);
  });

  test("atomically clears the OMP queue while aborting an active turn", async () => {
    const omp = new OmpHarness();
    await omp.start();
    const runtime = omp.runtime();
    await omp.startTrackedTurn("work");
    runtime.beginTurn();

    await omp.interrupt();

    expect(runtime.controlRequests).toEqual([{ type: "abort", clearQueue: true }]);
    expect(omp.canceledTurnCount()).toBe(1);
  });

  test("does not terminalize locally when atomic abort-with-clear fails", async () => {
    const omp = new OmpHarness();
    await omp.start();
    const runtime = omp.runtime();
    await omp.startTrackedTurn("work");
    runtime.beginTurn();

    runtime.abortError = new Error("atomic abort failed");
    await expect(omp.interrupt()).rejects.toThrow("atomic abort failed");

    expect(runtime.controlRequests).toEqual([{ type: "abort", clearQueue: true }]);
    expect(runtime.abortRequested).toBe(false);
    expect(omp.canceledTurnCount()).toBe(0);
  });

  test("sends plain abort when the binary lacks steering", async () => {
    const omp = new OmpHarness();
    await omp.start();
    const runtime = omp.runtime();
    runtime.capabilities.activeTurnSteering = false;
    await omp.startTrackedTurn("work");
    runtime.beginTurn();

    await omp.interrupt();

    expect(runtime.controlRequests).toEqual([{ type: "abort" }]);
    expect(omp.canceledTurnCount()).toBe(1);
  });

  test("drops pending steer correlation once the turn completes", async () => {
    const omp = new OmpHarness();
    await omp.start();
    const runtime = omp.runtime();
    const first = await omp.startTrackedTurn("work");
    runtime.beginTurn();
    runtime.acceptPrompt("work", "user-1");
    await omp.steer("stale steer", { expectedTurnId: first, clientMessageId: "client-steer-1" });
    runtime.streamAssistantText("done");
    runtime.finishTurn();
    await omp.settleTurnCompletion();

    await omp.startTrackedTurn("next");
    runtime.beginTurn();
    runtime.acceptPrompt("stale steer", "entry-late");

    expect(userMessages(omp)).toContainEqual({
      type: "user_message",
      text: "stale steer",
      messageId: "entry-late",
    });
  });

  test("drops pending steer correlation when the OMP process exits", async () => {
    const omp = new OmpHarness();
    await omp.start();
    const runtime = omp.runtime();
    const turnId = await omp.startTrackedTurn("work", { clientMessageId: "client-prompt-1" });
    runtime.beginTurn();
    runtime.acceptPrompt("work", "user-prompt-1");
    await omp.steer("orphan steer", { expectedTurnId: turnId, clientMessageId: "client-steer-1" });

    runtime.emit({ type: "process_exit", error: "omp crashed" });
    runtime.acceptPrompt("orphan steer", "entry-late");

    expect(userMessages(omp)).toContainEqual({
      type: "user_message",
      text: "orphan steer",
      messageId: "entry-late",
    });
  });
});
