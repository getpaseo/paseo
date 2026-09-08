import { describe, expect, it, vi } from "vitest";
import pino from "pino";
import {
  ProviderCatalogSession,
  type ProviderCatalogSessionHost,
} from "./provider-catalog-session.js";
import { createStub } from "../../test-utils/class-mocks.js";
import { createProviderSnapshot, findByType } from "../../test-utils/session-stubs.js";
import type { SessionOutboundMessage } from "../../messages.js";
import {
  GLOBAL_PROVIDER_SNAPSHOT_KEY,
  type ProviderSnapshotManager,
  type ProviderSnapshot,
  type ProviderSnapshotTransition,
} from "../../agent/provider-snapshot-manager.js";
import type { ProviderSnapshotEntry } from "../../agent/agent-sdk-types.js";
import { ProviderUsageService } from "../../../services/quota-fetcher/service.js";
import { expandProviderSnapshot } from "@getpaseo/protocol/provider-snapshot-codec";

type SnapshotChangeHandler = (transition: ProviderSnapshotTransition) => void;

interface MakeOptions {
  visibleProviders?: Set<string>;
  supportsCustomModeIcons?: boolean;
  supportsCompactProviderSnapshots?: boolean;
  snapshot?: Partial<ProviderSnapshotManager>;
  usage?: { [K in keyof ProviderUsageService]?: unknown };
  host?: Partial<ProviderCatalogSessionHost>;
}

// A codex entry whose two modes exercise both downgrade branches (unknown icon →
// "ShieldCheck", known icon → preserved) plus a claude entry the visibility gate drops.
function makeEntries(): ProviderSnapshotEntry[] {
  return [
    {
      provider: "codex",
      status: "ready",
      enabled: true,
      modes: [
        { id: "default", label: "Default", icon: "Sparkles" },
        { id: "safe", label: "Safe", icon: "ShieldCheck" },
      ],
    },
    { provider: "claude", status: "ready", enabled: true, modes: [] },
  ];
}

function makeSubsystem(options: MakeOptions = {}) {
  const emitted: SessionOutboundMessage[] = [];
  const visible = options.visibleProviders ?? new Set(["codex"]);
  let changeHandler: SnapshotChangeHandler | null = null;
  const host: ProviderCatalogSessionHost = {
    emit: (msg) => emitted.push(msg),
    isProviderVisibleToClient: (provider) => visible.has(provider),
    supportsCustomModeIcons: () => options.supportsCustomModeIcons ?? false,
    supportsProviderSnapshotReferences: () => false,
    wantsSnapshotChanges: () => true,
    supportsCompactProviderSnapshots: () => options.supportsCompactProviderSnapshots ?? false,
    listProviderAvailability: async () => [],
    listDraftFeatures: async () => [],
    ...options.host,
  };
  const providerSnapshotManager = createStub<ProviderSnapshotManager>({
    on: (_event: string, handler: SnapshotChangeHandler) => {
      changeHandler = handler;
    },
    off: () => {},
    ...options.snapshot,
  });
  const subsystem = new ProviderCatalogSession({
    host,
    providerSnapshotManager,
    providerUsageService: createStub<ProviderUsageService>(options.usage ?? {}),
    logger: pino({ level: "silent" }),
  });
  function pushSnapshotChange(
    current: ProviderSnapshot,
    previous = createProviderSnapshot([], current.cwd),
  ): void {
    if (!changeHandler) throw new Error("start() must run before a snapshot change");
    changeHandler({ previous, current });
  }
  return { subsystem, emitted, pushSnapshotChange };
}

