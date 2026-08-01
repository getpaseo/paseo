import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LiveVoiceAvailability } from "@/live-voice/live-voice-availability-policy";
import type { LiveVoiceSnapshot } from "@/live-voice/live-voice-runtime";
import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";
import { WearBridge, type WearBridgeTransport, type WearLiveVoiceController } from "./wear-bridge";
import { parseWearCommand, WEAR_PROTOCOL_VERSION } from "./wear-protocol";
import { buildWearSnapshot, formatAge, providerLabel } from "./wear-snapshot";

const NOW = new Date("2026-07-29T12:00:00Z").getTime();

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    serverId: "srv-1",
    id: "a-1",
    provider: "claude",
    status: "running",
    createdAt: new Date(NOW - 600_000),
    updatedAt: new Date(NOW),
    lastUserMessageAt: null,
    lastActivityAt: new Date(NOW - 720_000),
    capabilities: {} as Agent["capabilities"],
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: "Rewrite the retry loop",
    cwd: "/home/dev/paseo",
    workspaceId: "ws-1",
    model: null,
    parentAgentId: null,
    labels: {},
    ...overrides,
  } as Agent;
}

function workspace(overrides: Partial<WorkspaceDescriptor> = {}): WorkspaceDescriptor {
  return {
    id: "ws-1",
    projectId: "prj_abc",
    projectDisplayName: "paseo",
    projectRootPath: "/home/dev/paseo",
    workspaceDirectory: "/home/dev/paseo",
    projectKind: "git",
    workspaceKind: "worktree",
    name: "jubilant-wombat",
    status: "active",
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    scripts: [],
    project: {
      projectKey: "github.com/getpaseo/paseo",
      projectName: "paseo",
      workspaceName: "jubilant-wombat",
      checkout: {} as NonNullable<WorkspaceDescriptor["project"]>["checkout"],
    },
    ...overrides,
  } as WorkspaceDescriptor;
}

function workspaceMap(...items: WorkspaceDescriptor[]): Map<string, WorkspaceDescriptor> {
  return new Map(items.map((item) => [item.id, item]));
}

describe("formatAge", () => {
  it("renders wrist-sized durations", () => {
    expect(formatAge(new Date(NOW - 5_000), NOW)).toBe("now");
    expect(formatAge(new Date(NOW - 12 * 60_000), NOW)).toBe("12m");
    expect(formatAge(new Date(NOW - 3 * 3_600_000), NOW)).toBe("3h");
    expect(formatAge(new Date(NOW - 50 * 3_600_000), NOW)).toBe("2d");
  });

  it("never renders a negative age from clock skew", () => {
    expect(formatAge(new Date(NOW + 60_000), NOW)).toBe("now");
  });
});

describe("providerLabel", () => {
  it("maps known provider ids to display names", () => {
    expect(providerLabel("claude")).toBe("Claude");
    expect(providerLabel("omp")).toBe("Oh My Pi");
  });

  it("falls back to capitalising an unknown provider", () => {
    expect(providerLabel("newthing")).toBe("Newthing");
  });
});

describe("buildWearSnapshot", () => {
  it("groups agents under their workspace and carries project identity", () => {
    const snapshot = buildWearSnapshot(
      [{ serverId: "srv-1", agents: [agent()], workspaces: workspaceMap(workspace()) }],
      NOW,
    );

    expect(snapshot.v).toBe(WEAR_PROTOCOL_VERSION);
    expect(snapshot.workspaces).toHaveLength(1);
    const ws = snapshot.workspaces[0];
    expect(ws.name).toBe("jubilant-wombat");
    expect(ws.projectKey).toBe("github.com/getpaseo/paseo");
    expect(ws.serverId).toBe("srv-1");
    expect(ws.agents[0]).toMatchObject({
      provider: "Claude",
      state: "running",
      age: "12m",
      summary: "Rewrite the retry loop",
    });
  });

  it("includes a workspace that has no agents", () => {
    // Regression: the builder used to group by agent, so an agent-less workspace
    // vanished. That broke the empty-workspace row and its go-straight-to-voice
    // navigation rule.
    const snapshot = buildWearSnapshot(
      [{ serverId: "srv-1", agents: [], workspaces: workspaceMap(workspace()) }],
      NOW,
    );
    expect(snapshot.workspaces).toHaveLength(1);
    expect(snapshot.workspaces[0].agents).toEqual([]);
  });

  it("still emits workspaces when nothing is running anywhere", () => {
    // The failure this caused was worse than a missing row: with no agents at all
    // the snapshot came out empty and the watch showed "open Paseo on your phone"
    // as though the bridge were down.
    const snapshot = buildWearSnapshot(
      [
        {
          serverId: "srv-1",
          agents: [],
          workspaces: workspaceMap(workspace(), workspace({ id: "ws-2", name: "other" })),
        },
      ],
      NOW,
    );
    expect(snapshot.workspaces.map((entry) => entry.name)).toEqual(["jubilant-wombat", "other"]);
  });

  it("omits a workspace that is being archived", () => {
    const snapshot = buildWearSnapshot(
      [
        {
          serverId: "srv-1",
          agents: [agent()],
          workspaces: workspaceMap(workspace({ archivingAt: "2026-07-29T00:00:00Z" })),
        },
      ],
      NOW,
    );
    expect(snapshot.workspaces).toHaveLength(0);
  });

  it("sorts agent-less workspaces after idle ones", () => {
    const snapshot = buildWearSnapshot(
      [
        {
          serverId: "srv-1",
          agents: [agent({ id: "a-idle", workspaceId: "ws-idle", status: "idle" })],
          workspaces: workspaceMap(
            workspace({ id: "ws-empty", name: "aaa-empty" }),
            workspace({ id: "ws-idle", name: "zzz-idle" }),
          ),
        },
      ],
      NOW,
    );
    // Name ordering would put the empty one first; urgency must win.
    expect(snapshot.workspaces.map((entry) => entry.name)).toEqual(["zzz-idle", "aaa-empty"]);
  });

  it("drops agents whose workspace is unknown rather than inventing a parent", () => {
    const snapshot = buildWearSnapshot(
      [
        {
          serverId: "srv-1",
          agents: [agent({ workspaceId: "ws-missing" })],
          workspaces: workspaceMap(workspace()),
        },
      ],
      NOW,
    );
    // The agent is dropped — no synthetic parent workspace is invented for it —
    // but the known workspace is still listed, now with nothing in it.
    expect(snapshot.workspaces.map((entry) => entry.id)).toEqual(["ws-1"]);
    expect(snapshot.workspaces[0].agents).toEqual([]);
  });

  it("omits archived agents but keeps their workspace", () => {
    const snapshot = buildWearSnapshot(
      [
        {
          serverId: "srv-1",
          agents: [agent({ archivedAt: new Date(NOW) })],
          workspaces: workspaceMap(workspace()),
        },
      ],
      NOW,
    );
    expect(snapshot.workspaces).toHaveLength(1);
    expect(snapshot.workspaces[0].agents).toEqual([]);
  });

  it("marks an agent with a pending permission as needsInput and extracts the command", () => {
    const withPermission = agent({
      pendingPermissions: [
        {
          id: "perm-1",
          provider: "claude",
          name: "Bash",
          kind: "tool",
          input: { command: "git push origin jubilant-wombat" },
        } as Agent["pendingPermissions"][number],
      ],
    });

    const snapshot = buildWearSnapshot(
      [{ serverId: "srv-1", agents: [withPermission], workspaces: workspaceMap(workspace()) }],
      NOW,
    );

    const entry = snapshot.workspaces[0].agents[0];
    expect(entry.state).toBe("needsInput");
    expect(entry.permission).toEqual({
      id: "perm-1",
      title: "Run command?",
      detail: "git push origin jubilant-wombat",
    });
  });

  it("sorts needs-attention workspaces ahead of running and idle ones", () => {
    const idle = workspace({ id: "ws-idle", name: "zeta" });
    const urgent = workspace({ id: "ws-urgent", name: "alpha" });
    const running = workspace({ id: "ws-running", name: "mid" });

    const snapshot = buildWearSnapshot(
      [
        {
          serverId: "srv-1",
          agents: [
            agent({ id: "a-idle", workspaceId: "ws-idle", status: "idle" }),
            agent({
              id: "a-urgent",
              workspaceId: "ws-urgent",
              pendingPermissions: [
                {
                  id: "p",
                  provider: "claude",
                  name: "Bash",
                  kind: "tool",
                } as Agent["pendingPermissions"][number],
              ],
            }),
            agent({ id: "a-running", workspaceId: "ws-running", status: "running" }),
          ],
          workspaces: workspaceMap(idle, urgent, running),
        },
      ],
      NOW,
    );

    expect(snapshot.workspaces.map((entry) => entry.name)).toEqual(["alpha", "mid", "zeta"]);
  });

  it("merges multiple daemons into one list", () => {
    const snapshot = buildWearSnapshot(
      [
        { serverId: "srv-1", agents: [agent()], workspaces: workspaceMap(workspace()) },
        {
          serverId: "srv-2",
          agents: [agent({ id: "a-2", workspaceId: "ws-2" })],
          workspaces: workspaceMap(workspace({ id: "ws-2", name: "other" })),
        },
      ],
      NOW,
    );
    expect(snapshot.workspaces.map((entry) => entry.serverId).sort()).toEqual(["srv-1", "srv-2"]);
  });
});

