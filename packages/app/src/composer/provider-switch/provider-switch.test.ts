import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentProviderSwitchError } from "@getpaseo/client/internal/daemon-client";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { dispatchComposerAgentMessage } from "@/composer/actions";
import { isPromptInActiveSegment } from "@/components/rewind/use-rewind-capabilities";
import { collapseTurns } from "@/agent-stream/turn-collapse/model";
import {
  processAgentStreamEvent,
  processTimelineResponse,
} from "@/timeline/session-stream-reducers";
import { ReplicaCache } from "@/runtime/replica-cache";
import type { ReplicaRow, ReplicaRowStore } from "@/runtime/replica-cache/row-store";
import { HostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ProviderSwitchItem, StreamItem, UserMessageItem } from "@/types/stream";
import {
  clearStagedProviderSwitch,
  getFailedStartupSettings,
  getStagedProviderSwitch,
  useStagedProviderSwitchStore,
} from "./index";

function createInMemoryRowStore(): ReplicaRowStore {
  const rows = new Map<string, ReplicaRow>();
  const keyOf = (r: { serverId: string; kind: string; id: string }) =>
    `${r.serverId}:${r.kind}:${r.id}`;
  return {
    async open() {},
    async read(serverId, kinds, ids) {
      const kindSet = new Set(kinds);
      const idSet = ids ? new Set(ids) : null;
      return [...rows.values()].filter(
        (r) => r.serverId === serverId && kindSet.has(r.kind) && (!idSet || idSet.has(r.id)),
      );
    },
    async readAll() {
      const byServer = new Map<string, ReplicaRow[]>();
      for (const row of rows.values()) {
        const list = byServer.get(row.serverId) ?? [];
        list.push(row);
        byServer.set(row.serverId, list);
      }
      return [...byServer.entries()].map(([serverId, list]) => ({ serverId, rows: list }));
    },
    async apply(changes) {
      for (const del of changes.deletes) rows.delete(keyOf(del));
      for (const up of changes.upserts) rows.set(keyOf(up), up);
    },
    async deleteHost(serverId) {
      for (const [k, v] of rows) if (v.serverId === serverId) rows.delete(k);
    },
    async renameHost() {},
    async clear() {
      rows.clear();
    },
  };
}

const TS = "2026-11-25T10:00:00.000Z";

function agentSnapshot(provider: string): AgentSnapshotPayload {
  return {
    id: "agent-1",
    provider,
    cwd: "/repo",
    model: null,
    thinkingOptionId: null,
    createdAt: TS,
    updatedAt: TS,
    lastUserMessageAt: null,
    status: "idle",
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: false,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: true,
      supportsRewindConversation: true,
      supportsRewindFiles: false,
      supportsRewindBoth: false,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: null,
    labels: {},
  };
}