describe("ProviderCatalogSession", () => {
  it("PUSH gates invisible providers and downgrades unknown mode icons for legacy clients", () => {
    const { subsystem, emitted, pushSnapshotChange } = makeSubsystem({
      visibleProviders: new Set(["codex"]),
      supportsCustomModeIcons: false,
    });

    subsystem.start();
    pushSnapshotChange(createProviderSnapshot(makeEntries()));

    const push = findByType(emitted, "providers_snapshot_update");
    expect(push?.payload.entries.map((entry) => entry.provider)).toEqual(["codex"]);
    expect(push?.payload.entries[0]?.modes).toEqual([
      { id: "default", label: "Default", icon: "ShieldCheck" },
      { id: "safe", label: "Safe", icon: "ShieldCheck" },
    ]);
  });

  it("PUSH and PULL produce identical visible, downgraded entries for one client", async () => {
    const { subsystem, emitted, pushSnapshotChange } = makeSubsystem({
      visibleProviders: new Set(["codex"]),
      supportsCustomModeIcons: false,
      snapshot: { getSnapshot: () => createProviderSnapshot(makeEntries()) },
    });

    subsystem.start();
    pushSnapshotChange(createProviderSnapshot(makeEntries()));
    await subsystem.handleGetProvidersSnapshotRequest({
      type: "get_providers_snapshot_request",
      requestId: "g1",
    });

    const push = findByType(emitted, "providers_snapshot_update");
    const pull = findByType(emitted, "get_providers_snapshot_response");
    expect(pull?.payload.entries).toEqual(push?.payload.entries);
  });

  it("returns the canonical cwd used by snapshot updates", async () => {
    const getSnapshot = vi.fn((cwd?: string) => createProviderSnapshot(makeEntries(), cwd));
    const { subsystem, emitted } = makeSubsystem({
      snapshot: { getSnapshot },
    });

    await subsystem.handleGetProvidersSnapshotRequest({
      type: "get_providers_snapshot_request",
      requestId: "canonical-cwd",
      cwd: "/repo/./sdk",
    });

    const canonicalCwd = getSnapshot.mock.calls[0]?.[0];
    expect(canonicalCwd).toEqual(expect.any(String));
    expect(findByType(emitted, "get_providers_snapshot_response")?.payload.cwd).toBe(canonicalCwd);
  });

  it("pushes the compact encoding to capable clients", () => {
    const { subsystem, emitted, pushSnapshotChange } = makeSubsystem({
      supportsCustomModeIcons: true,
      supportsCompactProviderSnapshots: true,
    });

    subsystem.start();
    pushSnapshotChange(createProviderSnapshot(makeEntries()));

    const push = findByType(emitted, "providers_snapshot_update");
    expect(push?.payload.entries).toEqual([]);
    expect(push?.payload.snapshotHash).toEqual(expect.any(String));
    expect(expandProviderSnapshot(push!.payload.compactSnapshot!)).toEqual([makeEntries()[0]]);
  });

  it("preserves custom mode icons when the client supports them", async () => {
    const { subsystem, emitted } = makeSubsystem({
      supportsCustomModeIcons: true,
      snapshot: { getSnapshot: () => createProviderSnapshot(makeEntries()) },
    });

    await subsystem.handleGetProvidersSnapshotRequest({
      type: "get_providers_snapshot_request",
      requestId: "g2",
    });

    const pull = findByType(emitted, "get_providers_snapshot_response");
    expect(pull?.payload.entries[0]?.modes?.[0]?.icon).toBe("Sparkles");
  });

  it("sends capable clients a compact snapshot and returns not-modified for its hash", async () => {
    const thinkingOptions = [
      { id: "low", label: "Low" },
      { id: "high", label: "High", isDefault: true },
    ];
    const entries: ProviderSnapshotEntry[] = [
      {
        provider: "codex",
        status: "ready",
        enabled: true,
        models: ["one", "two"].map((id) => ({
          provider: "codex",
          id,
          label: id,
          thinkingOptions,
          defaultThinkingOptionId: "high",
        })),
      },
    ];
    const { subsystem, emitted } = makeSubsystem({
      supportsCompactProviderSnapshots: true,
      snapshot: { getSnapshot: () => createProviderSnapshot(entries) },
    });

    await subsystem.handleGetProvidersSnapshotRequest({
      type: "get_providers_snapshot_request",
      requestId: "compact-1",
    });

    const first = findByType(emitted, "get_providers_snapshot_response");
    expect(first?.payload.entries).toEqual([]);
    expect(first?.payload.snapshotHash).toEqual(expect.any(String));
    expect(first?.payload.compactSnapshot?.thinkingSets).toHaveLength(1);
    expect(expandProviderSnapshot(first!.payload.compactSnapshot!)).toEqual(entries);

    await subsystem.handleGetProvidersSnapshotRequest({
      type: "get_providers_snapshot_request",
      requestId: "compact-2",
      ifNoneMatch: first?.payload.snapshotHash,
    });

    const responses = emitted.filter(
      (message) => message.type === "get_providers_snapshot_response",
    );
    const second = responses[1];
    expect(second?.payload).toMatchObject({
      entries: [],
      snapshotHash: first?.payload.snapshotHash,
      notModified: true,
      requestId: "compact-2",
    });
    expect(second?.payload.compactSnapshot).toBeUndefined();
  });

  it("reports a disabled provider on list_provider_models without warming the snapshot", async () => {
    // warmUpSnapshotForCwd is intentionally unstubbed: createStub throws if it is called,
    // so the disabled short-circuit is proven by the absence of a throw.
    const { subsystem, emitted } = makeSubsystem({
      snapshot: {
        getSnapshot: () =>
          createProviderSnapshot([{ provider: "codex", status: "loading", enabled: false }]),
      },
    });

    await subsystem.handleListProviderModelsRequest({
      type: "list_provider_models_request",
      provider: "codex",
      requestId: "m1",
    });

    const res = findByType(emitted, "list_provider_models_response");
    expect(res?.payload.error).toBe("Provider codex is disabled");
  });

  it("hides compatibility-only entries from list_provider_models", async () => {
    const { subsystem, emitted } = makeSubsystem({
      snapshot: {
        getSnapshot: () =>
          createProviderSnapshot([
            {
              provider: "codex",
              status: "ready",
              enabled: true,
              models: [
                { provider: "codex", id: "gpt-5.4", label: "GPT 5.4" },
                {
                  provider: "codex",
                  id: "gpt-5.4-legacy",
                  label: "GPT 5.4 legacy",
                  isSelectable: false,
                },
              ],
            },
          ]),
      },
    });

    await subsystem.handleListProviderModelsRequest({
      type: "list_provider_models_request",
      provider: "codex",
      requestId: "m-selectable",
    });

    const response = findByType(emitted, "list_provider_models_response");
    expect(response?.payload.models?.map((model) => model.id)).toEqual(["gpt-5.4"]);
  });

  it("preserves missing cwd as the semantic global snapshot for model list reads", async () => {
    const getSnapshot = vi.fn(() =>
      createProviderSnapshot([{ provider: "codex", status: "loading", enabled: true }]),
    );
    const warmUpSnapshotForCwd = vi.fn(async () => {});
    const { subsystem } = makeSubsystem({
      snapshot: { getSnapshot, warmUpSnapshotForCwd },
    });

    await subsystem.handleListProviderModelsRequest({
      type: "list_provider_models_request",
      provider: "codex",
      requestId: "m-global",
    });

    expect(getSnapshot).toHaveBeenCalledWith(undefined);
    expect(warmUpSnapshotForCwd).toHaveBeenCalledWith({
      cwd: undefined,
      providers: ["codex"],
    });
  });

  it("surfaces a usage-list failure as an rpc_error envelope", async () => {
    const { subsystem, emitted } = makeSubsystem({
      usage: {
        listUsage: async () => {
          throw new Error("quota service down");
        },
      },
    });

    await subsystem.handleProviderUsageListRequest({
      type: "provider.usage.list.request",
      requestId: "u1",
    });

    const err = findByType(emitted, "rpc_error");
    expect(err?.payload.code).toBe("provider_usage_list_failed");
    expect(err?.payload.requestId).toBe("u1");
  });

  it("surfaces a feature-list failure inline, not as an rpc_error", async () => {
    const { subsystem, emitted } = makeSubsystem({
      host: {
        listDraftFeatures: async () => {
          throw new Error("feature probe failed");
        },
      },
    });

    await subsystem.handleListProviderFeaturesRequest({
      type: "list_provider_features_request",
      requestId: "f1",
      draftConfig: { provider: "codex", cwd: "/tmp/project" },
    });

    expect(findByType(emitted, "rpc_error")).toBeUndefined();
    const res = findByType(emitted, "list_provider_features_response");
    expect(res?.payload.error).toBe("feature probe failed");
    expect(res?.payload.requestId).toBe("f1");
  });
});

