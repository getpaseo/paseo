import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { AgentManager } from "../agent-manager.js";
import type { AgentClient, AgentSession, AgentSessionConfig } from "../agent-sdk-types.js";
import { FakeRewindSession, REWIND_TEST_CAPABILITIES } from "./test-rewind-session.js";

class FakeRewindClient implements AgentClient {
  readonly provider = "claude";
  readonly capabilities = REWIND_TEST_CAPABILITIES;

  constructor(readonly session: FakeRewindSession) {}

  async createSession(_config: AgentSessionConfig): Promise<AgentSession> {
    return this.session;
  }

  async resumeSession(): Promise<AgentSession> {
    return this.session;
  }

  async fetchCatalog(_options: FetchCatalogOptions) {
    return { models: [], modes: [] };
  }

  async isAvailable() {
    return true;
  }
}

class RewindHistoryGate {
  private gate: Promise<void> | null = null;
  private releaseGate: (() => void) | null = null;

  hold(): void {
    this.gate = new Promise<void>((resolve) => {
      this.releaseGate = resolve;
    });
  }

  release(): void {
    this.releaseGate?.();
    this.releaseGate = null;
    this.gate = null;
  }

  async wait(): Promise<void> {
    await this.gate;
  }
}

async function createRewindHarness(options: { historyGate?: RewindHistoryGate } = {}) {
  const session = new FakeRewindSession(options.historyGate?.wait.bind(options.historyGate));
  const manager = new AgentManager({
    clients: { claude: new FakeRewindClient(session) },
    logger: createTestLogger(),
    idFactory: () => "00000000-0000-4000-8000-000000000901",
  });
  const agent = await manager.createAgent({
    provider: "claude",
    cwd: process.cwd(),
  });
  return { manager, session, agentId: agent.id };
}

describe("AgentManager rewind", () => {
  test("rewinds the conversation and rehydrates the timeline", async () => {
    const { manager, session, agentId } = await createRewindHarness();

    await manager.rewind(agentId, "message-1", "conversation");

    expect(session.recordedRewinds).toEqual([{ mode: "conversation", messageId: "message-1" }]);
    expect(session.historyReadCount).toBe(1);
    expect(manager.fetchTimeline(agentId, { limit: 0 }).rows.map((row) => row.item)).toEqual([
      { type: "user_message", text: "before", messageId: "message-1" },
    ]);
  });

  test("rewinds files without rehydrating the conversation timeline", async () => {
    const { manager, session, agentId } = await createRewindHarness();

    await manager.rewind(agentId, "message-1", "files");

    expect(session.recordedRewinds).toEqual([{ mode: "files", messageId: "message-1" }]);
    expect(session.historyReadCount).toBe(0);
  });

  test("aborts an in-flight turn before rewinding", async () => {
    const { manager, session, agentId } = await createRewindHarness();
    const run = manager.streamAgent(agentId, "keep working");
    await run.next();

    await manager.rewind(agentId, "message-1", "files");

    expect(session.aborted).toBe(true);
    expect(session.recordedRewinds).toEqual([{ mode: "files", messageId: "message-1" }]);
  });

  test("blocks new prompts until the rehydrate epoch broadcasts", async () => {
    const historyGate = new RewindHistoryGate();
    historyGate.hold();
    const { manager, agentId } = await createRewindHarness({ historyGate });

    const rewind = manager.rewind(agentId, "message-1", "both");

    expect(() => manager.streamAgent(agentId, "too early")).toThrow(
      "Agent 00000000-0000-4000-8000-000000000901 already has an active run",
    );

    historyGate.release();
    await rewind;
  });
});