describe("app provider switching integration", () => {
  beforeEach(() => {
    useStagedProviderSwitchStore.setState({ stagedByKey: new Map() });
  });

  it("dispatches switchAgentProvider when staged and handles pre-commit vs post-commit failures", async () => {
    const committed: Array<AgentSnapshotPayload | undefined> = [];
    const sendAgentMessage = vi.fn().mockResolvedValue(undefined);
    const switchAgentProvider = vi.fn().mockResolvedValue({ agent: agentSnapshot("codex") });
    const submission = {
      begin: vi.fn(),
      accept: vi.fn(),
      reject: vi.fn(),
    };

    const staged = {
      provider: "codex",
      model: "gpt-5.4",
      thinkingOptionId: "high",
      modeId: "auto",
      providerOptions: {},
    };

    // Success path
    await dispatchComposerAgentMessage({
      client: {
        sendAgentMessage,
        switchAgentProvider,
        uploadFile: vi.fn(),
      },
      agentId: "agent-1",
      text: "Continue with Codex",
      attachments: [],
      encodeImages: async () => [],
      submission,
      stagedProviderSwitch: staged,
      onProviderSwitchCommitted: (agent) => {
        committed.push(agent);
      },
    });

    expect(sendAgentMessage).not.toHaveBeenCalled();
    expect(switchAgentProvider).toHaveBeenCalledTimes(1);
    expect(committed).toEqual([expect.objectContaining({ provider: "codex" })]);
    expect(submission.accept).toHaveBeenCalledTimes(1);

    // Pre-commit failure: onProviderSwitchCommitted MUST NOT run
    committed.length = 0;
    switchAgentProvider.mockRejectedValueOnce(new Error("Codex CLI unavailable"));
    await expect(
      dispatchComposerAgentMessage({
        client: { sendAgentMessage, switchAgentProvider, uploadFile: vi.fn() },
        agentId: "agent-1",
        text: "Retry",
        attachments: [],
        encodeImages: async () => [],
        submission,
        stagedProviderSwitch: staged,
        onProviderSwitchCommitted: (agent) => {
          committed.push(agent);
        },
      }),
    ).rejects.toThrow("Codex CLI unavailable");
    expect(committed).toEqual([]);

    // Post-commit start failure (AgentProviderSwitchError with .agent): MUST commit live agent snapshot
    switchAgentProvider.mockRejectedValueOnce(
      new AgentProviderSwitchError("Rate limited", agentSnapshot("codex")),
    );
    await expect(
      dispatchComposerAgentMessage({
        client: { sendAgentMessage, switchAgentProvider, uploadFile: vi.fn() },
        agentId: "agent-1",
        text: "Retry 2",
        attachments: [],
        encodeImages: async () => [],
        submission,
        stagedProviderSwitch: staged,
        onProviderSwitchCommitted: (agent) => {
          committed.push(agent);
        },
      }),
    ).rejects.toThrow("Rate limited");
    expect(committed).toEqual([expect.objectContaining({ provider: "codex" })]);
  });

  it("advances activeSegmentStartSeq immediately on live provider_switch events and scopes rewind eligibility", () => {
    const preSwitchPrompt: UserMessageItem = {
      kind: "user_message",
      id: "u1",
      messageId: "u1",
      text: "Claude prompt",
      timestamp: new Date(TS),
      timelineCursor: { epoch: "ep-1", seq: 1, anchorSeq: 1 },
    };

    const liveResult = processAgentStreamEvent({
      event: {
        type: "timeline",
        provider: "codex",
        item: {
          type: "provider_switch",
          fromProvider: "claude",
          toProvider: "codex",
          fromModel: "sonnet",
          toModel: "gpt-5.4",
          fromSessionId: "s1",
          toSessionId: null,
          context: { includedItems: 2, truncated: false, charCount: 100, budgetChars: 100_000 },
        },
      },
      seq: 3,
      epoch: "ep-1",
      currentTail: [preSwitchPrompt],
      currentHead: [],
      currentCursor: { epoch: "ep-1", startSeq: 1, endSeq: 2 },
      hasAuthoritativeBaseline: true,
      timestamp: new Date(TS),
    });

    expect(liveResult.cursor?.activeSegmentStartSeq).toBe(3);
    expect(liveResult.tail.some((item) => item.kind === "provider_switch")).toBe(true);

    // Pre-switch prompt (anchor 1 <= 3) is NOT rewindable; post-switch prompt (anchor 4 > 3) IS!
    expect(
      isPromptInActiveSegment(
        preSwitchPrompt.timelineCursor,
        liveResult.cursor?.activeSegmentStartSeq,
      ),
    ).toBe(false);
    expect(
      isPromptInActiveSegment({ seq: 4, anchorSeq: 4 }, liveResult.cursor?.activeSegmentStartSeq),
    ).toBe(true);

    // Timeline page response also propagates activeSegmentStartSeq
    const pageResult = processTimelineResponse({
      payload: {
        agentId: "agent-1",
        direction: "tail",
        projection: "projected",
        reset: true,
        epoch: "ep-1",
        window: { minSeq: 1, maxSeq: 4, nextSeq: 5 },
        startCursor: { seq: 1 },
        endCursor: { seq: 4 },
        hasNewer: false,
        hasOlder: false,
        activeSegmentStartSeq: 3,
        entries: [
          {
            seqStart: 1,
            seqEnd: 1,
            provider: "claude",
            timestamp: TS,
            item: { type: "user_message", text: "Claude prompt", messageId: "u1" },
          },
          {
            seqStart: 3,
            seqEnd: 3,
            provider: "codex",
            timestamp: TS,
            item: {
              type: "provider_switch",
              fromProvider: "claude",
              toProvider: "codex",
              context: { includedItems: 1, truncated: false, charCount: 50, budgetChars: 100_000 },
            },
          },
        ],
        error: null,
      },
      currentTail: [],
      currentHead: [],
      currentCursor: undefined,
      isInitializing: true,
      hasActiveInitDeferred: false,
      initRequestDirection: "tail",
      sendingClientMessageIds: [],
    });

    expect(pageResult.cursor?.activeSegmentStartSeq).toBe(3);
  });

  it("persists provider_switch items and activeSegmentStartSeq in ReplicaCache and keeps markers visible when turns collapse", async () => {
    const rowStore = createInMemoryRowStore();
    const cache = new ReplicaCache(rowStore);
    cache.setHosts(["srv-1"]);
    const switchItem: ProviderSwitchItem = {
      kind: "provider_switch",
      id: "provider_switch:ep-1:3",
      timestamp: new Date(TS),
      timelineCursor: { epoch: "ep-1", seq: 3, anchorSeq: 3 },
      fromProvider: "claude",
      toProvider: "codex",
      fromModel: "sonnet",
      toModel: "gpt-5.4",
      fromSessionId: "s1",
      toSessionId: null,
      context: {
        includedItems: 2,
        truncated: true,
        charCount: 150,
        budgetChars: 100_000,
        omittedReasons: ["tail_window_limit"],
      },
    };
    const items: StreamItem[] = [
      {
        kind: "user_message",
        id: "u1",
        messageId: "u1",
        text: "Hello",
        timestamp: new Date(TS),
        timelineCursor: { epoch: "ep-1", seq: 1, anchorSeq: 1 },
      },
      switchItem,
    ];

    cache.commitTimeline("srv-1", "agent-1", {
      agentId: "agent-1",
      items,
      range: { epoch: "ep-1", startSeq: 1, endSeq: 3, activeSegmentStartSeq: 3 },
      hasOlder: false,
    });
    await cache.flush();

    const restored = await cache.readTimeline("srv-1", "agent-1");
    expect(restored?.range?.activeSegmentStartSeq).toBe(3);
    expect(restored?.items.find((i) => i.kind === "provider_switch")).toMatchObject({
      kind: "provider_switch",
      fromProvider: "claude",
      toProvider: "codex",
      context: { truncated: true, omittedReasons: ["tail_window_limit"] },
    });

    // Turn collapse keeps provider_switch visible
    const collapsed = collapseTurns({
      tail: [
        items[0]!,
        {
          kind: "tool_call",
          id: "tc1",
          timestamp: new Date(TS),
          payload: {
            source: "agent",
            data: {
              provider: "claude",
              callId: "c1",
              name: "read",
              status: "completed",
              error: null,
              detail: { type: "read", filePath: "a.ts" },
            },
          },
        },
        switchItem,
        {
          kind: "assistant_message",
          id: "a1",
          text: "Done",
          timestamp: new Date(TS),
        },
      ],
      isLatestTurnOpen: false,
      expandedHostIds: new Set(),
      getGroupedCalls: () => undefined,
      previousSummaryRowsByHostId: new Map(),
    });
    expect(collapsed.tail.some((item) => item.kind === "provider_switch")).toBe(true);
  });

  it("blocks M2 drain while M1's staged provider switch is in-flight, then sends M2 normally to P2", async () => {
    const serverId = "srv_multi_queue_switch";
    let resolveSwitch!: (value: { agent: AgentSnapshotPayload }) => void;
    const switchPromise = new Promise<{ agent: AgentSnapshotPayload }>((resolve) => {
      resolveSwitch = resolve;
    });
    const switchedCalls: string[] = [];
    const sentCalls: string[] = [];
    const fakeClient = {
      switchAgentProvider: vi.fn(async (_agentId: string, opts: { text: string }) => {
        switchedCalls.push(opts.text);
        return await switchPromise;
      }),
      sendAgentMessage: vi.fn(async (_agentId: string, text: string) => {
        sentCalls.push(text);
      }),
      uploadFile: vi.fn(),
    } as unknown as DaemonClient;

    const runtime = new HostRuntimeStore({
      deps: {
        createClient: () => fakeClient,
        connectToDaemon: async () => ({ client: fakeClient, serverId, hostname: null }),
        getClientId: async () => "cid_multi_queue_switch",
      },
    });
    const sessionStore = useSessionStore.getState();
    sessionStore.initializeSession(serverId, fakeClient, 1);
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [serverId]: {
          ...state.sessions[serverId]!,
          serverInfo: {
            serverId,
            hostname: "localhost",
            version: "0.18.0",
            features: { providerSwitching: true },
          },
        },
      },
    }));
    sessionStore.setAgents(
      serverId,
      new Map([
        [
          "agent-1",
          {
            ...agentSnapshot("claude"),
            serverId,
            parentAgentId: null,
            createdAt: new Date(TS),
            updatedAt: new Date(TS),
            lastUserMessageAt: null,
            lastActivityAt: new Date(TS),
            attentionTimestamp: null,
            archivedAt: null,
            turn: { phase: "idle", cancellationRequestId: null },
          },
        ],
      ]),
    );
    sessionStore.setQueuedMessages(
      serverId,
      new Map([
        [
          "agent-1",
          [
            { id: "m1", text: "First queued switch prompt", attachments: [] },
            { id: "m2", text: "Second queued follow-up", attachments: [] },
          ],
        ],
      ]),
    );
    useStagedProviderSwitchStore.getState().stage(serverId, "agent-1", {
      provider: "codex",
      model: "gpt-5.4",
      thinkingOptionId: null,
      modeId: null,
      providerOptions: {},
    });

    // M1 begins switching
    runtime.drainQueuedAgentMessage(serverId, "agent-1");
    await vi.waitFor(() => {
      expect(switchedCalls).toEqual(["First queued switch prompt"]);
    });

    // Concurrent drain trigger while M1's switch is still running MUST NOT drain M2!
    sessionStore.setAgents(
      serverId,
      new Map([
        [
          "agent-1",
          {
            ...agentSnapshot("codex"),
            serverId,
            parentAgentId: null,
            createdAt: new Date(TS),
            updatedAt: new Date(TS),
            lastUserMessageAt: null,
            lastActivityAt: new Date(TS),
            attentionTimestamp: null,
            archivedAt: null,
            status: "running",
            turn: {
              phase: "open",
              turnId: "t1",
              startedAt: new Date(TS),
              cancellationRequestId: null,
            },
          },
        ],
      ]),
    );
    runtime.drainQueuedAgentMessage(serverId, "agent-1");
    expect(sentCalls).toEqual([]);
    expect(switchedCalls).toHaveLength(1);
    expect(useSessionStore.getState().sessions[serverId]?.queuedMessages.get("agent-1")).toEqual([
      { id: "m2", text: "Second queued follow-up", attachments: [] },
    ]);

    // M1 switch completes while P2 is still running -> staged switch clears, M2 stays queued until idle.
    resolveSwitch({ agent: { ...agentSnapshot("codex"), status: "running" } });
    await vi.waitFor(() => {
      expect(getStagedProviderSwitch(serverId, "agent-1")).toBeNull();
    });
    expect(sentCalls).toEqual([]);

    // Once P2 goes idle and triggers drain, M2 drains as a plain sendAgentMessage to Codex.
    sessionStore.setAgents(
      serverId,
      new Map([
        [
          "agent-1",
          {
            ...agentSnapshot("codex"),
            serverId,
            parentAgentId: null,
            createdAt: new Date(TS),
            updatedAt: new Date(TS),
            lastUserMessageAt: null,
            lastActivityAt: new Date(TS),
            attentionTimestamp: null,
            archivedAt: null,
            status: "idle",
            turn: { phase: "idle", cancellationRequestId: null },
          },
        ],
      ]),
    );
    runtime.drainQueuedAgentMessage(serverId, "agent-1");
    await vi.waitFor(() => {
      expect(sentCalls).toEqual(["Second queued follow-up"]);
    });
    expect(switchedCalls).toHaveLength(1);
    sessionStore.clearSession(serverId);
  });

  it("re-drains M2 automatically if a fast switch turn finishes before the switch RPC replies", async () => {
    const serverId = "srv-fast-queue-switch";
    const switchedCalls: string[] = [];
    const sentCalls: string[] = [];
    let resolveSwitch!: (value: { agent?: AgentSnapshotPayload }) => void;

    const fakeClient = {
      switchAgentProvider: vi.fn(
        (_agentId: string, opts: { text: string }) =>
          new Promise<{ agent?: AgentSnapshotPayload }>((resolve) => {
            switchedCalls.push(opts.text);
            resolveSwitch = resolve;
          }),
      ),
      sendAgentMessage: vi.fn(async (_agentId: string, text: string) => {
        sentCalls.push(text);
        return { messageId: "m2-ack" };
      }),
      uploadFile: vi.fn(),
    } as unknown as DaemonClient;

    const runtime = new HostRuntimeStore({
      deps: {
        createClient: () => fakeClient,
        connectToDaemon: async () => ({ client: fakeClient, serverId, hostname: null }),
        getClientId: async () => "cid_fast_queue_switch",
      },
    });
    const sessionStore = useSessionStore.getState();
    sessionStore.initializeSession(serverId, fakeClient, 1);
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [serverId]: {
          ...state.sessions[serverId]!,
          serverInfo: {
            serverId,
            hostname: "localhost",
            version: "0.18.0",
            features: { providerSwitching: true },
          },
        },
      },
    }));
    sessionStore.setAgents(
      serverId,
      new Map([
        [
          "agent-1",
          {
            ...agentSnapshot("claude"),
            serverId,
            parentAgentId: null,
            createdAt: new Date(TS),
            updatedAt: new Date(TS),
            lastUserMessageAt: null,
            lastActivityAt: new Date(TS),
            attentionTimestamp: null,
            archivedAt: null,
            status: "idle",
            turn: { phase: "idle", cancellationRequestId: null },
          },
        ],
      ]),
    );
    sessionStore.setQueuedMessages(
      serverId,
      new Map([
        [
          "agent-1",
          [
            { id: "m1", text: "Fast switch prompt", attachments: [] },
            { id: "m2", text: "Follow-up after fast switch", attachments: [] },
          ],
        ],
      ]),
    );
    useStagedProviderSwitchStore.getState().stage(serverId, "agent-1", {
      provider: "codex",
      model: "gpt-5.4",
      thinkingOptionId: null,
      modeId: null,
      providerOptions: {},
    });

    // M1 begins switching
    runtime.drainQueuedAgentMessage(serverId, "agent-1");
    await vi.waitFor(() => {
      expect(switchedCalls).toEqual(["Fast switch prompt"]);
    });

    // Fast provider completes M1's turn BEFORE switch RPC replies: status is idle and turn-end
    // calls drainQueuedAgentMessage while the lock is held.
    runtime.drainQueuedAgentMessage(serverId, "agent-1");
    expect(sentCalls).toEqual([]);

    // Switch RPC replies with idle agent -> finally MUST automatically drain M2 without another trigger!
    resolveSwitch({ agent: { ...agentSnapshot("codex"), status: "idle" } });
    await vi.waitFor(() => {
      expect(sentCalls).toEqual(["Follow-up after fast switch"]);
    });
    expect(switchedCalls).toHaveLength(1);
    sessionStore.clearSession(serverId);
  });

  it("preserves a newer staged provider choice made while an earlier queued switch reply is pending", async () => {
    const serverId = "srv-newer-choice-queue";
    const switchedCalls: Array<{ provider: string; text: string }> = [];
    const sentCalls: string[] = [];
    let resolveFirstSwitch!: (value: { agent?: AgentSnapshotPayload }) => void;

    const fakeClient = {
      switchAgentProvider: vi.fn((_agentId: string, opts: { provider: string; text: string }) => {
        switchedCalls.push({ provider: opts.provider, text: opts.text });
        if (switchedCalls.length === 1) {
          return new Promise<{ agent?: AgentSnapshotPayload }>((resolve) => {
            resolveFirstSwitch = resolve;
          });
        }
        return Promise.resolve({
          agent: { ...agentSnapshot(opts.provider), status: "running" },
        });
      }),
      sendAgentMessage: vi.fn(async (_agentId: string, text: string) => {
        sentCalls.push(text);
        return { messageId: "unexpected-plain-send" };
      }),
      uploadFile: vi.fn(),
    } as unknown as DaemonClient;

    const runtime = new HostRuntimeStore({
      deps: {
        createClient: () => fakeClient,
        connectToDaemon: async () => ({ client: fakeClient, serverId, hostname: null }),
        getClientId: async () => "cid_newer_choice_queue",
      },
    });
    const sessionStore = useSessionStore.getState();
    sessionStore.initializeSession(serverId, fakeClient, 1);
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [serverId]: {
          ...state.sessions[serverId]!,
          serverInfo: {
            serverId,
            hostname: "localhost",
            version: "0.18.0",
            features: { providerSwitching: true },
          },
        },
      },
    }));
    sessionStore.setAgents(
      serverId,
      new Map([
        [
          "agent-1",
          {
            ...agentSnapshot("claude"),
            serverId,
            parentAgentId: null,
            createdAt: new Date(TS),
            updatedAt: new Date(TS),
            lastUserMessageAt: null,
            lastActivityAt: new Date(TS),
            attentionTimestamp: null,
            archivedAt: null,
            status: "idle",
            turn: { phase: "idle", cancellationRequestId: null },
          },
        ],
      ]),
    );
    sessionStore.setQueuedMessages(
      serverId,
      new Map([
        [
          "agent-1",
          [
            { id: "m1", text: "First switch to Codex", attachments: [] },
            { id: "m2", text: "Second switch to Copilot", attachments: [] },
          ],
        ],
      ]),
    );
    useStagedProviderSwitchStore.getState().stage(serverId, "agent-1", {
      provider: "codex",
      model: "gpt-5.4",
      thinkingOptionId: null,
      modeId: null,
      providerOptions: {},
    });

    // M1 begins switching to Codex.
    runtime.drainQueuedAgentMessage(serverId, "agent-1");
    await vi.waitFor(() => {
      expect(switchedCalls).toEqual([{ provider: "codex", text: "First switch to Codex" }]);
    });

    // While Codex switch reply is still pending, user selects Copilot for the next prompt.
    useStagedProviderSwitchStore.getState().stage(serverId, "agent-1", {
      provider: "copilot",
      model: "gpt-5",
      thinkingOptionId: null,
      modeId: null,
      providerOptions: {},
    });

    // Codex switch reply arrives -> MUST NOT clear the newer Copilot draft!
    resolveFirstSwitch({ agent: { ...agentSnapshot("codex"), status: "running" } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(getStagedProviderSwitch(serverId, "agent-1")?.provider).toBe("copilot");

    // Once Codex goes idle and queue resumes, M2 MUST switch to Copilot (not send plainly to Codex).
    sessionStore.setAgents(
      serverId,
      new Map([
        [
          "agent-1",
          {
            ...agentSnapshot("codex"),
            serverId,
            parentAgentId: null,
            createdAt: new Date(TS),
            updatedAt: new Date(TS),
            lastUserMessageAt: null,
            lastActivityAt: new Date(TS),
            attentionTimestamp: null,
            archivedAt: null,
            status: "idle",
            turn: { phase: "idle", cancellationRequestId: null },
          },
        ],
      ]),
    );
    runtime.drainQueuedAgentMessage(serverId, "agent-1");
    await vi.waitFor(() => {
      expect(switchedCalls).toEqual([
        { provider: "codex", text: "First switch to Codex" },
        { provider: "copilot", text: "Second switch to Copilot" },
      ]);
    });
    expect(sentCalls).toEqual([]);
    expect(getStagedProviderSwitch(serverId, "agent-1")).toBeNull();
    sessionStore.clearSession(serverId);
  });

  it("forwards target provider setting edits made during switch startup to the live agent and surfaces failed automatic drain errors", async () => {
    const serverId = "srv-edited-and-failed-queue";
    let resolveSwitch!: (value: { agent?: AgentSnapshotPayload }) => void;
    const setAgentModel = vi.fn().mockResolvedValue(undefined);
    const setAgentMode = vi.fn().mockResolvedValue(null);
    const setAgentThinkingOption = vi.fn().mockResolvedValue(undefined);
    const setAgentOptions = vi.fn().mockResolvedValue(undefined);
    let failNextSwitch = false;

    const fakeClient = {
      switchAgentProvider: vi.fn((_agentId: string, _opts: { provider: string; text: string }) => {
        if (failNextSwitch) {
          return Promise.reject(new Error("Codex CLI is not available"));
        }
        return new Promise<{ agent?: AgentSnapshotPayload }>((resolve) => {
          resolveSwitch = resolve;
        });
      }),
      sendAgentMessage: vi.fn(),
      setAgentModel,
      setAgentMode,
      setAgentThinkingOption,
      setAgentOptions,
      uploadFile: vi.fn(),
    } as unknown as DaemonClient;

    const runtime = new HostRuntimeStore({
      deps: {
        createClient: () => fakeClient,
        connectToDaemon: async () => ({ client: fakeClient, serverId, hostname: null }),
        getClientId: async () => "cid_edited_and_failed_queue",
      },
    });
    const sessionStore = useSessionStore.getState();
    sessionStore.initializeSession(serverId, fakeClient, 1);
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [serverId]: {
          ...state.sessions[serverId]!,
          serverInfo: {
            serverId,
            hostname: "localhost",
            version: "0.18.0",
            features: { providerSwitching: true },
          },
        },
      },
    }));
    sessionStore.setAgents(
      serverId,
      new Map([
        [
          "agent-1",
          {
            ...agentSnapshot("claude"),
            serverId,
            parentAgentId: null,
            createdAt: new Date(TS),
            updatedAt: new Date(TS),
            lastUserMessageAt: null,
            lastActivityAt: new Date(TS),
            attentionTimestamp: null,
            archivedAt: null,
            status: "idle",
            turn: { phase: "idle", cancellationRequestId: null },
          },
        ],
      ]),
    );
    sessionStore.setQueuedMessages(
      serverId,
      new Map([["agent-1", [{ id: "m1", text: "Switch with startup edit", attachments: [] }]]]),
    );
    useStagedProviderSwitchStore.getState().stage(serverId, "agent-1", {
      provider: "codex",
      model: "gpt-5.3",
      thinkingOptionId: "low",
      modeId: "auto",
      providerOptions: { fast_mode: false },
    });

    // 1. Pre-commit automatic drain failure restores queue item and exposes error in session store.
    failNextSwitch = true;
    runtime.drainQueuedAgentMessage(serverId, "agent-1");
    await vi.waitFor(() => {
      expect(useSessionStore.getState().sessions[serverId]?.queuedSendErrors.get("agent-1")).toBe(
        "Codex CLI is not available",
      );
    });
    expect(useSessionStore.getState().sessions[serverId]?.queuedMessages.get("agent-1")).toEqual([
      { id: "m1", text: "Switch with startup edit", attachments: [] },
    ]);

    // 2. Retry succeeds: while switch reply is pending, user edits Codex model/thinking/mode/options.
    failNextSwitch = false;
    runtime.drainQueuedAgentMessage(serverId, "agent-1");
    await vi.waitFor(() => {
      expect(fakeClient.switchAgentProvider).toHaveBeenCalledTimes(2);
    });
    expect(useSessionStore.getState().sessions[serverId]?.queuedSendErrors.get("agent-1")).toBe(
      undefined,
    );
    useStagedProviderSwitchStore.getState().patch(serverId, "agent-1", (current) => ({
      ...current,
      model: "gpt-5.4",
      modeId: "full-auto",
      thinkingOptionId: "high",
      providerOptions: { fast_mode: true },
    }));

    resolveSwitch({ agent: { ...agentSnapshot("codex"), status: "running" } });
    await vi.waitFor(() => {
      expect(getStagedProviderSwitch(serverId, "agent-1")).toBeNull();
      expect(setAgentModel).toHaveBeenCalledWith("agent-1", "gpt-5.4", {
        expectedProvider: "codex",
      });
      expect(setAgentMode).toHaveBeenCalledWith("agent-1", "full-auto", {
        expectedProvider: "codex",
      });
      expect(setAgentThinkingOption).toHaveBeenCalledWith("agent-1", "high", {
        expectedProvider: "codex",
      });
      expect(setAgentOptions).toHaveBeenCalledWith(
        "agent-1",
        { fast_mode: true },
        { expectedProvider: "codex" },
      );
    });

    sessionStore.clearSession(serverId);
  });

  it("holds queued follow-up M2 until edited startup settings (including plan_mode) finish applying, and retains the draft if an edit rejects", async () => {
    const serverId = "srv-startup-edit-ordering";
    const callOrder: string[] = [];
    let resolveSwitch!: (value: { agent?: AgentSnapshotPayload }) => void;
    let resolveApplyConfig!: () => void;
    let rejectApplyConfig: ((err: Error) => void) | null = null;

    const fakeClient = {
      switchAgentProvider: vi.fn((_agentId: string, _opts: { provider: string; text: string }) => {
        callOrder.push("switch:codex");
        return new Promise<{ agent?: AgentSnapshotPayload }>((resolve) => {
          resolveSwitch = resolve;
        });
      }),
      applyAgentConfig: vi.fn((_agentId: string, config: unknown, opts?: unknown) => {
        callOrder.push(`applyConfig:${JSON.stringify({ config, opts })}`);
        return new Promise<null>((resolve, reject) => {
          resolveApplyConfig = () => resolve(null);
          rejectApplyConfig = reject;
        });
      }),
      sendAgentMessage: vi.fn(async (_agentId: string, text: string) => {
        callOrder.push(`send:${text}`);
        return { messageId: "m2-ack" };
      }),
      uploadFile: vi.fn(),
    } as unknown as DaemonClient;

    const runtime = new HostRuntimeStore({
      deps: {
        createClient: () => fakeClient,
        connectToDaemon: async () => ({ client: fakeClient, serverId, hostname: null }),
        getClientId: async () => "cid_startup_edit_ordering",
      },
    });
    const sessionStore = useSessionStore.getState();
    sessionStore.initializeSession(serverId, fakeClient, 1);
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [serverId]: {
          ...state.sessions[serverId]!,
          serverInfo: {
            serverId,
            hostname: "localhost",
            version: "0.18.0",
            features: { providerSwitching: true },
          },
        },
      },
    }));
    sessionStore.setAgents(
      serverId,
      new Map([
        [
          "agent-1",
          {
            ...agentSnapshot("claude"),
            serverId,
            parentAgentId: null,
            createdAt: new Date(TS),
            updatedAt: new Date(TS),
            lastUserMessageAt: null,
            lastActivityAt: new Date(TS),
            attentionTimestamp: null,
            archivedAt: null,
            status: "idle",
            turn: { phase: "idle", cancellationRequestId: null },
          },
        ],
      ]),
    );
    sessionStore.setQueuedMessages(
      serverId,
      new Map([
        [
          "agent-1",
          [
            { id: "m1", text: "First prompt", attachments: [] },
            { id: "m2", text: "Follow-up in Plan mode", attachments: [] },
          ],
        ],
      ]),
    );
    useStagedProviderSwitchStore.getState().stage(serverId, "agent-1", {
      provider: "codex",
      model: "gpt-5.3",
      thinkingOptionId: null,
      modeId: null,
      providerOptions: { plan_mode: false },
    });

    // M1 starts switching; while Codex opens, user changes model AND enables plan_mode.
    runtime.drainQueuedAgentMessage(serverId, "agent-1");
    await vi.waitFor(() => {
      expect(callOrder).toEqual(["switch:codex"]);
    });
    useStagedProviderSwitchStore.getState().patch(serverId, "agent-1", (current) => ({
      ...current,
      model: "gpt-5.4",
      providerOptions: { plan_mode: true },
    }));

    // Fast turn finishes idle and triggers queue drain BEFORE switch + settings edits complete.
    runtime.drainQueuedAgentMessage(serverId, "agent-1");
    resolveSwitch({ agent: { ...agentSnapshot("codex"), status: "idle" } });

    await vi.waitFor(() => {
      expect(callOrder).toHaveLength(2);
    });
    // M2 MUST NOT have sent yet while applyAgentConfig (model + plan_mode: true) is still pending!
    expect(callOrder.some((entry) => entry.startsWith("send:"))).toBe(false);

    // Once applyAgentConfig completes, M2 drains strictly AFTER plan_mode: true took effect!
    resolveApplyConfig();
    await vi.waitFor(() => {
      expect(callOrder).toHaveLength(3);
    });
    expect(callOrder[1]).toContain('"plan_mode":true');
    expect(callOrder[1]).toContain('"modelId":"gpt-5.4"');
    expect(callOrder[1]).toContain('"expectedProvider":"codex"');
    expect(callOrder[2]).toBe("send:Follow-up in Plan mode");
    expect(getStagedProviderSwitch(serverId, "agent-1")).toBeNull();

    // Case 2: If daemon rejects the edited settings, draft is RETAINED, error is surfaced, and M2 is HELD.
    callOrder.length = 0;
    sessionStore.setQueuedMessages(
      serverId,
      new Map([
        [
          "agent-1",
          [
            { id: "m3", text: "Switch with rejected edit", attachments: [] },
            { id: "m4", text: "Must stay queued", attachments: [] },
          ],
        ],
      ]),
    );
    useStagedProviderSwitchStore.getState().stage(serverId, "agent-1", {
      provider: "codex",
      model: "gpt-5.3",
      thinkingOptionId: null,
      modeId: null,
      providerOptions: { plan_mode: false },
    });
    runtime.drainQueuedAgentMessage(serverId, "agent-1");
    await vi.waitFor(() => {
      expect(callOrder).toEqual(["switch:codex"]);
    });
    useStagedProviderSwitchStore.getState().patch(serverId, "agent-1", (current) => ({
      ...current,
      providerOptions: { plan_mode: true },
    }));
    runtime.drainQueuedAgentMessage(serverId, "agent-1");
    resolveSwitch({ agent: { ...agentSnapshot("codex"), status: "idle" } });
    await vi.waitFor(() => {
      expect(callOrder).toHaveLength(2);
    });

    rejectApplyConfig!(new Error("Plan mode rejected by provider"));
    await vi.waitFor(() => {
      expect(useSessionStore.getState().sessions[serverId]?.queuedSendErrors.get("agent-1")).toBe(
        "Plan mode rejected by provider",
      );
    });
    expect(getFailedStartupSettings(serverId, "agent-1")?.bundle).toEqual({
      options: { plan_mode: true },
    });

    // Ordinary draft actions (like the model picker calling clearStagedProviderSwitch on a live
    // Codex model change) and later drain callbacks MUST leave failedStartupSettings and the queue
    // hold intact until the user explicitly chooses Retry or Dismiss!
    clearStagedProviderSwitch(serverId, "agent-1");
    runtime.drainQueuedAgentMessage(serverId, "agent-1");
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(useSessionStore.getState().sessions[serverId]?.queuedSendErrors.get("agent-1")).toBe(
      "Plan mode rejected by provider",
    );
    expect(getFailedStartupSettings(serverId, "agent-1")?.bundle).toEqual({
      options: { plan_mode: true },
    });
    expect(callOrder.some((entry) => entry.startsWith("send:"))).toBe(false);
    expect(useSessionStore.getState().sessions[serverId]?.queuedMessages.get("agent-1")).toEqual([
      { id: "m4", text: "Must stay queued", attachments: [] },
    ]);

    // Retrying via the single recovery action re-applies the exact failed bundle (plan_mode: true)
    // and automatically resumes the idle queue strictly AFTER the retry succeeds!
    const retryPromise = runtime.recoverFailedStartupSettings(serverId, "agent-1", "retry");
    await vi.waitFor(() => {
      expect(callOrder).toHaveLength(3);
    });
    expect(callOrder[2]).toContain('"plan_mode":true');
    // Still waiting for applyAgentConfig response -> M4 MUST NOT send yet!
    expect(callOrder.some((entry) => entry.startsWith("send:"))).toBe(false);
    resolveApplyConfig();
    expect(await retryPromise).toBe(true);
    await vi.waitFor(() => {
      expect(callOrder).toContain("send:Must stay queued");
    });
    expect(getFailedStartupSettings(serverId, "agent-1")).toBeNull();
    expect(useSessionStore.getState().sessions[serverId]?.queuedSendErrors.get("agent-1")).toBe(
      undefined,
    );

    // Case 3: Explicit discard clears the failed settings and resumes an idle queue immediately.
    callOrder.length = 0;
    sessionStore.setQueuedMessages(
      serverId,
      new Map([
        [
          "agent-1",
          [
            { id: "m5", text: "Switch with discarded edit", attachments: [] },
            { id: "m6", text: "Send after explicit discard", attachments: [] },
          ],
        ],
      ]),
    );
    useStagedProviderSwitchStore.getState().stage(serverId, "agent-1", {
      provider: "codex",
      model: "gpt-5.3",
      thinkingOptionId: null,
      modeId: null,
      providerOptions: { plan_mode: false },
    });
    runtime.drainQueuedAgentMessage(serverId, "agent-1");
    await vi.waitFor(() => {
      expect(callOrder).toEqual(["switch:codex"]);
    });
    useStagedProviderSwitchStore.getState().patch(serverId, "agent-1", (current) => ({
      ...current,
      providerOptions: { plan_mode: true },
    }));
    runtime.drainQueuedAgentMessage(serverId, "agent-1");
    resolveSwitch({ agent: { ...agentSnapshot("codex"), status: "idle" } });
    await vi.waitFor(() => {
      expect(callOrder).toHaveLength(2);
    });
    rejectApplyConfig!(new Error("Disconnected"));
    await vi.waitFor(() => {
      expect(getFailedStartupSettings(serverId, "agent-1")?.errorMessage).toBe("Disconnected");
    });
    expect(callOrder.some((entry) => entry.startsWith("send:"))).toBe(false);

    expect(await runtime.recoverFailedStartupSettings(serverId, "agent-1", "discard")).toBe(true);
    await vi.waitFor(() => {
      expect(callOrder).toContain("send:Send after explicit discard");
    });
    expect(getFailedStartupSettings(serverId, "agent-1")).toBeNull();

    sessionStore.clearSession(serverId);
  });
});