it("announces shared content without retransmitting models or hashing discovery freshness", async () => {
  const { ProviderSnapshotManager: Manager } =
    await import("../../agent/provider-snapshot-manager.js");
  let probes = 0;
  let fetches = 0;
  const manager = new Manager({
    logger: pino({ level: "silent" }),
    providerOverrides: Object.fromEntries(
      ["codex", "claude", "pi", "opencode", "copilot", "omp"].map((provider) => [
        provider,
        { enabled: provider === "codex" },
      ]),
    ),
    extraClients: {
      codex: {
        provider: "codex",
        capabilities: {
          supportsStreaming: false,
          supportsSessionPersistence: false,
          supportsDynamicModes: false,
          supportsMcpServers: false,
          supportsReasoningStream: false,
          supportsToolInvocations: false,
        },
        async getCatalogCacheKey() {
          return "host";
        },
        async isAvailable() {
          probes++;
          return true;
        },
        async fetchCatalog() {
          fetches++;
          return { models: [{ provider: "codex", id: "astra", label: "Astra" }], modes: [] };
        },
        async createSession() {
          throw new Error("Not used");
        },
        async resumeSession() {
          throw new Error("Not used");
        },
      },
    },
  });
  const createSession = (emitted: SessionOutboundMessage[], references: boolean) =>
    new ProviderCatalogSession({
      providerSnapshotManager: manager,
      logger: pino({ level: "silent" }),
      providerUsageService: new ProviderUsageService({
        logger: pino({ level: "silent" }),
        fetchers: [],
      }),
      host: {
        emit(message) {
          emitted.push(message);
        },
        isProviderVisibleToClient: () => true,
        supportsCustomModeIcons: () => true,
        supportsCompactProviderSnapshots: () => true,
        wantsSnapshotChanges: () => true,
        supportsProviderSnapshotReferences: () => references,
        listProviderAvailability: async () => [],
        listDraftFeatures: async () => [],
      },
    });
  const emitted: SessionOutboundMessage[] = [];
  const peerMessages: SessionOutboundMessage[] = [];
  const session = createSession(emitted, true);
  const peer = createSession(peerMessages, false);
  try {
    await Promise.all(
      [undefined, "/tmp/catalog-a", "/tmp/catalog-b"].map((cwd) =>
        manager.getProvider({ provider: "codex", cwd, wait: true }),
      ),
    );
    expect({ probes, fetches }).toEqual({ probes: 1, fetches: 1 });
    session.start();
    peer.start();
    await session.handleGetProvidersSnapshotRequest({
      type: "get_providers_snapshot_request",
      requestId: "cold",
    });
    const first = findByType(emitted, "get_providers_snapshot_response")!.payload;
    expect(
      first.compactSnapshot?.entries.find((entry) => entry.provider === "codex")?.fetchedAt,
    ).toBeUndefined();
    expect(first.fetchedAt?.codex).toEqual(expect.any(String));
    await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(Date.parse(first.fetchedAt!.codex!)));
    emitted.length = 0;
    await manager.refreshSnapshotForCwd({ cwd: "/tmp/catalog-a", providers: ["codex"] });
    expect({ probes, fetches }).toEqual({ probes: 2, fetches: 2 });
    const pushes = emitted.filter((message) => message.type === "providers_snapshot_update");
    expect(pushes).toHaveLength(3);
    const peerPushes = peerMessages.filter(
      (message) => message.type === "providers_snapshot_update",
    );
    expect(peerPushes).toHaveLength(3);
    expect(
      peerPushes.every(({ payload }) =>
        payload.compactSnapshot?.entries.some(
          (entry) => entry.provider === "codex" && entry.models?.[0]?.id === "astra",
        ),
      ),
    ).toBe(true);
    expect(peerPushes[0]!.payload.snapshotHash).not.toBe(pushes[0]!.payload.snapshotHash);
    expect(pushes.map(({ payload }) => payload.snapshotHash)).toEqual(
      Array(3).fill(first.snapshotHash),
    );
    expect(
      pushes.flatMap(({ payload }) => (payload.compactSnapshot ? [payload.compactSnapshot] : [])),
    ).toEqual([]);
    expect(pushes.flatMap(({ payload }) => payload.entries)).toEqual([]);
    await session.handleGetProvidersSnapshotRequest({
      type: "get_providers_snapshot_request",
      requestId: "warm",
      ifNoneMatch: first.snapshotHash,
    });
    const warm = findByType(emitted, "get_providers_snapshot_response")!.payload;
    expect(warm.notModified).toBe(true);
    expect(warm.compactSnapshot).toBeUndefined();
    expect(warm.fetchedAt?.codex).toEqual(expect.any(String));
  } finally {
    session.dispose();
    peer.dispose();
    manager.destroy();
  }
});

