import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginAgentLaunchEvent, PluginAgentLaunchRequest } from "@getpaseo/plugin/client";
import { useDraftStore, type AgentLaunchDraftMetadata } from "@/stores/draft-store";
import {
  AGENT_LAUNCH_JOURNAL_ENTRY_LIMIT,
  AGENT_LAUNCH_TERMINAL_RETENTION_MS,
  buildAgentLaunchJournalKey,
  discardAgentLaunch,
  discardAgentLaunchForClosedDraft,
  garbageCollectAgentLaunchJournals,
  getAgentLaunchJournalForDraft,
  markAgentCreated,
  markAgentRequestStarted,
  markLaunchOutcomeUnknown,
  markWorkspaceCreated,
  markWorkspaceRequestStarted,
  openAgentLaunchJournal,
  removePluginAgentLaunchJournals,
  type LaunchStorage,
} from "./journal";

interface MemoryStorage extends LaunchStorage {
  values: Map<string, string>;
  failWrites: boolean;
  failReads: boolean;
  writes: string[];
}

function createMemoryStorage(): MemoryStorage {
  const values = new Map<string, string>();
  const storage: MemoryStorage = {
    values,
    failWrites: false,
    failReads: false,
    writes: [],
    async getItem(key) {
      if (storage.failReads) throw new Error("read failed");
      return values.get(key) ?? null;
    },
    async setItem(key, value) {
      if (storage.failWrites) throw new Error("write failed");
      storage.writes.push(key);
      values.set(key, value);
    },
    async removeItem(key) {
      values.delete(key);
    },
    async getAllKeys() {
      return [...values.keys()];
    },
    async multiGet(keys) {
      return keys.map((key) => [key, values.get(key) ?? null] as [string, string | null]);
    },
  };
  return storage;
}

let draftCounter = 0;
const prepared: { draftId: string; metadata: AgentLaunchDraftMetadata; prompt: string }[] = [];

function request(overrides: Partial<PluginAgentLaunchRequest> = {}): PluginAgentLaunchRequest {
  return {
    launchId: "attempt-1",
    documentIncarnationId: "inc-1",
    requestFingerprint: "fp-1",
    projectId: "project-1",
    seedPrompt: "Implement the feature",
    clientMessageId: "msg-1",
    labels: { "paseo.plugin.todo": "v1", "paseo.plugin.todo.attempt-id": "attempt-1" },
    workspace: { allowExisting: true, allowCreate: true },
    ...overrides,
  };
}

function open(
  storage: LaunchStorage,
  overrides: Partial<PluginAgentLaunchRequest> = {},
  options: { pluginId?: string; clientInstanceId?: string; initialWorkspaceId?: string } = {},
) {
  return openAgentLaunchJournal({
    storage,
    serverId: "host-1",
    pluginId: options.pluginId ?? "todo",
    clientInstanceId: options.clientInstanceId ?? "cid_device_a",
    request: request(overrides),
    ...(options.initialWorkspaceId ? { initialWorkspaceId: options.initialWorkspaceId } : {}),
    createDraftId: () => `draft-${++draftCounter}`,
    prepareDraft: ({ draftId, metadata, prompt }) => {
      prepared.push({ draftId, metadata, prompt });
      useDraftStore.getState().setAgentLaunchMetadata({
        draftKey: `key:${draftId}`,
        draft: { text: prompt, attachments: [] },
        metadata,
      });
    },
  });
}

