import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { ensureAgentLoaded, loadAgentHistory } from "../agent-loading.js";
import { AgentManager, type AgentManagerEvent } from "../agent-manager.js";
import {
  RewindNotAppliedError,
  type AgentClient,
  type AgentPersistenceHandle,
  type AgentSession,
  type AgentSessionConfig,
  type FetchCatalogOptions,
} from "../agent-sdk-types.js";
import { AgentStorage } from "../agent-storage.js";
import { AgentTimeline } from "../timeline/index.js";
import { DeferredTimelineBackend } from "../timeline/testing.js";
import { FakeRewindSession, REWIND_TEST_CAPABILITIES } from "./test-rewind-session.js";

class FakeRewindClient implements AgentClient {
  readonly provider = "claude";
  readonly capabilities = REWIND_TEST_CAPABILITIES;

  readonly resumedSessionIds: string[] = [];

  constructor(readonly session: FakeRewindSession) {}

  async createSession(_config: AgentSessionConfig): Promise<AgentSession> {
    return this.session;
  }

  async resumeSession(handle: AgentPersistenceHandle): Promise<AgentSession> {
    this.resumedSessionIds.push(handle.sessionId);
    return this.session;
  }

  async fetchCatalog(_options: FetchCatalogOptions) {
    return { models: [], modes: [] };
  }

  async isAvailable() {
    return true;
  }
}

/** Agent storage on a real directory whose next save can be made to fail. */
class FlakyAgentStorage extends AgentStorage {
  failNextSave = false;

  override async applySnapshot(...args: Parameters<AgentStorage["applySnapshot"]>) {
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error("No space left on device");
    }
    return super.applySnapshot(...args);
  }
}