it.each([false, true])(
  "conditional hits do not read model bodies (references=%s)",
  async (references) => {
    let modelReads = 0;
    const entries: ProviderSnapshotEntry[] = [
      {
        provider: "codex",
        status: "ready",
        enabled: true,
        modes: [{ id: "default", label: "Default", icon: "Sparkles" }],
        get models() {
          modelReads++;
          return [{ provider: "codex", id: "astra", label: "Astra" }];
        },
      },
    ];
    const snapshot: ProviderSnapshot = {
      cwd: GLOBAL_PROVIDER_SNAPSHOT_KEY,
      records: [{ entry: entries[0]!, contentHash: "fixture" }],
    };
    const { subsystem, emitted, pushSnapshotChange } = makeSubsystem({
      supportsCompactProviderSnapshots: true,
      host: { supportsProviderSnapshotReferences: () => references },
      snapshot: { getSnapshot: () => snapshot },
    });
    subsystem.start();
    await subsystem.handleGetProvidersSnapshotRequest({
      type: "get_providers_snapshot_request",
      requestId: "cold",
    });
    const first = findByType(emitted, "get_providers_snapshot_response")!.payload;
    expect(modelReads).toBeGreaterThan(0);
    modelReads = 0;
    await subsystem.handleGetProvidersSnapshotRequest({
      type: "get_providers_snapshot_request",
      requestId: "hit",
      ifNoneMatch: first.snapshotHash,
    });
    expect(modelReads).toBe(0);
    pushSnapshotChange(snapshot);
    expect(modelReads === 0).toBe(references);
    subsystem.dispose();
  },
);