describe("parseWearCommand", () => {
  it("parses each command kind", () => {
    expect(
      parseWearCommand(
        JSON.stringify({ v: 1, kind: "sendPrompt", serverId: "s", agentId: "a", text: "hi" }),
      ),
    ).toEqual({ kind: "sendPrompt", serverId: "s", agentId: "a", text: "hi" });

    expect(
      parseWearCommand(
        JSON.stringify({
          v: 1,
          kind: "respondPermission",
          serverId: "s",
          agentId: "a",
          requestId: "r",
          allow: false,
        }),
      ),
    ).toEqual({
      kind: "respondPermission",
      serverId: "s",
      agentId: "a",
      requestId: "r",
      allow: false,
    });

    expect(parseWearCommand(JSON.stringify({ kind: "refresh" }))).toEqual({ kind: "refresh" });

    expect(
      parseWearCommand(
        JSON.stringify({ v: 1, kind: "requestTranscript", serverId: "s", agentId: "a" }),
      ),
    ).toEqual({ kind: "requestTranscript", serverId: "s", agentId: "a" });
  });

  it("rejects a transcript request with no agent to fetch", () => {
    expect(
      parseWearCommand(JSON.stringify({ v: 1, kind: "requestTranscript", serverId: "s" })),
    ).toBeNull();
  });

  it("parses startLiveVoice with the host it names", () => {
    expect(
      parseWearCommand(JSON.stringify({ v: 1, kind: "startLiveVoice", serverId: "s" })),
    ).toEqual({ kind: "startLiveVoice", serverId: "s" });
  });

  it("parses stop and mute without a serverId", () => {
    // The runtime owns the single app-global call and already knows its host, so
    // a watch holding a stale state item cannot address a call that has moved.
    expect(parseWearCommand(JSON.stringify({ v: 1, kind: "stopLiveVoice" }))).toEqual({
      kind: "stopLiveVoice",
    });
    expect(parseWearCommand(JSON.stringify({ v: 1, kind: "toggleLiveVoiceMute" }))).toEqual({
      kind: "toggleLiveVoiceMute",
    });
  });

  it("rejects a startLiveVoice with no host to call", () => {
    expect(parseWearCommand(JSON.stringify({ v: 1, kind: "startLiveVoice" }))).toBeNull();
  });

  it("version-gates the live voice commands, unlike refresh", () => {
    expect(parseWearCommand(JSON.stringify({ v: 99, kind: "stopLiveVoice" }))).toBeNull();
    expect(parseWearCommand(JSON.stringify({ v: 99, kind: "refresh" }))).toEqual({
      kind: "refresh",
    });
  });

  it("rejects malformed, incomplete, and wrong-version commands", () => {
    expect(parseWearCommand("{ not json")).toBeNull();
    expect(parseWearCommand(JSON.stringify({ kind: "sendPrompt", serverId: "s" }))).toBeNull();
    expect(
      parseWearCommand(JSON.stringify({ v: 99, kind: "stopAgent", serverId: "s", agentId: "a" })),
    ).toBeNull();
    // allow must be a real boolean; a truthy string is a protocol error, not a yes.
    expect(
      parseWearCommand(
        JSON.stringify({
          v: 1,
          kind: "respondPermission",
          serverId: "s",
          agentId: "a",
          requestId: "r",
          allow: "yes",
        }),
      ),
    ).toBeNull();
  });
});

function makeTransport(): WearBridgeTransport & {
  published: string[];
  transcripts: Array<{ agentId: string; payload: string }>;
  icons: Array<{ projectKey: string; data: string; mimeType: string }>;
  liveVoice: string[];
  emit: (payload: string) => void;
} {
  const published: string[] = [];
  const transcripts: Array<{ agentId: string; payload: string }> = [];
  const icons: Array<{ projectKey: string; data: string; mimeType: string }> = [];
  const liveVoice: string[] = [];
  let listener: ((payload: string) => void) | null = null;
  return {
    published,
    transcripts,
    icons,
    liveVoice,
    emit: (payload) => listener?.(payload),
    publishSnapshot: async (payload) => {
      published.push(payload);
      return true;
    },
    publishTranscript: async (agentId, payload) => {
      transcripts.push({ agentId, payload });
      return true;
    },
    publishProjectIcon: async (projectKey, data, mimeType) => {
      icons.push({ projectKey, data, mimeType });
      return true;
    },
    publishLiveVoice: async (payload) => {
      liveVoice.push(payload);
      return true;
    },
    addCommandListener: (next) => {
      listener = next;
      return {
        remove: () => {
          listener = null;
        },
      };
    },
    drainPendingCommands: async () => [],
  };
}

