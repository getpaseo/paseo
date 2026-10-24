import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { PiRpcAgentClient } from "./providers/pi/agent.js";
import { FakePi } from "./providers/pi/test-utils/fake-pi.js";
import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentProvider,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
  ProviderCatalog,
} from "./agent-sdk-types.js";
import type { ProviderSubagentInputEvent } from "./provider-subagents/store.js";

/**
 * Stuck-running provider subagent cards are a lifecycle problem, not a presentation one: a row is
 * born `running` and only a provider update can settle it. These cover the manager's two finalize
 * points — the turn boundary and history replay — and, above all, that neither touches a row whose
 * run can still report.
 */

const TEST_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
};

const AGENT_ID = "00000000-0000-4000-8000-000000000001";

/** Long enough that no poll could have re-reported the row inside it. */
const QUIET_FOR_MS = 60_000;

class TestAgentSession implements AgentSession {
  readonly capabilities = TEST_CAPABILITIES;
  readonly id = "test-session";
  private historyEvents: AgentStreamEvent[] = [];
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();

  constructor(readonly provider: AgentProvider) {}

  async run(): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  async startTurn(_prompt: AgentPromptInput): Promise<{ turnId: string }> {
    return { turnId: "turn-1" };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  setHistory(events: AgentStreamEvent[]): void {
    this.historyEvents = [...events];
  }

  pushEvent(event: AgentStreamEvent): void {
    for (const callback of this.subscribers) callback(event);
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    for (const event of this.historyEvents) yield event;
  }

  async getRuntimeInfo() {
    return { provider: this.provider, sessionId: this.id, model: null, modeId: null };
  }

  async getAvailableModes() {
    return [];
  }

  async getCurrentMode() {
    return null;
  }

  async setMode(): Promise<void> {}

  getPendingPermissions() {
    return [];
  }

  async respondToPermission(): Promise<void> {}

  describePersistence(): AgentPersistenceHandle {
    return { provider: this.provider, sessionId: this.id };
  }

  async interrupt(): Promise<void> {}

  async close(): Promise<void> {}
}

class TestAgentClient implements AgentClient {
  readonly capabilities = TEST_CAPABILITIES;
  session?: TestAgentSession;

  constructor(readonly provider: AgentProvider) {}

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    this.session = new TestAgentSession(config.provider);
    return this.session;
  }

  async resumeSession(): Promise<AgentSession> {
    this.session ??= new TestAgentSession(this.provider);
    return this.session;
  }

  async fetchCatalog(): Promise<ProviderCatalog> {
    return {
      models: [{ provider: this.provider, id: "test-model", label: "Test Model", isDefault: true }],
      modes: [],
    };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

interface Harness {
  manager: AgentManager;
  session: TestAgentSession;
  agentId: string;
  cleanup: () => void;
}

async function createHarness(provider: AgentProvider): Promise<Harness> {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-provider-subagents-"));
  const client = new TestAgentClient(provider);
  const manager = new AgentManager({
    clients: { [provider]: client },
    idFactory: () => AGENT_ID,
    logger: createTestLogger(),
  });
  await manager.createAgent({ provider, cwd: workdir }, AGENT_ID, { workspaceId: undefined });
  if (!client.session) throw new Error("Test client did not create a session");
  return {
    manager,
    session: client.session,
    agentId: AGENT_ID,
    cleanup: () => rmSync(workdir, { recursive: true, force: true }),
  };
}

function subagentEvent(
  provider: AgentProvider,
  event: ProviderSubagentInputEvent,
): AgentStreamEvent {
  return { type: "provider_subagent", provider, event };
}

function turnCompleted(provider: AgentProvider): AgentStreamEvent {
  return { type: "turn_completed", provider, turnId: "turn-1" };
}

async function drainSessionEvents(): Promise<void> {
  for (let index = 0; index < 10_000; index++) await Promise.resolve();
}

async function pushEvent(harness: Harness, event: AgentStreamEvent): Promise<void> {
  harness.session.pushEvent(event);
  await drainSessionEvents();
}

function status(harness: Harness, subagentId: string) {
  return harness.manager.getProviderSubagent(harness.agentId, subagentId)?.status;
}

/** Moves the clock past the liveness window without touching timers the manager runs on. */
function advanceClock(ms: number): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(Date.now() + ms));
}

/** Waits on real time: the Pi adapter polls on a real interval. */
async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for the Pi adapter poll");
}

afterEach(() => {
  vi.useRealTimers();
});