it.each([false, true])(
  "snapshot identity follows the client view and its freshness policy (references=%s)",
  async (references) => {
    const entries = makeEntries();
    entries[0]!.fetchedAt = "2026-09-06T10:00:00.000Z";
    entries[0]!.models = [{ provider: "codex", id: "astra", label: "Astra" }];
    let snapshot = createProviderSnapshot(entries);
    const clients = [
      makeSubsystem({
        supportsCompactProviderSnapshots: true,
        host: { supportsProviderSnapshotReferences: () => references },
        snapshot: { getSnapshot: () => snapshot },
      }),
      makeSubsystem({
        supportsCompactProviderSnapshots: true,
        host: { supportsProviderSnapshotReferences: () => references },
        snapshot: { getSnapshot: () => snapshot },
      }),
      makeSubsystem({
        supportsCompactProviderSnapshots: true,
        supportsCustomModeIcons: true,
        host: { supportsProviderSnapshotReferences: () => references },
        snapshot: { getSnapshot: () => snapshot },
      }),
      makeSubsystem({
        supportsCompactProviderSnapshots: true,
        visibleProviders: new Set(["codex", "claude"]),
        host: { supportsProviderSnapshotReferences: () => references },
        snapshot: { getSnapshot: () => snapshot },
      }),
    ];
    const read = async (client: ReturnType<typeof makeSubsystem>, ifNoneMatch?: string) => {
      client.emitted.length = 0;
      await client.subsystem.handleGetProvidersSnapshotRequest({
        type: "get_providers_snapshot_request",
        requestId: "view",
        ifNoneMatch,
      });
      return findByType(client.emitted, "get_providers_snapshot_response")!.payload;
    };
    const views = await Promise.all(clients.map((client) => read(client)));
    expect(views[0]!.snapshotHash).toBe(views[1]!.snapshotHash);
    expect(views[0]!.compactSnapshot).toEqual(views[1]!.compactSnapshot);
    expect(new Set(views.map((view) => view.snapshotHash)).size).toBe(3);
    expect(expandProviderSnapshot(views[0]!.compactSnapshot!)[0]!.modes![0]!.icon).toBe(
      "ShieldCheck",
    );
    expect(expandProviderSnapshot(views[2]!.compactSnapshot!)[0]!.modes![0]!.icon).toBe("Sparkles");
    expect(
      expandProviderSnapshot(views[3]!.compactSnapshot!).map((entry) => entry.provider),
    ).toEqual(["codex", "claude"]);
    expect(views[0]!.compactSnapshot!.entries[0]!.fetchedAt).toBe(
      references ? undefined : entries[0]!.fetchedAt,
    );

    // Hidden provider changes do not invalidate the visible result.
    snapshot = createProviderSnapshot([
      entries[0]!,
      { ...entries[1]!, status: "error", error: "hidden" },
    ]);
    expect((await read(clients[0]!, views[0]!.snapshotHash)).notModified).toBe(true);
    // Same content hash, new embedded timestamp: only reference views can reuse the body.
    snapshot = createProviderSnapshot([
      { ...entries[0]!, fetchedAt: "2026-09-06T10:01:00.000Z" },
      entries[1]!,
    ]);
    expect(snapshot.records[0]!.contentHash).toBe(
      createProviderSnapshot(entries).records[0]!.contentHash,
    );
    const fresh = await read(clients[0]!, views[0]!.snapshotHash);
    expect(fresh.snapshotHash === views[0]!.snapshotHash).toBe(references);
    expect(fresh.notModified === true).toBe(references);
    expect(fresh.fetchedAt?.codex).toBe(references ? "2026-09-06T10:01:00.000Z" : undefined);

    snapshot = { ...snapshot, records: snapshot.records.toReversed() };
    expect((await read(clients[3]!)).snapshotHash).not.toBe(views[3]!.snapshotHash);
  },
);