function journalOf(storage: MemoryStorage, launchId = "attempt-1", pluginId = "todo") {
  const raw = storage.values.get(
    buildAgentLaunchJournalKey({
      serverId: "host-1",
      pluginId,
      documentIncarnationId: "inc-1",
      launchId,
    }),
  );
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

beforeEach(() => {
  draftCounter = 0;
  prepared.length = 0;
  useDraftStore.setState({ drafts: {} });
});

describe("openAgentLaunchJournal", () => {
  it("creates a journal, persists it before preparing the draft, and reports journal_ready", async () => {
    const storage = createMemoryStorage();
    const events: PluginAgentLaunchEvent[] = [];
    const opened = await open(storage, { onEvent: (event) => events.push(event) });
    expect(opened.result).toEqual({
      status: "opened",
      clientInstanceId: "cid_device_a",
      journalVersion: 1,
      submissionState: "editable",
    });
    expect(opened.created).toBe(true);
    expect(prepared).toHaveLength(1);
    expect(prepared[0]).toMatchObject({ draftId: "draft-1", prompt: "Implement the feature" });
    expect(prepared[0]?.metadata).toMatchObject({
      launchId: "attempt-1",
      documentIncarnationId: "inc-1",
      requestFingerprint: "fp-1",
      clientMessageId: "msg-1",
      labels: request().labels,
      submissionState: "editable",
    });
    expect(events.map((event) => event.type)).toEqual(["journal_ready"]);
    expect(journalOf(storage)).toMatchObject({
      phase: "prepared",
      seedPrompt: "Implement the feature",
    });
    expect(storage.writes).toHaveLength(1);
  });

  it("serializes same-key calls inside one runtime and restores instead of creating a second draft", async () => {
    const storage = createMemoryStorage();
    const [first, second] = await Promise.all([open(storage), open(storage)]);
    expect(first.result.status).toBe("opened");
    expect(second.result.status).toBe("restored");
    expect(second.created).toBe(false);
    expect(prepared.map((entry) => entry.draftId)).toEqual(["draft-1", "draft-1"]);
    expect(storage.values.size).toBe(1);
  });

  it("rejects a different fingerprint for the same launch key", async () => {
    const storage = createMemoryStorage();
    await open(storage);
    const conflict = await open(storage, { requestFingerprint: "fp-2" });
    expect(conflict.result).toMatchObject({ status: "rejected", code: "launch_key_conflict" });
    expect(prepared).toHaveLength(1);
  });

  it("isolates journals per plugin ID even for equal launch IDs", async () => {
    const storage = createMemoryStorage();
    await open(storage, {}, { pluginId: "todo" });
    const other = await open(storage, { requestFingerprint: "fp-other" }, { pluginId: "other" });
    expect(other.result.status).toBe("opened");
    expect(storage.values.size).toBe(2);
    expect(journalOf(storage, "attempt-1", "other")).toMatchObject({
      requestFingerprint: "fp-other",
    });
  });

  it("returns wrong_device without touching storage or drafts", async () => {
    const storage = createMemoryStorage();
    const result = await open(
      storage,
      { expectedClientInstanceId: "cid_device_b" },
      { clientInstanceId: "cid_device_a" },
    );
    expect(result.result).toMatchObject({ status: "rejected", code: "wrong_device" });
    expect(storage.values.size).toBe(0);
    expect(prepared).toHaveLength(0);
  });

  it("reports journal_persist_failed with a not_submitted failure when the journal cannot be written", async () => {
    const storage = createMemoryStorage();
    storage.failWrites = true;
    const events: PluginAgentLaunchEvent[] = [];
    const result = await open(storage, { onEvent: (event) => events.push(event) });
    expect(result.result).toMatchObject({ status: "rejected", code: "journal_persist_failed" });
    expect(events).toEqual([
      expect.objectContaining({ type: "failed", stage: "journal", certainty: "not_submitted" }),
    ]);
    expect(prepared).toHaveLength(0);
  });

  it("reports journal_invalid without deleting or replacing the stored record", async () => {
    const storage = createMemoryStorage();
    const key = buildAgentLaunchJournalKey({
      serverId: "host-1",
      pluginId: "todo",
      documentIncarnationId: "inc-1",
      launchId: "attempt-1",
    });
    storage.values.set(key, '{"schemaVersion":99}');
    const result = await open(storage);
    expect(result.result).toMatchObject({ status: "rejected", code: "journal_invalid" });
    expect(storage.values.get(key)).toBe('{"schemaVersion":99}');
    expect(prepared).toHaveLength(0);
  });

  it("does not let a throwing callback break the launch", async () => {
    const storage = createMemoryStorage();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = await open(storage, {
      onEvent: () => {
        throw new Error("plugin bug");
      },
    });
    expect(result.result.status).toBe("opened");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("milestones", () => {
  it("persists each request-start before returning and keeps outcome facts orthogonal", async () => {
    const storage = createMemoryStorage();
    const events: PluginAgentLaunchEvent[] = [];
    await open(storage, { onEvent: (event) => events.push(event) });

    await markWorkspaceRequestStarted("draft-1");
    expect(journalOf(storage)).toMatchObject({ phase: "workspace_request_started" });
    expect(journalOf(storage)?.milestones).toMatchObject({
      workspaceRequestStartedAt: expect.any(Number),
    });

    await markWorkspaceCreated("draft-1", "wks_1");
    expect(journalOf(storage)).toMatchObject({ phase: "workspace_known", workspaceId: "wks_1" });

    // Workspace is known but the agent request has not started: a negative agent result is
    // still not_submitted and the draft stays editable.
    await markLaunchOutcomeUnknown({ draftId: "draft-1", stage: "agent_create", message: "left" });
    expect(journalOf(storage)).toMatchObject({
      phase: "workspace_known",
      submissionState: "editable",
    });
    expect(useDraftStore.getState().getAgentLaunchMetadata("draft-1")?.submissionState).toBe(
      "editable",
    );

    await markAgentRequestStarted("draft-1", "wks_1");
    expect(journalOf(storage)?.milestones).toMatchObject({
      agentRequestStartedAt: expect.any(Number),
    });

    await markLaunchOutcomeUnknown({
      draftId: "draft-1",
      stage: "agent_create",
      message: "agent_create_failed",
    });
    const journal = journalOf(storage);
    expect(journal).toMatchObject({
      phase: "agent_outcome_unknown",
      submissionState: "outcome_unknown_readonly",
    });
    expect(journal?.milestones).toMatchObject({
      workspaceRequestStartedAt: expect.any(Number),
      workspaceKnownAt: expect.any(Number),
      agentRequestStartedAt: expect.any(Number),
      agentOutcomeUnknownAt: expect.any(Number),
    });
    expect(useDraftStore.getState().getAgentLaunchMetadata("draft-1")?.submissionState).toBe(
      "outcome_unknown_readonly",
    );
    expect(events.map((event) => event.type)).toEqual([
      "journal_ready",
      "workspace_request_started",
      "workspace_created",
      "failed",
      "agent_request_started",
      "failed",
    ]);
    expect(events[3]).toMatchObject({ certainty: "not_submitted" });
    expect(events[5]).toMatchObject({ certainty: "outcome_unknown" });

    // A later known agent does not clear the unknown observation, but it terminates the launch.
    await markAgentCreated({ draftId: "draft-1", workspaceId: "wks_1", agentId: "agent-1" });
    const terminal = journalOf(storage);
    expect(terminal).toMatchObject({ terminalOutcome: "agent_known", agentId: "agent-1" });
    expect(terminal?.milestones).toMatchObject({
      agentOutcomeUnknownAt: expect.any(Number),
      agentKnownAt: expect.any(Number),
    });
    expect(terminal).not.toHaveProperty("seedPrompt");
    expect(terminal).toMatchObject({ labels: request().labels, clientMessageId: "msg-1" });
  });

  it("locks the draft read-only when the journal is unreadable after a request may have started", async () => {
    const storage = createMemoryStorage();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await open(storage);
    await markAgentRequestStarted("draft-1", "wks_1");
    storage.failReads = true;
    await markLaunchOutcomeUnknown({
      draftId: "draft-1",
      stage: "agent_create",
      message: "timeout",
    });
    expect(useDraftStore.getState().getAgentLaunchMetadata("draft-1")?.submissionState).toBe(
      "outcome_unknown_readonly",
    );
    warn.mockRestore();
  });

  it("does not create a second draft after a lost agent_created callback or app restart", async () => {
    const storage = createMemoryStorage();
    await open(storage);
    await markAgentRequestStarted("draft-1", "wks_1");
    await markAgentCreated({ draftId: "draft-1", workspaceId: "wks_1", agentId: "agent-1" });

    // Simulate restart: in-memory draft bindings are gone, storage remains.
    useDraftStore.setState({ drafts: {} });
    prepared.length = 0;
    const events: PluginAgentLaunchEvent[] = [];
    const reopened = await open(storage, { onEvent: (event) => events.push(event) });
    expect(reopened.result).toEqual({
      status: "completed",
      clientInstanceId: "cid_device_a",
      journalVersion: expect.any(Number),
      terminalOutcome: "agent_known",
      workspaceId: "wks_1",
      agentId: "agent-1",
    });
    expect(prepared).toHaveLength(0);
    expect(events.map((event) => event.type)).toEqual([
      "journal_ready",
      "workspace_created",
      "agent_request_started",
      "agent_created",
    ]);
  });

  it("restores an outcome-unknown journal read-only and replays its facts", async () => {
    const storage = createMemoryStorage();
    await open(storage);
    await markAgentRequestStarted("draft-1", "wks_1");
    await markLaunchOutcomeUnknown({ draftId: "draft-1", stage: "agent_create", message: "lost" });
    useDraftStore.setState({ drafts: {} });
    const events: PluginAgentLaunchEvent[] = [];
    const reopened = await open(storage, { onEvent: (event) => events.push(event) });
    expect(reopened.result).toMatchObject({
      status: "restored",
      submissionState: "outcome_unknown_readonly",
    });
    expect(prepared.at(-1)?.metadata.submissionState).toBe("outcome_unknown_readonly");
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "failed",
        stage: "agent_create",
        certainty: "outcome_unknown",
      }),
    );
  });

  it("discards only before any request-start and refuses afterwards", async () => {
    const storage = createMemoryStorage();
    const events: PluginAgentLaunchEvent[] = [];
    await open(storage, { onEvent: (event) => events.push(event) });
    await discardAgentLaunch("draft-1");
    expect(journalOf(storage)).toMatchObject({ terminalOutcome: "discarded", phase: "discarded" });
    expect(journalOf(storage)).not.toHaveProperty("seedPrompt");
    expect(events.at(-1)).toMatchObject({ type: "discarded", certainty: "not_submitted" });

    prepared.length = 0;
    await open(storage, { launchId: "attempt-2", requestFingerprint: "fp-2" });
    await markWorkspaceRequestStarted("draft-2");
    await expect(discardAgentLaunch("draft-2")).rejects.toThrow("cannot be discarded");
    expect(journalOf(storage, "attempt-2")).toMatchObject({ phase: "workspace_request_started" });
  });

  it("keeps the journal open when an emptied draft is marked abandoned", async () => {
    const storage = createMemoryStorage();
    await open(storage);
    // The composer marks a draft abandoned when its last attachment is removed from empty text.
    // That is an edit; only closing the draft tab discards the launch.
    useDraftStore.getState().clearDraftInput({ draftKey: "key:draft-1", lifecycle: "abandoned" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(journalOf(storage)).toMatchObject({ phase: "prepared" });
    expect(journalOf(storage)).not.toHaveProperty("terminalOutcome");
  });

  it("discards a launch when its draft tab closes before any request starts", async () => {
    const storage = createMemoryStorage();
    const events: PluginAgentLaunchEvent[] = [];
    await open(storage, { onEvent: (event) => events.push(event) });
    await discardAgentLaunchForClosedDraft("draft-1");
    expect(journalOf(storage)).toMatchObject({ terminalOutcome: "discarded" });
    expect(events.at(-1)).toMatchObject({ type: "discarded", certainty: "not_submitted" });

    await open(storage, { launchId: "attempt-2", requestFingerprint: "fp-2" });
    await markWorkspaceRequestStarted("draft-2");
    await expect(discardAgentLaunchForClosedDraft("draft-2")).resolves.toBeUndefined();
    expect(journalOf(storage, "attempt-2")).toMatchObject({ phase: "workspace_request_started" });

    await expect(discardAgentLaunchForClosedDraft("unbound-draft")).resolves.toBeUndefined();
  });

  it("keeps the journal open when the user empties the launch draft's text", async () => {
    const storage = createMemoryStorage();
    await open(storage);
    useDraftStore.getState().editDraftText({ draftKey: "key:draft-1", text: "" });
    // Journal writes on the memory storage settle within microtasks; one macrotask flushes them.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useDraftStore.getState().getAgentLaunchMetadata("draft-1")).toBeDefined();
    expect(journalOf(storage)).toMatchObject({ phase: "prepared" });
    expect(journalOf(storage)).not.toHaveProperty("terminalOutcome");
  });

  it("exposes the journal for a bound draft", async () => {
    const storage = createMemoryStorage();
    await open(storage);
    expect(await getAgentLaunchJournalForDraft("draft-1")).toMatchObject({ launchId: "attempt-1" });
    expect(await getAgentLaunchJournalForDraft("missing")).toBeNull();
  });
});

describe("cleanup", () => {
  it("removes only the named plugin's journals and abandons their drafts", async () => {
    const storage = createMemoryStorage();
    await open(storage, {}, { pluginId: "todo" });
    await open(storage, { requestFingerprint: "fp-other" }, { pluginId: "other" });
    await removePluginAgentLaunchJournals("host-1", "todo", storage);
    expect(journalOf(storage, "attempt-1", "todo")).toBeNull();
    expect(journalOf(storage, "attempt-1", "other")).not.toBeNull();
    expect(useDraftStore.getState().drafts["key:draft-1"]?.lifecycle).toBe("abandoned");
    expect(useDraftStore.getState().drafts["key:draft-2"]?.lifecycle).toBe("active");
  });

  it("garbage collects expired terminal journals and excess terminal entries but keeps open launches", async () => {
    const storage = createMemoryStorage();
    const now = Date.now();
    for (let index = 0; index < AGENT_LAUNCH_JOURNAL_ENTRY_LIMIT + 3; index += 1) {
      await open(storage, { launchId: `launch-${index}`, requestFingerprint: `fp-${index}` });
    }
    // Terminate every journal except the first two.
    for (let index = 2; index < AGENT_LAUNCH_JOURNAL_ENTRY_LIMIT + 3; index += 1) {
      await markAgentCreated({
        draftId: `draft-${index + 1}`,
        workspaceId: "wks",
        agentId: `agent-${index}`,
      });
    }
    // Make one terminal journal very old.
    const oldKey = buildAgentLaunchJournalKey({
      serverId: "host-1",
      pluginId: "todo",
      documentIncarnationId: "inc-1",
      launchId: "launch-5",
    });
    const old = JSON.parse(storage.values.get(oldKey)!) as { updatedAt: number };
    old.updatedAt = now - AGENT_LAUNCH_TERMINAL_RETENTION_MS - 1000;
    storage.values.set(oldKey, JSON.stringify(old));

    await garbageCollectAgentLaunchJournals(storage, now);
    expect(storage.values.has(oldKey)).toBe(false);
    expect(journalOf(storage, "launch-0")).not.toBeNull();
    expect(journalOf(storage, "launch-1")).not.toBeNull();
    expect(storage.values.size).toBeLessThanOrEqual(AGENT_LAUNCH_JOURNAL_ENTRY_LIMIT);
  });
});