describe("provider subagent finalize", () => {
  test("a turn end cancels a running Pi row that nothing has re-reported", async () => {
    const harness = await createHarness("pi");
    try {
      await pushEvent(
        harness,
        subagentEvent("pi", {
          type: "upsert",
          id: "call-1",
          title: "scout",
          status: "running",
          liveness: "poll",
        }),
      );
      expect(status(harness, "call-1")).toBe("running");

      advanceClock(QUIET_FOR_MS);
      await pushEvent(harness, turnCompleted("pi"));

      expect(status(harness, "call-1")).toBe("canceled");
    } finally {
      harness.cleanup();
    }
  });

  test("a re-check armed by one turn leaves a later turn's synchronous child alone", async () => {
    const harness = await createHarness("pi");
    try {
      vi.useFakeTimers();
      // A spawn call interrupted before it reported: the turn end arms a re-check for the moment its
      // silence becomes proof.
      await pushEvent(
        harness,
        subagentEvent("pi", {
          type: "upsert",
          id: "call-orphan",
          title: "scout",
          status: "running",
          liveness: "poll",
        }),
      );
      await pushEvent(harness, turnCompleted("pi"));
      expect(status(harness, "call-orphan")).toBe("running");

      // The next turn launches a synchronous child. That call is poll-marked at spawn and gets no
      // poll until its result lands, so it stays quiet for longer than the window while it works.
      await vi.advanceTimersByTimeAsync(2_000);
      await pushEvent(
        harness,
        subagentEvent("pi", {
          type: "upsert",
          id: "call-sync",
          title: "reviewer",
          status: "running",
          liveness: "poll",
        }),
      );
      expect(status(harness, "call-sync")).toBe("running");

      // The armed re-check settles the row it was armed for. Judging the next turn's fresh row here
      // would cancel a child whose foreground call is still running.
      await vi.advanceTimersByTimeAsync(3_001);
      expect(status(harness, "call-orphan")).toBe("canceled");
      expect(status(harness, "call-sync")).toBe("running");

      // Nothing captured is left to prove, so nothing is left armed: the fresh row survives a whole
      // further window and no timer of ours is pending.
      await vi.advanceTimersByTimeAsync(QUIET_FOR_MS);
      expect(status(harness, "call-sync")).toBe("running");
      expect(vi.getTimerCount()).toBe(0);

      // The call's result lands and settles its own row normally.
      await pushEvent(
        harness,
        subagentEvent("pi", {
          type: "upsert",
          id: "call-sync",
          title: "reviewer",
          status: "completed",
        }),
      );
      expect(status(harness, "call-sync")).toBe("completed");
    } finally {
      harness.cleanup();
    }
  });

  test("a turn end inside the window re-checks an orphaned placeholder once its silence proves it", async () => {
    const harness = await createHarness("pi");
    try {
      vi.useFakeTimers();
      // A spawn call interrupted before it reported leaves this placeholder behind: nothing polls it,
      // so no later report refreshes it either.
      await pushEvent(
        harness,
        subagentEvent("pi", {
          type: "upsert",
          id: "call-1",
          title: "scout",
          status: "running",
          liveness: "poll",
        }),
      );
      // The stop's turn end lands inside the liveness window, where the sweep cannot tell this row
      // from a live poll's.
      await pushEvent(harness, turnCompleted("pi"));
      expect(status(harness, "call-1")).toBe("running");

      // The parent stays idle, so this re-check is the only thing that will ever look again.
      await vi.advanceTimersByTimeAsync(5_001);
      expect(status(harness, "call-1")).toBe("canceled");
    } finally {
      harness.cleanup();
    }
  });

  test("a poll that re-dates the row inside the sweep window re-arms the re-check", async () => {
    const harness = await createHarness("pi");
    try {
      vi.useFakeTimers();
      const poll = () =>
        pushEvent(
          harness,
          subagentEvent("pi", {
            type: "upsert",
            id: "call-1",
            title: "scout",
            status: "running",
            liveness: "poll",
          }),
        );
      await poll();
      // The turn end lands inside the window, so it arms a re-check instead of canceling.
      await pushEvent(harness, turnCompleted("pi"));
      expect(status(harness, "call-1")).toBe("running");

      // The live poll re-dates the row before that re-check fires: the scheduled look no longer
      // proves anything, and cancelling here would kill a run that is still reporting.
      await vi.advanceTimersByTimeAsync(2_000);
      await poll();
      await vi.advanceTimersByTimeAsync(3_001);
      expect(status(harness, "call-1")).toBe("running");

      // The re-check re-armed itself, so the row settles once the poll really does go quiet.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(status(harness, "call-1")).toBe("canceled");
    } finally {
      harness.cleanup();
    }
  });

  test("a turn end leaves a Pi row that is still reporting alone", async () => {
    const harness = await createHarness("pi");
    try {
      await pushEvent(
        harness,
        subagentEvent("pi", {
          type: "upsert",
          id: "call-1",
          title: "scout",
          status: "running",
          liveness: "poll",
        }),
      );
      await pushEvent(harness, turnCompleted("pi"));

      expect(status(harness, "call-1")).toBe("running");
    } finally {
      harness.cleanup();
    }
  });

  test("a turn end leaves a quiet non-polling Pi-extension row alone", async () => {
    const harness = await createHarness("pi");
    try {
      await pushEvent(
        harness,
        subagentEvent("pi", { type: "upsert", id: "call-1", title: "scout", status: "running" }),
      );

      advanceClock(QUIET_FOR_MS);
      await pushEvent(harness, turnCompleted("pi"));

      expect(status(harness, "call-1")).toBe("running");
    } finally {
      harness.cleanup();
    }
  });

  test("a poll-backed row survives consecutive turn ends while its poll keeps reporting", async () => {
    const harness = await createHarness("pi");
    try {
      const poll = () =>
        pushEvent(
          harness,
          subagentEvent("pi", {
            type: "upsert",
            id: "call-1",
            title: "scout",
            status: "running",
            liveness: "poll",
          }),
        );
      await poll();
      advanceClock(QUIET_FOR_MS);
      await poll();
      await pushEvent(harness, turnCompleted("pi"));
      expect(status(harness, "call-1")).toBe("running");

      advanceClock(QUIET_FOR_MS);
      await poll();
      await pushEvent(harness, turnCompleted("pi"));
      expect(status(harness, "call-1")).toBe("running");
    } finally {
      harness.cleanup();
    }
  });

  test(
    "a turn end during a status-file miss streak leaves the live poll's row running",
    { timeout: 15_000 },
    async () => {
      // The real Pi adapter, so the miss ticks come from the poll that protects the row instead of
      // from a hand-written upsert.
      const pi = new FakePi();
      const client = new PiRpcAgentClient({ logger: pino({ level: "silent" }), runtime: pi });
      // CI runners have no pi installation; the runtime is the FakePi above, so only the
      // availability probe needs a stub.
      vi.spyOn(client, "isAvailable").mockResolvedValue(true);
      const workdir = mkdtempSync(join(tmpdir(), "agent-manager-provider-subagent-poll-"));
      const manager = new AgentManager({
        clients: { pi: client },
        idFactory: () => AGENT_ID,
        logger: createTestLogger(),
      });
      try {
        await manager.createAgent({ provider: "pi", cwd: workdir }, AGENT_ID, {
          workspaceId: undefined,
        });
        const piSession = pi.latestSession();
        // An async spawn whose status directory never appears: every poll tick is a miss.
        piSession.emit({
          type: "tool_execution_start",
          toolCallId: "call-1",
          toolName: "subagent",
          args: { agent: "scout", task: "Inspect", async: true },
        });
        piSession.emit({
          type: "tool_execution_end",
          toolCallId: "call-1",
          toolName: "subagent",
          result: {
            details: {
              mode: "single",
              runId: "run-1",
              asyncId: "run-1",
              asyncDir: join(workdir, "gone"),
              results: [],
            },
          },
        });
        const row = () => manager.getProviderSubagent(AGENT_ID, "call-1");
        await waitFor(() => row()?.status === "running" && row()?.liveness === "poll");

        for (let turn = 0; turn < 2; turn++) {
          // A miss tick re-reports the row, then the turn ends inside the miss budget: the silence is
          // a file the run has not written yet, not a dead poll.
          const reportedAt = row()?.updatedAt;
          await waitFor(() => row()?.updatedAt !== reportedAt);
          piSession.emit({ type: "agent_start" });
          piSession.emit({ type: "agent_end" });
          await drainSessionEvents();
          expect(row()?.status).toBe("running");
        }
      } finally {
        try {
          await manager.closeAgent(AGENT_ID);
        } catch {
          // A createAgent failure leaves nothing to close; the workdir cleanup must still run.
        } finally {
          rmSync(workdir, { recursive: true, force: true });
        }
      }
    },
  );

  test("a turn end leaves another provider's quiet row alone: it has no poll to prove life", async () => {
    const harness = await createHarness("claude");
    try {
      await pushEvent(
        harness,
        subagentEvent("claude", {
          type: "upsert",
          id: "task-1",
          title: "general-purpose",
          status: "running",
        }),
      );

      advanceClock(QUIET_FOR_MS);
      await pushEvent(harness, turnCompleted("claude"));

      expect(status(harness, "task-1")).toBe("running");
    } finally {
      harness.cleanup();
    }
  });

  test("replay settles a poll-backed running row: replay has no poll to adopt it", async () => {
    const harness = await createHarness("pi");
    try {
      harness.session.setHistory([
        subagentEvent("pi", {
          type: "upsert",
          id: "call-polled",
          title: "scout",
          status: "running",
          liveness: "poll",
        }),
      ]);
      await harness.manager.hydrateTimelineFromProvider(harness.agentId, { force: true });

      expect(status(harness, "call-polled")).toBe("canceled");
    } finally {
      harness.cleanup();
    }
  });

  test("the prime on agent load settles a poll-backed running row: a restart has no poll either", async () => {
    const harness = await createHarness("pi");
    try {
      // A daemon restart or an agent reload re-reads provider history once, without force. Nothing
      // re-creates the live session's poll there either, so the row must not come back every reload.
      harness.session.setHistory([
        subagentEvent("pi", {
          type: "upsert",
          id: "call-prime",
          title: "scout",
          status: "running",
          liveness: "poll",
        }),
      ]);
      await harness.manager.reloadAgentSession(harness.agentId, undefined, {
        rehydrateFromDisk: true,
      });
      expect(harness.manager.getAgent(harness.agentId)?.historyPrimed).toBe(false);
      await harness.manager.hydrateTimelineFromProvider(harness.agentId, { broadcast: true });

      expect(status(harness, "call-prime")).toBe("canceled");
    } finally {
      harness.cleanup();
    }
  });

  test("replay settles a row that was already canceled: the replay proves no life either", async () => {
    const harness = await createHarness("pi");
    try {
      // A turn-end sweep canceled this row while its poll was quiet, and a rewind replays the same
      // async spawn: replay maps it back to running with the poll marker, while no live poll is
      // behind it. Settling on id presence alone would leave a spinner nothing can update, so the
      // row settles again.
      await pushEvent(
        harness,
        subagentEvent("pi", {
          type: "upsert",
          id: "call-canceled",
          title: "scout",
          status: "canceled",
          liveness: "poll",
        }),
      );
      harness.session.setHistory([
        subagentEvent("pi", {
          type: "upsert",
          id: "call-canceled",
          title: "scout",
          status: "running",
          liveness: "poll",
        }),
      ]);
      await harness.manager.hydrateTimelineFromProvider(harness.agentId, { force: true });

      expect(status(harness, "call-canceled")).toBe("canceled");
      // Nothing is left that could update it, so the row stays settled once the replay completes.
      await drainSessionEvents();
      expect(status(harness, "call-canceled")).toBe("canceled");
    } finally {
      harness.cleanup();
    }
  });

  test("replay leaves a row the live poll already owns alone", async () => {
    const harness = await createHarness("pi");
    try {
      // The live session's poll is re-reporting this row when a rewind replays the same spawn. The
      // replay must not cancel it: its poll is still running and would flip it back to running.
      await pushEvent(
        harness,
        subagentEvent("pi", {
          type: "upsert",
          id: "call-live",
          title: "scout",
          status: "running",
          liveness: "poll",
        }),
      );
      harness.session.setHistory([
        subagentEvent("pi", {
          type: "upsert",
          id: "call-live",
          title: "scout",
          status: "running",
          liveness: "poll",
        }),
        subagentEvent("pi", {
          type: "upsert",
          id: "call-replayed",
          title: "reviewer",
          status: "running",
          liveness: "poll",
        }),
      ]);
      await harness.manager.hydrateTimelineFromProvider(harness.agentId, { force: true });

      expect(status(harness, "call-live")).toBe("running");
      // The replay's own row has no poll behind it, so it still settles.
      expect(status(harness, "call-replayed")).toBe("canceled");
    } finally {
      harness.cleanup();
    }
  });

  test("replay leaves an unmarked running row: its reporter settles itself", async () => {
    const harness = await createHarness("pi");
    try {
      harness.session.setHistory([
        subagentEvent("pi", { type: "upsert", id: "call-live", title: "scout", status: "running" }),
        subagentEvent("pi", {
          type: "upsert",
          id: "call-done",
          title: "reviewer",
          status: "completed",
        }),
      ]);
      await harness.manager.hydrateTimelineFromProvider(harness.agentId, { force: true });

      expect(status(harness, "call-live")).toBe("running");
      expect(status(harness, "call-done")).toBe("completed");
    } finally {
      harness.cleanup();
    }
  });
});