it("reference capability alone preserves full legacy responses and does not alias embedded compact hashes", async () => {
  const snapshot = createProviderSnapshot(makeEntries());
  const clients = [
    makeSubsystem({
      host: { supportsProviderSnapshotReferences: () => true },
      snapshot: { getSnapshot: () => snapshot },
    }),
    makeSubsystem({
      supportsCompactProviderSnapshots: true,
      snapshot: { getSnapshot: () => snapshot },
    }),
    makeSubsystem({
      supportsCompactProviderSnapshots: true,
      host: { supportsProviderSnapshotReferences: () => true },
      snapshot: { getSnapshot: () => snapshot },
    }),
  ];
  for (const client of clients) {
    client.subsystem.start();
    client.pushSnapshotChange(snapshot);
    await client.subsystem.handleGetProvidersSnapshotRequest({
      type: "get_providers_snapshot_request",
      requestId: "format",
    });
    client.subsystem.dispose();
  }
  const views = clients.map(
    ({ emitted }) => findByType(emitted, "get_providers_snapshot_response")!.payload,
  );
  expect(views[0]!.snapshotHash).toBeUndefined();
  expect(views[0]!.entries).toEqual(
    findByType(clients[0]!.emitted, "providers_snapshot_update")!.payload.entries,
  );
  expect(views[0]!.entries).toHaveLength(1);
  expect(views[1]!.snapshotHash).not.toBe(views[2]!.snapshotHash);
  expect(expandProviderSnapshot(views[1]!.compactSnapshot!)).toEqual(views[0]!.entries);
  expect(expandProviderSnapshot(views[2]!.compactSnapshot!)).toEqual(views[0]!.entries);
});

it.each(["full", "embedded", "references"])(
  "suppresses hidden-only transitions but publishes visible freshness for %s clients",
  (format) => {
    const before = createProviderSnapshot([
      {
        provider: "codex",
        status: "ready",
        enabled: true,
        fetchedAt: "2026-09-06T10:00:00.000Z",
        models: [{ provider: "codex", id: "astra", label: "Astra" }],
      },
      { provider: "claude", status: "loading", enabled: true },
    ]);
    const hidden = createProviderSnapshot([
      before.records[0]!.entry,
      { provider: "claude", status: "error", enabled: true, error: "hidden" },
    ]);
    const fresh = createProviderSnapshot([
      { ...before.records[0]!.entry, fetchedAt: "2026-09-06T10:01:00.000Z" },
      hidden.records[1]!.entry,
    ]);
    const client = makeSubsystem({
      supportsCompactProviderSnapshots: format !== "full",
      host: { supportsProviderSnapshotReferences: () => format === "references" },
    });
    client.subsystem.start();
    client.pushSnapshotChange(hidden, before);
    expect(client.emitted).toEqual([]);
    client.pushSnapshotChange(fresh, hidden);
    const update = findByType(client.emitted, "providers_snapshot_update")!.payload;
    expect(client.emitted).toHaveLength(1);
    const representedFreshness =
      update.fetchedAt?.codex ??
      update.compactSnapshot?.entries[0]?.fetchedAt ??
      update.entries[0]?.fetchedAt;
    expect(representedFreshness).toBe("2026-09-06T10:01:00.000Z");
    client.subsystem.dispose();
  },
);