const storageDirs: string[] = [];
afterEach(async () => {
  await Promise.all(storageDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createFlakyStorage(): Promise<FlakyAgentStorage> {
  const dir = await mkdtemp(join(tmpdir(), "paseo-rewind-storage-"));
  storageDirs.push(dir);
  return new FlakyAgentStorage(dir, createTestLogger());
}

async function createRewindHarness(
  session = new FakeRewindSession(),
  options: { registry?: AgentStorage } = {},
) {
  const backend = new DeferredTimelineBackend();
  const client = new FakeRewindClient(session);
  const manager = new AgentManager({
    clients: { claude: client },
    logger: createTestLogger(),
    idFactory: () => "00000000-0000-4000-8000-000000000901",
    timeline: new AgentTimeline(backend),
    registry: options.registry,
  });
  const agent = await manager.createAgent({ provider: "claude", cwd: process.cwd() }, undefined, {
    workspaceId: undefined,
  });
  return { manager, session, client, backend, agentId: agent.id };
}

/** What the Reload agent action does for a loaded agent. */
async function reloadAgent(manager: AgentManager, agentId: string) {
  await manager.reloadAgentSession(agentId);
  return manager.reconcileProviderHistory(agentId);
}

/** A conversation the provider answers, with no history before Paseo's first prompt. */
async function createConversationHarness(options: { registry?: AgentStorage } = {}) {
  const session = new FakeRewindSession();
  session.holdTurns = false;
  session.history = [];
  const harness = await createRewindHarness(session, options);
  const events: AgentManagerEvent[] = [];
  harness.manager.subscribe((event) => events.push(event), {
    agentId: harness.agentId,
    replayState: false,
  });
  async function prompt(text: string): Promise<void> {
    for await (const _event of harness.manager.streamAgent(harness.agentId, text, {
      clientMessageId: text,
    })) {
      // Drain the turn.
    }
    await harness.manager.flush();
  }
  async function activeTexts(): Promise<string[]> {
    const page = await harness.manager.fetchTimeline(harness.agentId, { limit: 0 });
    return page.rows.map((row) =>
      row.item.type === "user_message" || row.item.type === "assistant_message"
        ? row.item.text
        : row.item.type,
    );
  }
  function retirements() {
    return events.filter((event) => event.type === "timeline_retirement");
  }
  return { ...harness, events, prompt, activeTexts, retirements };
}

describe("AgentManager conversation rewind", () => {
  test("A, B, rewind B, C keeps A, stores B outside the conversation, and shows C once", async () => {
    const harness = await createConversationHarness();
    const { manager, agentId, session, backend } = harness;
    await harness.prompt("A");
    await harness.prompt("B");
    const before = await manager.fetchTimeline(agentId, { limit: 0 });

    await manager.rewind(agentId, "B", "conversation");
    await harness.prompt("C");

    expect(session.recordedRewinds).toEqual([{ mode: "conversation", messageId: "provider-2" }]);
    expect(await harness.activeTexts()).toEqual(["A", "reply to A", "C", "reply to C"]);
    expect(backend.retiredRows({ agentId }).map((row) => row.item)).toEqual([
      expect.objectContaining({ type: "user_message", text: "B" }),
      expect.objectContaining({ type: "assistant_message", text: "reply to B" }),
    ]);
    const after = await manager.fetchTimeline(agentId, { limit: 0 });
    expect(after.epoch).toBe(before.epoch);
    expect(after.retirementCount).toBe(1);
    expect(harness.retirements()).toEqual([
      {
        type: "timeline_retirement",
        agentId,
        epoch: before.epoch,
        seq: before.window.nextSeq,
        retireFromSeq: before.rows[2]!.seqStart,
        retirementCount: 1,
      },
    ]);
    // The provider history is not read back; the retirement is the only change.
    expect(session.historyReadCount).toBe(0);
  });

  test("a reader at the end of B catches up through the retirement to C", async () => {
    const harness = await createConversationHarness();
    const { manager, agentId } = harness;
    await harness.prompt("A");
    await harness.prompt("B");
    const loaded = await manager.fetchTimeline(agentId, { limit: 0 });

    await manager.rewind(agentId, "B", "conversation");
    await harness.prompt("C");

    const page = await manager.fetchTimeline(agentId, {
      direction: "after",
      cursor: { epoch: loaded.epoch, seq: loaded.endSeq! },
      limit: 50,
    });
    expect(page.reset).toBe(false);
    expect(page.retirements).toEqual([
      { seq: loaded.window.nextSeq, retireFromSeq: loaded.rows[2]!.seqStart },
    ]);
    expect(page.rows.map((row) => row.item)).toEqual([
      expect.objectContaining({ type: "user_message", text: "C" }),
      expect.objectContaining({ type: "assistant_message", text: "reply to C" }),
    ]);
  });

  test("repeating the rewind of B after C fails without calling the provider or touching C", async () => {
    const harness = await createConversationHarness();
    const { manager, agentId, session } = harness;
    await harness.prompt("A");
    await harness.prompt("B");
    await manager.rewind(agentId, "B", "conversation");
    await harness.prompt("C");

    await expect(manager.rewind(agentId, "B", "conversation")).rejects.toThrow(
      "The message to rewind to is no longer in the conversation",
    );

    expect(session.recordedRewinds).toHaveLength(1);
    expect(harness.retirements()).toHaveLength(1);
    expect(await harness.activeTexts()).toEqual(["A", "reply to A", "C", "reply to C"]);
  });

  test("repeating a rewind does not cancel the turn that is running", async () => {
    const harness = await createConversationHarness();
    const { manager, agentId, session } = harness;
    await harness.prompt("A");
    await harness.prompt("B");
    await manager.rewind(agentId, "B", "conversation");
    session.holdTurns = true;
    const run = manager.streamAgent(agentId, "C", { clientMessageId: "C" });
    await run.next();

    await expect(manager.rewind(agentId, "B", "conversation")).rejects.toThrow(
      "The message to rewind to is no longer in the conversation",
    );

    expect(session.aborted).toBe(false);
    expect(manager.getAgent(agentId)?.lifecycle).toBe("running");
  });

  test("the provider's retained boundary decides what retires", async () => {
    const harness = await createConversationHarness();
    const { manager, agentId, session } = harness;
    await harness.prompt("A");
    await harness.prompt("B");
    await harness.prompt("C");
    // The provider can only fork after A, so B goes with C.
    session.nextRewind = {
      kind: "applied",
      cut: { kind: "after", retainedMessageId: "provider-1" },
    };

    await manager.rewind(agentId, "C", "conversation");

    expect(await harness.activeTexts()).toEqual(["A", "reply to A"]);
  });

  test("a failure the provider reports as not applied keeps the conversation", async () => {
    const harness = await createConversationHarness();
    const { manager, agentId, session } = harness;
    await harness.prompt("A");
    await harness.prompt("B");
    session.nextRewind = { kind: "not_applied", message: "No checkpoint for this message" };

    await expect(manager.rewind(agentId, "B", "conversation")).rejects.toThrow(
      "No checkpoint for this message",
    );
    await harness.prompt("C");

    expect(harness.retirements()).toEqual([]);
    expect(await harness.activeTexts()).toEqual([
      "A",
      "reply to A",
      "B",
      "reply to B",
      "C",
      "reply to C",
    ]);
  });

  test("an unknown outcome refuses prompts and further rewinds without calling the provider again", async () => {
    const harness = await createConversationHarness();
    const { manager, agentId, session } = harness;
    await harness.prompt("A");
    await harness.prompt("B");
    session.nextRewind = { kind: "unknown", applied: true };

    const unknown = "Paseo could not confirm whether the conversation was rewound.";
    await expect(manager.rewind(agentId, "B", "conversation")).rejects.toThrow(unknown);
    await expect(harness.prompt("C")).rejects.toThrow(unknown);
    await expect(manager.rewind(agentId, "A", "conversation")).rejects.toThrow(unknown);

    expect(session.recordedRewinds).toHaveLength(1);
    expect(harness.retirements()).toEqual([]);
    // The refused prompt stays in the conversation with the reason, like any refused prompt.
    expect(await harness.activeTexts()).toEqual([
      "A",
      "reply to A",
      "B",
      "reply to B",
      "C",
      `[System Error] ${unknown} Reload the agent to check, or fork the chat from an earlier message.`,
    ]);
  });

  test("archiving and unarchiving after A, B, rewind B, C keeps C and leaves B retired", async () => {
    const registry = await createFlakyStorage();
    const harness = await createConversationHarness({ registry });
    const { manager, agentId, session, client } = harness;
    const loader = { agentManager: manager, agentStorage: registry, logger: createTestLogger() };
    await harness.prompt("A");
    await harness.prompt("B");
    await manager.rewind(agentId, "B", "conversation");
    await harness.prompt("C");
    const before = await manager.fetchTimeline(agentId, { limit: 0 });

    await manager.archiveAgent(agentId);

    // The archived chat reads from its stored history, without starting the provider.
    expect(manager.getAgent(agentId)).toBeNull();
    expect(await loadAgentHistory(agentId, loader)).toMatchObject({ kind: "stored" });
    expect(await manager.fetchTimeline(agentId, { limit: 0 })).toEqual(before);
    expect(client.resumedSessionIds).toEqual([]);

    // Unarchive, as the refresh request runs it: load the agent, then reconcile its history.
    await manager.unarchiveSnapshot(agentId);
    await ensureAgentLoaded(agentId, loader);
    expect(await manager.reconcileProviderHistory(agentId)).toEqual({ kind: "unchanged" });
    await harness.prompt("D");

    expect(client.resumedSessionIds).toHaveLength(1);
    expect(await harness.activeTexts()).toEqual([
      "A",
      "reply to A",
      "C",
      "reply to C",
      "D",
      "reply to D",
    ]);
    expect(await manager.fetchTimeline(agentId, { limit: 0 })).toMatchObject({
      epoch: before.epoch,
      retirementCount: 1,
    });
    expect(harness.retirements()).toHaveLength(1);
    expect(session.recordedRewinds).toHaveLength(1);
  });

  test("reloading settles an unknown outcome the provider history proves applied", async () => {
    const harness = await createConversationHarness();
    const { manager, agentId, session } = harness;
    await harness.prompt("A");
    await harness.prompt("B");
    session.nextRewind = { kind: "unknown", applied: true };
    await expect(manager.rewind(agentId, "B", "conversation")).rejects.toThrow();

    await reloadAgent(manager, agentId);
    await harness.prompt("C");

    expect(session.recordedRewinds).toHaveLength(1);
    expect(harness.retirements()).toHaveLength(1);
    expect(await harness.activeTexts()).toEqual(["A", "reply to A", "C", "reply to C"]);
  });

  test("a restarted daemon whose stored history holds an unknown outcome settles it on resume", async () => {
    const registry = await createFlakyStorage();
    const harness = await createConversationHarness({ registry });
    const { manager, agentId, session, client, backend } = harness;
    await harness.prompt("A");
    await harness.prompt("B");
    session.nextRewind = { kind: "unknown", applied: true };
    await expect(manager.rewind(agentId, "B", "conversation")).rejects.toThrow();
    await manager.closeAgent(agentId);
    await manager.flush();

    // The next daemon reads the same stored history; only construction differs.
    const restarted = new AgentManager({
      clients: { claude: client },
      logger: createTestLogger(),
      timeline: new AgentTimeline(backend),
      registry,
    });
    await ensureAgentLoaded(agentId, {
      agentManager: restarted,
      agentStorage: registry,
      logger: createTestLogger(),
    });
    for await (const _event of restarted.streamAgent(agentId, "C", { clientMessageId: "C" })) {
      // Drain the turn.
    }
    await restarted.flush();

    expect(session.recordedRewinds).toHaveLength(1);
    const page = await restarted.fetchTimeline(agentId, { limit: 0 });
    expect(page.rows.map((row) => ("text" in row.item ? row.item.text : row.item.type))).toEqual([
      "A",
      "reply to A",
      "C",
      "reply to C",
    ]);
    expect(page.retirementCount).toBe(1);
    await restarted.closeAgent(agentId);
    await restarted.flush();
    await registry.flush();
  });

  test("a restarted daemon keeps the provider children it listed and the ones a rewind retired", async () => {
    const registry = await createFlakyStorage();
    const harness = await createConversationHarness({ registry });
    const { manager, agentId, session, client, backend } = harness;
    session.subagentPrompts.add("A").add("B");
    await harness.prompt("A");
    await harness.prompt("B");
    await manager.rewind(agentId, "B", "conversation");
    await manager.closeAgent(agentId);
    await manager.flush();

    // The next daemon reads the same stored history; only construction differs.
    const restarted = new AgentManager({
      clients: { claude: client },
      logger: createTestLogger(),
      timeline: new AgentTimeline(backend),
      registry,
    });
    await ensureAgentLoaded(agentId, {
      agentManager: restarted,
      agentStorage: registry,
      logger: createTestLogger(),
    });
    const listed = async () =>
      (await restarted.listProviderSubagents(agentId)).map((child) => child.id);
    const childTexts = async (subagentId: string) =>
      (await restarted.fetchProviderSubagentTimeline(agentId, subagentId)).rows.map((row) =>
        "text" in row.item ? row.item.text : row.item.type,
      );

    expect(await listed()).toEqual(["child-of-A"]);
    expect(await childTexts("child-of-A")).toEqual(["working on A"]);
    expect(await childTexts("child-of-B")).toEqual(["working on B"]);

    // The provider's history still holds the rewound child; importing it must not bring it back.
    session.history.push({ type: "assistant_message", text: "continued outside Paseo" });
    session.historySubagentEvents = [
      {
        type: "provider_subagent",
        provider: "claude",
        event: { type: "upsert", id: "child-of-B", toolCallId: "call-2", status: "completed" },
      },
      {
        type: "provider_subagent",
        provider: "claude",
        event: {
          type: "timeline",
          id: "child-of-B",
          item: { type: "assistant_message", text: "late output" },
        },
      },
    ];
    expect(await reloadAgent(restarted, agentId)).toEqual({ kind: "appended" });

    expect(await listed()).toEqual(["child-of-A"]);
    expect(await childTexts("child-of-B")).toEqual(["working on B"]);

    await restarted.closeAgent(agentId);
    await restarted.deleteAgentState(agentId);
    await restarted.flush();
    const stored = new AgentTimeline(backend);
    expect(await stored.describe({ agentId })).toBeNull();
    expect(await stored.describe({ agentId, subagentId: "child-of-A" })).toBeNull();
    expect(await stored.describe({ agentId, subagentId: "child-of-B" })).toBeNull();
    await registry.flush();
  });

  test("reloading settles an unknown outcome the provider history proves unchanged", async () => {
    const harness = await createConversationHarness();
    const { manager, agentId, session } = harness;
    await harness.prompt("A");
    await harness.prompt("B");
    session.nextRewind = { kind: "unknown", applied: false };
    await expect(manager.rewind(agentId, "B", "conversation")).rejects.toThrow();

    await reloadAgent(manager, agentId);
    await harness.prompt("C");

    expect(harness.retirements()).toEqual([]);
    expect(await harness.activeTexts()).toEqual([
      "A",
      "reply to A",
      "B",
      "reply to B",
      "C",
      "reply to C",
    ]);
  });

  test("reloading keeps the rewind unresolved when the provider history proves nothing", async () => {
    const harness = await createConversationHarness();
    const { manager, agentId, session } = harness;
    await harness.prompt("A");
    await harness.prompt("B");
    session.nextRewind = { kind: "unknown", applied: true };
    await expect(manager.rewind(agentId, "B", "conversation")).rejects.toThrow();
    // A provider that replays no history leaves nothing to compare.
    session.history = [];

    await reloadAgent(manager, agentId);

    await expect(harness.prompt("C")).rejects.toThrow(
      "Paseo could not confirm whether the conversation was rewound.",
    );
    // The reload did not wipe the conversation.
    expect((await harness.activeTexts()).slice(0, 5)).toEqual([
      "A",
      "reply to A",
      "B",
      "reply to B",
      "C",
    ]);
    expect(harness.retirements()).toEqual([]);
  });

  test("a prompt refused while the rewind is unresolved does not change what the reload judges", async () => {
    const harness = await createConversationHarness();
    const { manager, agentId, session } = harness;
    await harness.prompt("A");
    await harness.prompt("B");
    session.nextRewind = { kind: "unknown", applied: true };
    await expect(manager.rewind(agentId, "B", "conversation")).rejects.toThrow();
    // Refused before reaching the provider, so the provider history has no C.
    await expect(harness.prompt("C")).rejects.toThrow();

    await reloadAgent(manager, agentId);
    await harness.prompt("D");

    expect(harness.retirements()).toHaveLength(1);
    expect(await harness.activeTexts()).toEqual(["A", "reply to A", "D", "reply to D"]);
  });

  test("a prompt refused while the rewind is unresolved stays when the reload proves no change", async () => {
    const harness = await createConversationHarness();
    const { manager, agentId, session } = harness;
    await harness.prompt("A");
    await harness.prompt("B");
    session.nextRewind = { kind: "unknown", applied: false };
    await expect(manager.rewind(agentId, "B", "conversation")).rejects.toThrow();
    await expect(harness.prompt("C")).rejects.toThrow();

    await reloadAgent(manager, agentId);
    await harness.prompt("D");

    expect(harness.retirements()).toEqual([]);
    expect(await harness.activeTexts()).toEqual([
      "A",
      "reply to A",
      "B",
      "reply to B",
      "C",
      expect.stringContaining("[System Error] Paseo could not confirm"),
      "D",
      "reply to D",
    ]);
  });

  test("a rewind whose save failed is committed by a reload that resumes the rewound session", async () => {
    const registry = await createFlakyStorage();
    const harness = await createConversationHarness({ registry });
    const { manager, agentId, session, client } = harness;
    await harness.prompt("A");
    await harness.prompt("B");
    const before = await manager.fetchTimeline(agentId, { limit: 0 });
    // The provider continues the rewound conversation in a new session, then the save fails.
    session.sessionIdAfterRewind = "rewound-session";
    registry.failNextSave = true;
    await expect(manager.rewind(agentId, "B", "conversation")).rejects.toThrow(
      "No space left on device",
    );
    expect(harness.retirements()).toEqual([]);

    await reloadAgent(manager, agentId);
    await harness.prompt("C");

    expect(client.resumedSessionIds).toEqual(["rewound-session"]);
    expect((await registry.get(agentId))?.persistence?.sessionId).toBe("rewound-session");
    // The reload committed the recorded cut on the same timeline, without judging the replay:
    // its one history read is the reconcile after the rewind settled.
    expect(session.recordedRewinds).toHaveLength(1);
    expect(session.historyReadCount).toBe(1);
    expect(harness.retirements()).toEqual([
      expect.objectContaining({ epoch: before.epoch, retireFromSeq: before.rows[2]!.seqStart }),
    ]);
    expect(await harness.activeTexts()).toEqual(["A", "reply to A", "C", "reply to C"]);
  });

  test("a rewind whose save failed is committed by the next prompt without a reload", async () => {
    const registry = await createFlakyStorage();
    const harness = await createConversationHarness({ registry });
    const { manager, agentId, session } = harness;
    await harness.prompt("A");
    await harness.prompt("B");
    session.sessionIdAfterRewind = "rewound-session";
    registry.failNextSave = true;
    await expect(manager.rewind(agentId, "B", "conversation")).rejects.toThrow();

    await harness.prompt("C");

    expect(session.recordedRewinds).toHaveLength(1);
    expect((await registry.get(agentId))?.persistence?.sessionId).toBe("rewound-session");
    expect(await harness.activeTexts()).toEqual(["A", "reply to A", "C", "reply to C"]);
  });

  test("a rewind the provider finishes without reporting its cut settles from the resumed history", async () => {
    const harness = await createConversationHarness();
    const { manager, agentId, session, client } = harness;
    await harness.prompt("A");
    await harness.prompt("B");
    const before = await manager.fetchTimeline(agentId, { limit: 0 });
    session.nextRewind = { kind: "unreported", applied: true };

    await manager.rewind(agentId, "B", "conversation");
    await harness.prompt("C");

    expect(session.recordedRewinds).toHaveLength(1);
    expect(client.resumedSessionIds).toEqual(["fake-rewind-session"]);
    expect(harness.retirements()).toEqual([
      expect.objectContaining({ epoch: before.epoch, retireFromSeq: before.rows[2]!.seqStart }),
    ]);
    expect(await harness.activeTexts()).toEqual(["A", "reply to A", "C", "reply to C"]);
  });

  test("a rewind the provider reports finished but did not apply keeps the conversation", async () => {
    const harness = await createConversationHarness();
    const { manager, agentId, session } = harness;
    await harness.prompt("A");
    await harness.prompt("B");
    session.nextRewind = { kind: "unreported", applied: false };

    await expect(manager.rewind(agentId, "B", "conversation")).rejects.toBeInstanceOf(
      RewindNotAppliedError,
    );
    await harness.prompt("C");

    expect(harness.retirements()).toEqual([]);
    expect(await harness.activeTexts()).toEqual([
      "A",
      "reply to A",
      "B",
      "reply to B",
      "C",
      "reply to C",
    ]);
  });

  test("a rewind the provider finishes without reporting stays unresolved when its history proves nothing", async () => {
    const harness = await createConversationHarness();
    const { manager, agentId, session } = harness;
    await harness.prompt("A");
    session.nextRewind = { kind: "unreported", applied: true };

    // Rewinding the only prompt leaves an empty history, which may also mean no replay.
    const unknown = "Paseo could not confirm whether the conversation was rewound.";
    await expect(manager.rewind(agentId, "A", "conversation")).rejects.toThrow(unknown);
    await expect(harness.prompt("B")).rejects.toThrow(unknown);

    expect(harness.retirements()).toEqual([]);
  });

  test("retires the provider subagent a rewound turn spawned, and keeps the others", async () => {
    const harness = await createConversationHarness();
    const { manager, agentId, session } = harness;
    session.subagentPrompts.add("A").add("B");
    await harness.prompt("A");
    await harness.prompt("B");
    await manager.flush();
    expect((await manager.listProviderSubagents(agentId)).map((child) => child.id)).toEqual([
      "child-of-A",
      "child-of-B",
    ]);

    await manager.rewind(agentId, "B", "conversation");

    expect((await manager.listProviderSubagents(agentId)).map((child) => child.id)).toEqual([
      "child-of-A",
    ]);
    expect(
      harness.events.flatMap((event) =>
        event.type === "provider_subagent" && event.event.type === "remove" ? [event.event] : [],
      ),
    ).toEqual([{ type: "remove", parentAgentId: agentId, subagentId: "child-of-B" }]);
  });

  test("rewinding files leaves the conversation as it is", async () => {
    const harness = await createConversationHarness();
    const { manager, agentId, session } = harness;
    await harness.prompt("A");
    await harness.prompt("B");

    await manager.rewind(agentId, "B", "files");

    expect(session.recordedRewinds).toEqual([{ mode: "files", messageId: "provider-2" }]);
    expect(harness.retirements()).toEqual([]);
    expect(await harness.activeTexts()).toEqual(["A", "reply to A", "B", "reply to B"]);
    expect(session.historyReadCount).toBe(0);
  });
});

describe("AgentManager rewind run ownership", () => {
  test("aborts an in-flight turn before rewinding", async () => {
    const { manager, session, agentId } = await createRewindHarness();
    const run = manager.streamAgent(agentId, "keep working");
    await run.next();

    await manager.rewind(agentId, "message-1", "files");

    expect(session.aborted).toBe(true);
    expect(session.recordedRewinds).toEqual([{ mode: "files", messageId: "message-1" }]);
  });

  test("does not rewind when the in-flight turn rejects cancellation", async () => {
    class RejectingInterruptSession extends FakeRewindSession {
      override async interrupt(): Promise<void> {
        throw new Error("provider still owns the active turn");
      }
    }

    const { manager, session, agentId } = await createRewindHarness(
      new RejectingInterruptSession(),
    );
    const run = manager.streamAgent(agentId, "keep working");
    await run.next();

    await expect(manager.rewind(agentId, "message-1", "files")).rejects.toThrow(
      `Cannot rewind agent ${agentId} because its active run cancellation was not acknowledged`,
    );
    expect(session.recordedRewinds).toEqual([]);
    expect(manager.getAgent(agentId)).toMatchObject({
      lifecycle: "running",
      activeForegroundTurnId: "turn-1",
    });
  });

  test("blocks new prompts until the rewind settles", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    class GatedRewindSession extends FakeRewindSession {
      override async revertFiles(input: { messageId: string }): Promise<void> {
        await gate;
        await super.revertFiles(input);
      }
    }
    const { manager, agentId } = await createRewindHarness(new GatedRewindSession());

    const rewind = manager.rewind(agentId, "message-1", "files");

    expect(() => manager.streamAgent(agentId, "too early")).toThrow(
      `Agent ${agentId} already has an active run`,
    );

    release();
    await rewind;
  });
});