describe("WearBridge", () => {
  const baseState = () => [
    { serverId: "srv-1", agents: [agent()], workspaces: workspaceMap(workspace()) },
  ];

  it("publishes once and skips republishing an unchanged snapshot", async () => {
    const transport = makeTransport();
    const bridge = new WearBridge({
      transport,
      readState: baseState,
      getClient: () => null,
      resolveNewAgentConfig: () => null,
      now: () => NOW,
    });

    await bridge.start();
    expect(transport.published).toHaveLength(1);

    await bridge.publish();
    // Nothing changed, so the Data Layer is left alone.
    expect(transport.published).toHaveLength(1);
    bridge.stop();
  });

  it("republishes when the snapshot content actually changes", async () => {
    const transport = makeTransport();
    let status: Agent["status"] = "running";
    const bridge = new WearBridge({
      transport,
      readState: () => [
        { serverId: "srv-1", agents: [agent({ status })], workspaces: workspaceMap(workspace()) },
      ],
      getClient: () => null,
      resolveNewAgentConfig: () => null,
      now: () => NOW,
    });

    await bridge.start();
    status = "idle";
    await bridge.publish();
    expect(transport.published).toHaveLength(2);
    bridge.stop();
  });

  it("routes a permission response to the right daemon client", async () => {
    const transport = makeTransport();
    const respondToPermission = vi.fn().mockResolvedValue(undefined);
    const bridge = new WearBridge({
      transport,
      readState: baseState,
      getClient: (serverId) => (serverId === "srv-1" ? ({ respondToPermission } as never) : null),
      resolveNewAgentConfig: () => null,
      now: () => NOW,
    });
    await bridge.start();

    await bridge.execute({
      kind: "respondPermission",
      serverId: "srv-1",
      agentId: "a-1",
      requestId: "perm-1",
      allow: true,
    });

    expect(respondToPermission).toHaveBeenCalledWith("a-1", "perm-1", { behavior: "allow" });
    bridge.stop();
  });

  it("maps deny to a deny behavior rather than an allow with a flag", async () => {
    const transport = makeTransport();
    const respondToPermission = vi.fn().mockResolvedValue(undefined);
    const bridge = new WearBridge({
      transport,
      readState: baseState,
      getClient: () => ({ respondToPermission }) as never,
      resolveNewAgentConfig: () => null,
      now: () => NOW,
    });
    await bridge.start();

    await bridge.execute({
      kind: "respondPermission",
      serverId: "srv-1",
      agentId: "a-1",
      requestId: "perm-1",
      allow: false,
    });

    expect(respondToPermission).toHaveBeenCalledWith("a-1", "perm-1", { behavior: "deny" });
    bridge.stop();
  });

  it("delivers a prompt received over the native command listener", async () => {
    const transport = makeTransport();
    const sendAgentMessage = vi.fn().mockResolvedValue(undefined);
    const bridge = new WearBridge({
      transport,
      readState: baseState,
      getClient: () => ({ sendAgentMessage }) as never,
      resolveNewAgentConfig: () => null,
      now: () => NOW,
    });
    await bridge.start();

    transport.emit(
      JSON.stringify({
        v: 1,
        kind: "sendPrompt",
        serverId: "srv-1",
        agentId: "a-1",
        text: "rerun tests",
      }),
    );
    await vi.waitFor(() => expect(sendAgentMessage).toHaveBeenCalledWith("a-1", "rerun tests"));
    bridge.stop();
  });

  it("drops commands for a server that is not connected instead of throwing", async () => {
    const transport = makeTransport();
    const warn = vi.fn();
    const bridge = new WearBridge({
      transport,
      readState: baseState,
      getClient: () => null,
      resolveNewAgentConfig: () => null,
      now: () => NOW,
      logger: { warn },
    });
    await bridge.start();

    await expect(
      bridge.execute({ kind: "stopAgent", serverId: "gone", agentId: "a-1" }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    bridge.stop();
  });

  it("survives a daemon call that rejects", async () => {
    const transport = makeTransport();
    const warn = vi.fn();
    const bridge = new WearBridge({
      transport,
      readState: baseState,
      getClient: () => ({ cancelAgent: vi.fn().mockRejectedValue(new Error("boom")) }) as never,
      resolveNewAgentConfig: () => null,
      now: () => NOW,
      logger: { warn },
    });
    await bridge.start();

    await expect(
      bridge.execute({ kind: "stopAgent", serverId: "srv-1", agentId: "a-1" }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    bridge.stop();
  });

  it("drains commands queued while the app process was dead, before first publish", async () => {
    const sendAgentMessage = vi.fn().mockResolvedValue(undefined);
    const transport = makeTransport();
    transport.drainPendingCommands = async () => [
      JSON.stringify({
        v: 1,
        kind: "sendPrompt",
        serverId: "srv-1",
        agentId: "a-1",
        text: "queued",
      }),
    ];

    const bridge = new WearBridge({
      transport,
      readState: baseState,
      getClient: () => ({ sendAgentMessage }) as never,
      resolveNewAgentConfig: () => null,
      now: () => NOW,
    });

    await bridge.start();
    expect(sendAgentMessage).toHaveBeenCalledWith("a-1", "queued");
    bridge.stop();
  });

  it("answers a refresh request with a forced republish", async () => {
    const transport = makeTransport();
    const bridge = new WearBridge({
      transport,
      readState: baseState,
      getClient: () => null,
      resolveNewAgentConfig: () => null,
      now: () => NOW,
    });
    await bridge.start();
    expect(transport.published).toHaveLength(1);

    await bridge.execute({ kind: "refresh" });
    // Forced, so it republishes even though nothing changed.
    expect(transport.published).toHaveLength(2);
    bridge.stop();
  });

  it("creates an agent using the provider the phone resolved", async () => {
    const transport = makeTransport();
    const createAgent = vi.fn().mockResolvedValue({});
    const bridge = new WearBridge({
      transport,
      readState: baseState,
      getClient: () => ({ createAgent }) as never,
      resolveNewAgentConfig: () => ({ provider: "claude", cwd: "/home/dev/paseo" }),
      now: () => NOW,
    });
    await bridge.start();

    await bridge.execute({
      kind: "createAgent",
      serverId: "srv-1",
      workspaceId: "ws-1",
      text: "fix the flaky test",
    });

    expect(createAgent).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      provider: "claude",
      cwd: "/home/dev/paseo",
      initialPrompt: "fix the flaky test",
    });
    bridge.stop();
  });

  it("refuses to create an agent when no provider can be resolved", async () => {
    const transport = makeTransport();
    const createAgent = vi.fn();
    const warn = vi.fn();
    const bridge = new WearBridge({
      transport,
      readState: baseState,
      getClient: () => ({ createAgent }) as never,
      resolveNewAgentConfig: () => null,
      now: () => NOW,
      logger: { warn },
    });
    await bridge.start();

    await bridge.execute({
      kind: "createAgent",
      serverId: "srv-1",
      workspaceId: "ws-1",
      text: "anything",
    });

    expect(createAgent).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    bridge.stop();
  });
});

interface PageOptions {
  hasOlder?: boolean;
  seq?: number;
  epoch?: string;
  reset?: boolean;
  staleCursor?: boolean;
}

/** A daemon timeline page, shaped loosely — only the fields the bridge reads. */
function itemsPage(items: unknown[], options: PageOptions = {}) {
  const seq = options.seq ?? 1;
  const epoch = options.epoch ?? "e1";
  return {
    entries: items.map((item) => ({ item })),
    startCursor: { epoch, seq },
    endCursor: { epoch, seq: seq + items.length },
    epoch,
    reset: options.reset ?? false,
    staleCursor: options.staleCursor ?? false,
    hasOlder: options.hasOlder ?? false,
    hasNewer: false,
  };
}

function timelinePage(texts: string[], options: PageOptions = {}) {
  return itemsPage(
    texts.map((text) => ({ type: "user_message", text })),
    options,
  );
}

/** A full page of distinctly labelled entries, so page ordering shows in the result. */
function pageTexts(page: number): string[] {
  return Array.from({ length: 40 }, (_, index) => `page${page}-${index}`);
}

/**
 * A full page carrying only five visible entries; the rest is reasoning, which the
 * projection drops. Counting raw entries would badly overcount such a page.
 */
function reasoningHeavyPage(page: number) {
  const items = Array.from({ length: 40 }, (_, index) =>
    index < 5
      ? { type: "user_message", text: `page${page}-${index}` }
      : { type: "reasoning", text: "thinking" },
  );
  return itemsPage(items, { hasOlder: true, seq: 100 - page });
}

type PageResolver = (page: unknown) => void;

/** A fetch the test completes by hand, so two requests can be interleaved. */
function deferredPage(resolvers: PageResolver[]): Promise<unknown> {
  return new Promise<unknown>((resolve) => {
    resolvers.push(resolve);
  });
}

describe("WearBridge transcript requests", () => {
  const baseState = () => [
    { serverId: "srv-1", agents: [agent()], workspaces: workspaceMap(workspace()) },
  ];

  function makeBridge(
    fetchAgentTimeline: ReturnType<typeof vi.fn> | null,
    warn = vi.fn(),
  ): { bridge: WearBridge; transport: ReturnType<typeof makeTransport>; warn: typeof warn } {
    const transport = makeTransport();
    const bridge = new WearBridge({
      transport,
      readState: baseState,
      getClient: () => (fetchAgentTimeline ? ({ fetchAgentTimeline } as never) : null),
      resolveNewAgentConfig: () => null,
      now: () => NOW,
      logger: { warn },
    });
    return { bridge, transport, warn };
  }

  const request = { kind: "requestTranscript", serverId: "srv-1", agentId: "a-1" } as const;

  it("fetches the tail page and publishes the projected transcript", async () => {
    const fetchAgentTimeline = vi.fn().mockResolvedValue(timelinePage(["Fix the tests"]));
    const { bridge, transport } = makeBridge(fetchAgentTimeline);
    await bridge.start();

    await bridge.execute(request);

    // No cursor and no direction: that is what asks for the latest tail page.
    expect(fetchAgentTimeline).toHaveBeenCalledTimes(1);
    expect(fetchAgentTimeline).toHaveBeenCalledWith("a-1", { projection: "projected", limit: 40 });

    expect(transport.transcripts).toHaveLength(1);
    expect(transport.transcripts[0].agentId).toBe("a-1");
    expect(JSON.parse(transport.transcripts[0].payload)).toEqual({
      v: WEAR_PROTOCOL_VERSION,
      agentId: "a-1",
      serverId: "srv-1",
      updatedAt: NOW,
      entries: [{ kind: "user", text: "Fix the tests" }],
      truncated: false,
    });
    bridge.stop();
  });

  it("does not republish the snapshot", async () => {
    const fetchAgentTimeline = vi.fn().mockResolvedValue(timelinePage(["hi"]));
    const { bridge, transport } = makeBridge(fetchAgentTimeline);
    await bridge.start();
    expect(transport.published).toHaveLength(1);

    await bridge.execute(request);

    // Reading a transcript changes nothing about the agent, so the forced republish
    // that every other command does would be pure Data Layer traffic.
    expect(transport.published).toHaveLength(1);
    bridge.stop();
  });

  it("pages backwards until it has enough entries, oldest page first", async () => {
    let call = 0;
    const fetchAgentTimeline = vi.fn().mockImplementation(async () => {
      call += 1;
      return timelinePage(pageTexts(call), { hasOlder: true, seq: 100 - call });
    });
    const { bridge, transport } = makeBridge(fetchAgentTimeline);
    await bridge.start();

    await bridge.execute(request);

    // 40 + 40 + 40 clears the 100-entry target, so it stops without a fourth request.
    expect(fetchAgentTimeline).toHaveBeenCalledTimes(3);
    expect(fetchAgentTimeline).toHaveBeenNthCalledWith(2, "a-1", {
      projection: "projected",
      direction: "before",
      cursor: { epoch: "e1", seq: 99 },
      limit: 40,
    });

    const transcript = JSON.parse(transport.transcripts[0].payload);
    expect(transcript.entries).toHaveLength(100);
    // Oldest page leads, newest entry is last, and the 20 oldest were trimmed.
    expect(transcript.entries[0].text).toBe("page3-20");
    expect(transcript.entries.at(-1).text).toBe("page1-39");
    expect(transcript.truncated).toBe(true);
    bridge.stop();
  });

  it("stops at the request cap when the daemon returns small pages", async () => {
    const fetchAgentTimeline = vi
      .fn()
      .mockImplementation(async () => timelinePage(["a", "b", "c"], { hasOlder: true, seq: 5 }));
    const { bridge, transport } = makeBridge(fetchAgentTimeline);
    await bridge.start();

    await bridge.execute(request);

    // An agent with a long history must not turn into an unbounded walk backwards.
    expect(fetchAgentTimeline).toHaveBeenCalledTimes(4);
    expect(JSON.parse(transport.transcripts[0].payload).truncated).toBe(true);
    bridge.stop();
  });

  it("stops as soon as the daemon reports no older history", async () => {
    const fetchAgentTimeline = vi
      .fn()
      .mockResolvedValue(timelinePage(["only"], { hasOlder: false }));
    const { bridge, transport } = makeBridge(fetchAgentTimeline);
    await bridge.start();

    await bridge.execute(request);

    expect(fetchAgentTimeline).toHaveBeenCalledTimes(1);
    expect(JSON.parse(transport.transcripts[0].payload).truncated).toBe(false);
    bridge.stop();
  });

  it("drops the request when that server is not connected", async () => {
    const { bridge, transport, warn } = makeBridge(null);
    await bridge.start();

    await expect(bridge.execute(request)).resolves.toBeUndefined();

    expect(transport.transcripts).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    bridge.stop();
  });

  it("publishes nothing when the fetch fails", async () => {
    const fetchAgentTimeline = vi.fn().mockRejectedValue(new Error("timeline unavailable"));
    const { bridge, transport, warn } = makeBridge(fetchAgentTimeline);
    await bridge.start();

    await expect(bridge.execute(request)).resolves.toBeUndefined();

    // An empty transcript would read as "this agent has said nothing"; leaving the
    // watch on its loading state is the honest outcome.
    expect(transport.transcripts).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    bridge.stop();
  });

  it("budgets paging in visible entries, not raw daemon entries", async () => {
    let call = 0;
    const fetchAgentTimeline = vi.fn().mockImplementation(async () => {
      call += 1;
      return reasoningHeavyPage(call);
    });
    const { bridge, transport } = makeBridge(fetchAgentTimeline);
    await bridge.start();

    await bridge.execute(request);

    // 40 raw entries a page would have stopped this at three requests, with just 15
    // lines to show. Only five entries a page survive projection, so the walk keeps
    // spending the budget it has.
    expect(fetchAgentTimeline).toHaveBeenCalledTimes(4);
    expect(JSON.parse(transport.transcripts[0].payload).entries).toHaveLength(20);
    bridge.stop();
  });

  it("stops paging when the timeline epoch changes mid-walk", async () => {
    let call = 0;
    const fetchAgentTimeline = vi.fn().mockImplementation(async () => {
      call += 1;
      return call === 1
        ? timelinePage(["kept one", "kept two"], { hasOlder: true, seq: 99, epoch: "e1" })
        : timelinePage(["from a rewound timeline"], { hasOlder: true, seq: 40, epoch: "e2" });
    });
    const { bridge, transport } = makeBridge(fetchAgentTimeline);
    await bridge.start();

    await bridge.execute(request);

    // It asks once more, sees a different epoch, and keeps the consistent prefix
    // rather than splicing two histories into one duplicated conversation.
    expect(fetchAgentTimeline).toHaveBeenCalledTimes(2);
    const transcript = JSON.parse(transport.transcripts[0].payload);
    expect(transcript.entries.map((entry: { text: string }) => entry.text)).toEqual([
      "kept one",
      "kept two",
    ]);
    bridge.stop();
  });

  it("discards a page the daemon flagged as a stale-cursor reset", async () => {
    let call = 0;
    const fetchAgentTimeline = vi.fn().mockImplementation(async () => {
      call += 1;
      return call === 1
        ? timelinePage(["kept"], { hasOlder: true, seq: 99 })
        : timelinePage(["refetched tail"], { hasOlder: true, seq: 40, staleCursor: true });
    });
    const { bridge, transport } = makeBridge(fetchAgentTimeline);
    await bridge.start();

    await bridge.execute(request);

    expect(fetchAgentTimeline).toHaveBeenCalledTimes(2);
    const transcript = JSON.parse(transport.transcripts[0].payload);
    expect(transcript.entries.map((entry: { text: string }) => entry.text)).toEqual(["kept"]);
    bridge.stop();
  });

  it("skips a stale publish when a newer request for the same agent already landed", async () => {
    const resolvers: PageResolver[] = [];
    const fetchAgentTimeline = vi.fn().mockImplementation(() => deferredPage(resolvers));
    const { bridge, transport } = makeBridge(fetchAgentTimeline);
    await bridge.start();

    const older = bridge.execute(request);
    const newer = bridge.execute(request);
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));

    // The newer request wins the race...
    resolvers[1](timelinePage(["newer"]));
    await newer;
    // ...so the older one, finishing late, must not overwrite it.
    resolvers[0](timelinePage(["older"]));
    await older;

    expect(transport.transcripts).toHaveLength(1);
    expect(JSON.parse(transport.transcripts[0].payload).entries[0].text).toBe("newer");
    bridge.stop();
  });

  it("still publishes a later request for the same agent", async () => {
    const fetchAgentTimeline = vi.fn().mockResolvedValue(timelinePage(["hi"]));
    const { bridge, transport } = makeBridge(fetchAgentTimeline);
    await bridge.start();

    // The generation guard must only suppress out-of-order results, not sequential
    // re-requests of the same agent.
    await bridge.execute(request);
    await bridge.execute(request);

    expect(transport.transcripts).toHaveLength(2);
    bridge.stop();
  });

  it("handles a transcript request delivered over the native command listener", async () => {
    const fetchAgentTimeline = vi.fn().mockResolvedValue(timelinePage(["from the watch"]));
    const { bridge, transport } = makeBridge(fetchAgentTimeline);
    await bridge.start();

    transport.emit(
      JSON.stringify({ v: 1, kind: "requestTranscript", serverId: "srv-1", agentId: "a-1" }),
    );

    await vi.waitFor(() => expect(transport.transcripts).toHaveLength(1));
    bridge.stop();
  });
});

const LEASE_MS = 150_000;
const COALESCE_MS = 2_000;

describe("WearBridge live transcript updates", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const request = { kind: "requestTranscript", serverId: "srv-1", agentId: "a-1" } as const;

  function makeLiveBridge() {
    const transport = makeTransport();
    const clock = { now: NOW };
    const state = { agents: [agent({ lastActivityAt: new Date(NOW - 720_000) })] };
    const fetchAgentTimeline = vi.fn().mockResolvedValue(timelinePage(["hello"]));

    const bridge = new WearBridge({
      transport,
      readState: () => [
        { serverId: "srv-1", agents: state.agents, workspaces: workspaceMap(workspace()) },
      ],
      getClient: () => ({ fetchAgentTimeline }) as never,
      resolveNewAgentConfig: () => null,
      now: () => clock.now,
      logger: { warn: vi.fn() },
    });

    /** Simulate the agent doing something, the way the store would report it. */
    const moveActivity = (offsetMs: number) => {
      state.agents = [agent({ lastActivityAt: new Date(clock.now + offsetMs) })];
    };

    /** A store change plus the coalescing window that follows it. */
    const settle = async () => {
      await bridge.publish();
      await vi.advanceTimersByTimeAsync(COALESCE_MS);
    };

    return { bridge, transport, clock, state, fetchAgentTimeline, moveActivity, settle };
  }

  it("republishes the transcript when a leased agent shows new activity", async () => {
    const live = makeLiveBridge();
    await live.bridge.start();
    await live.bridge.execute(request);
    expect(live.transport.transcripts).toHaveLength(1);

    live.moveActivity(0);
    await live.settle();

    // Without the lease this update would wait for the watch's own ~60s re-request.
    expect(live.transport.transcripts).toHaveLength(2);
    live.bridge.stop();
  });

  it("coalesces a burst of store changes into one republish", async () => {
    const live = makeLiveBridge();
    await live.bridge.start();
    await live.bridge.execute(request);

    // One agent turn produces many store notifications; each must not become a
    // separate timeline walk.
    live.moveActivity(0);
    await live.bridge.publish();
    live.moveActivity(1);
    await live.bridge.publish();
    live.moveActivity(2);
    await live.bridge.publish();
    await vi.advanceTimersByTimeAsync(COALESCE_MS);

    expect(live.transport.transcripts).toHaveLength(2);
    live.bridge.stop();
  });

  it("republishes again for activity that lands after a refresh", async () => {
    const live = makeLiveBridge();
    await live.bridge.start();
    await live.bridge.execute(request);

    live.moveActivity(0);
    await live.settle();
    live.moveActivity(1);
    await live.settle();

    expect(live.transport.transcripts).toHaveLength(3);
    live.bridge.stop();
  });

  it("stays quiet when a store change carries no new agent activity", async () => {
    const live = makeLiveBridge();
    await live.bridge.start();
    await live.bridge.execute(request);

    // Something unrelated changed — a workspace rename, another server's agents.
    await live.settle();

    expect(live.transport.transcripts).toHaveLength(1);
    live.bridge.stop();
  });

  it("stops pushing once the lease has lapsed", async () => {
    const live = makeLiveBridge();
    await live.bridge.start();
    await live.bridge.execute(request);

    // The watch screen was closed, so no re-request ever renewed the lease.
    live.clock.now += LEASE_MS + 1;
    live.moveActivity(0);
    await live.settle();

    expect(live.transport.transcripts).toHaveLength(1);
    live.bridge.stop();
  });

  it("keeps pushing while the watch keeps renewing the lease", async () => {
    const live = makeLiveBridge();
    await live.bridge.start();
    await live.bridge.execute(request);

    // The watch re-requests roughly once a minute while the screen is open.
    live.clock.now += 100_000;
    await live.bridge.execute(request);
    expect(live.transport.transcripts).toHaveLength(2);

    // Past the original expiry, inside the renewed one.
    live.clock.now += 100_000;
    live.moveActivity(0);
    await live.settle();

    expect(live.transport.transcripts).toHaveLength(3);
    live.bridge.stop();
  });

  it("drops the lease when the agent disappears from state", async () => {
    const live = makeLiveBridge();
    await live.bridge.start();
    await live.bridge.execute(request);

    // Archived, or its server disconnected.
    live.state.agents = [];
    await live.settle();
    expect(live.transport.transcripts).toHaveLength(1);

    // The lease is gone, so the agent coming back does not resume pushing on its own.
    live.moveActivity(0);
    await live.settle();
    expect(live.transport.transcripts).toHaveLength(1);
    live.bridge.stop();
  });

  it("cancels a pending refresh on stop", async () => {
    const live = makeLiveBridge();
    await live.bridge.start();
    await live.bridge.execute(request);

    live.moveActivity(0);
    await live.bridge.publish();
    live.bridge.stop();
    await vi.advanceTimersByTimeAsync(COALESCE_MS * 2);

    // No timer may fire into a disposed bridge.
    expect(live.transport.transcripts).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("takes no lease from a snapshot refresh, only from a transcript request", async () => {
    const live = makeLiveBridge();
    await live.bridge.start();

    live.moveActivity(0);
    await live.settle();

    // Nothing is reading this agent's transcript, so nothing should be fetched.
    expect(live.transport.transcripts).toHaveLength(0);
    expect(live.fetchAgentTimeline).not.toHaveBeenCalled();
    live.bridge.stop();
  });

  it("keeps independent leases for the same agent id on two servers", async () => {
    // Agent ids are only unique within a server. Keyed by id alone, the second
    // request would overwrite the first server's lease and cancel its timer.
    const transport = makeTransport();
    const clock = { now: NOW };
    const state = {
      one: [agent({ lastActivityAt: new Date(NOW - 720_000) })],
      two: [agent({ serverId: "srv-2", lastActivityAt: new Date(NOW - 720_000) })],
    };
    const fetchOne = vi.fn().mockResolvedValue(timelinePage(["from one"]));
    const fetchTwo = vi.fn().mockResolvedValue(timelinePage(["from two"]));

    const bridge = new WearBridge({
      transport,
      readState: () => [
        { serverId: "srv-1", agents: state.one, workspaces: workspaceMap(workspace()) },
        { serverId: "srv-2", agents: state.two, workspaces: workspaceMap(workspace()) },
      ],
      getClient: (serverId) =>
        ({ fetchAgentTimeline: serverId === "srv-1" ? fetchOne : fetchTwo }) as never,
      resolveNewAgentConfig: () => null,
      now: () => clock.now,
      logger: { warn: vi.fn() },
    });
    await bridge.start();

    await bridge.execute({ kind: "requestTranscript", serverId: "srv-1", agentId: "a-1" });
    await bridge.execute({ kind: "requestTranscript", serverId: "srv-2", agentId: "a-1" });
    expect(transport.transcripts).toHaveLength(2);

    // Activity on each server must refresh through that server's own client.
    state.one = [agent({ lastActivityAt: new Date(clock.now) })];
    await bridge.publish();
    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    expect(fetchOne).toHaveBeenCalledTimes(2);
    expect(fetchTwo).toHaveBeenCalledTimes(1);

    state.two = [agent({ serverId: "srv-2", lastActivityAt: new Date(clock.now) })];
    await bridge.publish();
    await vi.advanceTimersByTimeAsync(COALESCE_MS);
    expect(fetchTwo).toHaveBeenCalledTimes(2);
    expect(transport.transcripts).toHaveLength(4);
    bridge.stop();
  });

  it("does not publish a refresh that fires after the lease expired", async () => {
    const live = makeLiveBridge();
    await live.bridge.start();
    await live.bridge.execute(request);

    // Activity lands just inside the lease, so the coalescing timer is scheduled —
    // but by the time it fires, the lease is past its expiry.
    live.clock.now += LEASE_MS - 1_000;
    live.moveActivity(0);
    await live.bridge.publish();
    live.clock.now += COALESCE_MS;
    await vi.advanceTimersByTimeAsync(COALESCE_MS);

    expect(live.transport.transcripts).toHaveLength(1);
    live.bridge.stop();
  });

  it("does not publish a fetch that was in flight when the bridge stopped", async () => {
    // stop() has no timer left to cancel once the fetch has started; without the
    // disposed recheck the stale instance would publish over its replacement.
    const resolvers: PageResolver[] = [];
    const transport = makeTransport();
    const bridge = new WearBridge({
      transport,
      readState: () => [
        { serverId: "srv-1", agents: [agent()], workspaces: workspaceMap(workspace()) },
      ],
      getClient: () => ({ fetchAgentTimeline: () => deferredPage(resolvers) }) as never,
      resolveNewAgentConfig: () => null,
      now: () => NOW,
      logger: { warn: vi.fn() },
    });
    await bridge.start();

    const inFlight = bridge.execute(request);
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    bridge.stop();
    resolvers[0]?.(timelinePage(["too late"]));
    await inFlight;

    expect(transport.transcripts).toHaveLength(0);
  });
});

describe("WearBridge project icons", () => {
  /**
   * Icon sync is deliberately not awaited by publish(), so tests have to let the
   * fetch/publish chain drain. A handful of microtask turns covers it: every step is
   * a resolved promise, nothing here is on a timer.
   */
  async function flushIconSync(): Promise<void> {
    // A macrotask rather than a fixed number of microtask turns: everything the sync
    // awaits is an already-resolved promise, so the whole chain drains before a
    // setTimeout(0) fires however many hops long it happens to be.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  function iconClient(icon: { data: string; mimeType: string } | null) {
    return vi.fn().mockResolvedValue({ cwd: "", icon, error: null, requestId: "r" });
  }

  const PNG = { data: "aWNvbi1ieXRlcw==", mimeType: "image/png" };

  it("fetches an icon once and publishes it under the snapshot's projectKey", async () => {
    const transport = makeTransport();
    const requestProjectIcon = iconClient(PNG);
    const bridge = new WearBridge({
      transport,
      readState: () => [
        { serverId: "srv-1", agents: [agent()], workspaces: workspaceMap(workspace()) },
      ],
      getClient: () => ({ requestProjectIcon }) as never,
      resolveNewAgentConfig: () => null,
      now: () => NOW,
      logger: { warn: vi.fn() },
    });

    await bridge.start();
    await flushIconSync();

    // The project root, not the worktree: that is the directory the phone sidebar
    // scans, so both halves resolve the same file.
    expect(requestProjectIcon).toHaveBeenCalledExactlyOnceWith("/home/dev/paseo");
    expect(transport.icons).toEqual([
      { projectKey: "github.com/getpaseo/paseo", data: PNG.data, mimeType: PNG.mimeType },
    ]);
    bridge.stop();
  });

  it("does not republish an unchanged icon on a later snapshot", async () => {
    const transport = makeTransport();
    const requestProjectIcon = iconClient(PNG);
    let status: Agent["status"] = "running";
    const bridge = new WearBridge({
      transport,
      readState: () => [
        { serverId: "srv-1", agents: [agent({ status })], workspaces: workspaceMap(workspace()) },
      ],
      getClient: () => ({ requestProjectIcon }) as never,
      resolveNewAgentConfig: () => null,
      now: () => NOW,
      logger: { warn: vi.fn() },
    });

    await bridge.start();
    await flushIconSync();

    status = "idle";
    await bridge.publish();
    await flushIconSync();

    expect(transport.published).toHaveLength(2);
    expect(requestProjectIcon).toHaveBeenCalledOnce();
    expect(transport.icons).toHaveLength(1);
    bridge.stop();
  });

  it("caches a null icon so a repo without one is asked about once", async () => {
    const transport = makeTransport();
    const requestProjectIcon = iconClient(null);
    let status: Agent["status"] = "running";
    const bridge = new WearBridge({
      transport,
      readState: () => [
        { serverId: "srv-1", agents: [agent({ status })], workspaces: workspaceMap(workspace()) },
      ],
      getClient: () => ({ requestProjectIcon }) as never,
      resolveNewAgentConfig: () => null,
      now: () => NOW,
      logger: { warn: vi.fn() },
    });

    await bridge.start();
    await flushIconSync();
    status = "idle";
    await bridge.publish();
    await flushIconSync();

    expect(requestProjectIcon).toHaveBeenCalledOnce();
    expect(transport.icons).toHaveLength(0);
    bridge.stop();
  });

  it("fetches per project and routes each to its own server", async () => {
    const transport = makeTransport();
    const first = iconClient(PNG);
    const second = iconClient({ data: "b3RoZXI=", mimeType: "image/svg+xml" });
    const bridge = new WearBridge({
      transport,
      readState: () => [
        { serverId: "srv-1", agents: [], workspaces: workspaceMap(workspace()) },
        {
          serverId: "srv-2",
          agents: [],
          workspaces: workspaceMap(
            workspace({
              id: "ws-2",
              name: "other",
              projectRootPath: "/srv/other",
              project: {
                projectKey: "github.com/getpaseo/other",
                projectName: "other",
                workspaceName: "other",
                checkout: {} as NonNullable<WorkspaceDescriptor["project"]>["checkout"],
              },
            }),
          ),
        },
      ],
      getClient: (serverId) =>
        ({ requestProjectIcon: serverId === "srv-1" ? first : second }) as never,
      resolveNewAgentConfig: () => null,
      now: () => NOW,
      logger: { warn: vi.fn() },
    });

    await bridge.start();
    await flushIconSync();

    expect(first).toHaveBeenCalledExactlyOnceWith("/home/dev/paseo");
    expect(second).toHaveBeenCalledExactlyOnceWith("/srv/other");
    expect(transport.icons.map((entry) => entry.projectKey)).toEqual([
      "github.com/getpaseo/paseo",
      "github.com/getpaseo/other",
    ]);
    bridge.stop();
  });

  it("asks once per project no matter how many workspaces it has", async () => {
    const transport = makeTransport();
    const requestProjectIcon = iconClient(PNG);
    const bridge = new WearBridge({
      transport,
      readState: () => [
        {
          serverId: "srv-1",
          agents: [],
          // Two worktrees of the same repo: one icon, one lookup.
          workspaces: workspaceMap(workspace(), workspace({ id: "ws-2", name: "second" })),
        },
      ],
      getClient: () => ({ requestProjectIcon }) as never,
      resolveNewAgentConfig: () => null,
      now: () => NOW,
      logger: { warn: vi.fn() },
    });

    await bridge.start();
    await flushIconSync();

    expect(requestProjectIcon).toHaveBeenCalledOnce();
    expect(transport.icons).toHaveLength(1);
    bridge.stop();
  });

  it("survives a failed fetch and retries it on the next sync", async () => {
    const transport = makeTransport();
    const warn = vi.fn();
    const requestProjectIcon = vi
      .fn()
      .mockRejectedValueOnce(new Error("daemon busy"))
      .mockResolvedValue({ cwd: "", icon: PNG, error: null, requestId: "r" });
    let status: Agent["status"] = "running";
    const bridge = new WearBridge({
      transport,
      readState: () => [
        { serverId: "srv-1", agents: [agent({ status })], workspaces: workspaceMap(workspace()) },
      ],
      getClient: () => ({ requestProjectIcon }) as never,
      resolveNewAgentConfig: () => null,
      now: () => NOW,
      logger: { warn },
    });

    // The failure must not surface as a rejected publish(): icons are decoration and
    // the snapshot is the thing that matters.
    await expect(bridge.start()).resolves.toBeUndefined();
    await flushIconSync();
    expect(transport.published).toHaveLength(1);
    expect(transport.icons).toHaveLength(0);
    expect(warn).toHaveBeenCalled();

    status = "idle";
    await bridge.publish();
    await flushIconSync();

    expect(requestProjectIcon).toHaveBeenCalledTimes(2);
    expect(transport.icons).toHaveLength(1);
    bridge.stop();
  });

  it("skips icons entirely while no daemon client is available", async () => {
    const transport = makeTransport();
    const bridge = new WearBridge({
      transport,
      readState: () => [
        { serverId: "srv-1", agents: [agent()], workspaces: workspaceMap(workspace()) },
      ],
      getClient: () => null,
      resolveNewAgentConfig: () => null,
      now: () => NOW,
      logger: { warn: vi.fn() },
    });

    await bridge.start();
    await flushIconSync();

    expect(transport.icons).toHaveLength(0);
    bridge.stop();
  });
});

const LIVE_VOICE_COALESCE_MS = 700;

describe("WearBridge live voice", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const AVAILABLE: LiveVoiceAvailability = {
    kind: "available",
    hosts: [
      {
        serverId: "srv-1",
        label: "workstation",
        connectionStatus: "online",
        version: "0.2.5",
        supportsLiveVoice: true,
      },
    ],
  };

  const IDLE_SNAPSHOT: LiveVoiceSnapshot = {
    phase: "idle",
    serverId: null,
    liveSessionId: null,
    sessionMode: null,
    isMuted: false,
    isAudioBlocked: false,
    transcripts: [],
    error: null,
    closedCause: null,
  };

  function makeLiveVoiceBridge() {
    const transport = makeTransport();
    const listeners = new Set<() => void>();
    let snapshot = IDLE_SNAPSHOT;

    const calls = {
      start: vi.fn(async (_serverId: string) => {}),
      stop: vi.fn(async () => {}),
      toggleMute: vi.fn(),
    };

    /** Move the runtime the way a real call would, then notify subscribers. */
    const emit = (next: Partial<LiveVoiceSnapshot>) => {
      snapshot = { ...snapshot, ...next };
      for (const listener of listeners) listener();
    };

    const liveVoice: WearLiveVoiceController = {
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      getSnapshot: () => snapshot,
      readAvailability: () => AVAILABLE,
      start: calls.start,
      stop: calls.stop,
      toggleMute: calls.toggleMute,
    };

    const bridge = new WearBridge({
      transport,
      readState: () => [
        { serverId: "srv-1", agents: [agent()], workspaces: workspaceMap(workspace()) },
      ],
      getClient: () => null,
      resolveNewAgentConfig: () => null,
      liveVoice,
      now: () => NOW,
      logger: { warn: vi.fn() },
    });

    const last = () => JSON.parse(transport.liveVoice.at(-1) ?? "null");

    return { bridge, transport, emit, calls, last };
  }

  it("publishes the current state on start, so a call already up is on the wrist", async () => {
    const { bridge, transport, last } = makeLiveVoiceBridge();
    await bridge.start();

    expect(transport.liveVoice).toHaveLength(1);
    expect(last()).toMatchObject({ phase: "idle", hosts: [{ serverId: "srv-1" }] });
    bridge.stop();
  });

  it("publishes a phase change immediately", async () => {
    const { bridge, transport, emit, last } = makeLiveVoiceBridge();
    await bridge.start();

    emit({ phase: "active", serverId: "srv-1", liveSessionId: "live-1" });
    await vi.advanceTimersByTimeAsync(0);

    expect(transport.liveVoice).toHaveLength(2);
    expect(last()).toMatchObject({ phase: "active", hostLabel: "workstation" });
    bridge.stop();
  });

  it("coalesces a burst of transcript deltas into one publish", async () => {
    const { bridge, transport, emit } = makeLiveVoiceBridge();
    await bridge.start();

    emit({ phase: "active", serverId: "srv-1", liveSessionId: "live-1" });
    await vi.advanceTimersByTimeAsync(0);
    const afterPhase = transport.liveVoice.length;

    // A call emits deltas several times a second; each one must not be a Data
    // Layer write over Bluetooth.
    for (let index = 0; index < 6; index += 1) {
      emit({ transcripts: [{ id: "t1", role: "assistant", text: `word ${index}` }] });
      await vi.advanceTimersByTimeAsync(50);
    }

    expect(transport.liveVoice).toHaveLength(afterPhase);
    await vi.advanceTimersByTimeAsync(LIVE_VOICE_COALESCE_MS);
    expect(transport.liveVoice).toHaveLength(afterPhase + 1);
    bridge.stop();
  });

  it("lets a mute land immediately even while transcripts are coalescing", async () => {
    const { bridge, transport, emit, last } = makeLiveVoiceBridge();
    await bridge.start();
    emit({ phase: "active", serverId: "srv-1", liveSessionId: "live-1" });
    await vi.advanceTimersByTimeAsync(0);
    const afterPhase = transport.liveVoice.length;

    emit({ transcripts: [{ id: "t1", role: "assistant", text: "still talking" }] });
    await vi.advanceTimersByTimeAsync(50);
    expect(transport.liveVoice).toHaveLength(afterPhase);

    // Mute moves a control, so it must not wait behind the words.
    emit({ isMuted: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.liveVoice).toHaveLength(afterPhase + 1);
    expect(last()).toMatchObject({ isMuted: true });
    bridge.stop();
  });

  it("does not republish an unchanged state", async () => {
    const { bridge, transport, emit } = makeLiveVoiceBridge();
    await bridge.start();
    const initial = transport.liveVoice.length;

    emit({});
    await vi.advanceTimersByTimeAsync(LIVE_VOICE_COALESCE_MS);

    expect(transport.liveVoice).toHaveLength(initial);
    bridge.stop();
  });

  it("runs the three commands and publishes the result", async () => {
    const { bridge, transport, calls } = makeLiveVoiceBridge();
    await bridge.start();

    transport.emit(JSON.stringify({ v: 1, kind: "startLiveVoice", serverId: "srv-1" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.start).toHaveBeenCalledWith("srv-1");

    transport.emit(JSON.stringify({ v: 1, kind: "toggleLiveVoiceMute" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.toggleMute).toHaveBeenCalled();

    transport.emit(JSON.stringify({ v: 1, kind: "stopLiveVoice" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.stop).toHaveBeenCalled();
    bridge.stop();
  });

  it("keeps publishing after a start the runtime refuses", async () => {
    const { bridge, transport, emit, calls, last } = makeLiveVoiceBridge();
    await bridge.start();

    // The runtime records the failure in its own snapshot and rethrows; the
    // wrist needs the error on screen, not a spinner.
    calls.start.mockImplementationOnce(async () => {
      emit({ phase: "error", serverId: "srv-1", error: { code: "mic_busy", message: null } });
      throw new Error("mic_busy");
    });

    transport.emit(JSON.stringify({ v: 1, kind: "startLiveVoice", serverId: "srv-1" }));
    await vi.advanceTimersByTimeAsync(0);

    expect(last()).toMatchObject({ phase: "error", errorCode: "mic_busy" });
    bridge.stop();
  });

  it("publishes nothing at all when the app has no live voice runtime", async () => {
    const transport = makeTransport();
    const bridge = new WearBridge({
      transport,
      readState: () => [
        { serverId: "srv-1", agents: [agent()], workspaces: workspaceMap(workspace()) },
      ],
      getClient: () => null,
      resolveNewAgentConfig: () => null,
      now: () => NOW,
      logger: { warn: vi.fn() },
    });

    await bridge.start();
    transport.emit(JSON.stringify({ v: 1, kind: "startLiveVoice", serverId: "srv-1" }));
    await vi.advanceTimersByTimeAsync(0);

    // An absent item is how the watch reads "this phone build has no Live Voice".
    expect(transport.liveVoice).toHaveLength(0);
    bridge.stop();
  });
});
