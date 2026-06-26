import { describe, expect, it } from "vitest";
import pino from "pino";
import {
  ProviderCatalogSession,
  type ProviderCatalogSessionHost,
} from "./provider-catalog-session.js";
import { createStub } from "../../test-utils/class-mocks.js";
import { findByType } from "../../test-utils/session-stubs.js";
import type { SessionOutboundMessage } from "../../messages.js";
import {
  resolveSnapshotCwd,
  type ProviderSnapshotManager,
} from "../../agent/provider-snapshot-manager.js";
import type { ProviderSnapshotEntry } from "../../agent/agent-sdk-types.js";
import type { ProviderUsageService } from "../../../services/quota-fetcher/service.js";

type SnapshotChangeHandler = (entries: ProviderSnapshotEntry[], cwd: string) => void;

interface MakeOptions {
  visibleProviders?: Set<string>;
  supportsCustomModeIcons?: boolean;
  snapshot?: { [K in keyof ProviderSnapshotManager]?: unknown };
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
  function pushSnapshotChange(entries: ProviderSnapshotEntry[], cwd = resolveSnapshotCwd()): void {
    if (!changeHandler) throw new Error("start() must run before a snapshot change");
    changeHandler(entries, cwd);
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
    pushSnapshotChange(makeEntries());

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
      snapshot: { getSnapshot: () => makeEntries() },
    });

    subsystem.start();
    pushSnapshotChange(makeEntries());
    await subsystem.handleGetProvidersSnapshotRequest({
      type: "get_providers_snapshot_request",
      requestId: "g1",
    });

    const push = findByType(emitted, "providers_snapshot_update");
    const pull = findByType(emitted, "get_providers_snapshot_response");
    expect(pull?.payload.entries).toEqual(push?.payload.entries);
  });

  it("preserves custom mode icons when the client supports them", async () => {
    const { subsystem, emitted } = makeSubsystem({
      supportsCustomModeIcons: true,
      snapshot: { getSnapshot: () => makeEntries() },
    });

    await subsystem.handleGetProvidersSnapshotRequest({
      type: "get_providers_snapshot_request",
      requestId: "g2",
    });

    const pull = findByType(emitted, "get_providers_snapshot_response");
    expect(pull?.payload.entries[0]?.modes?.[0]?.icon).toBe("Sparkles");
  });

  it("reports a disabled provider on list_provider_models without warming the snapshot", async () => {
    // warmUpSnapshotForCwd is intentionally unstubbed: createStub throws if it is called,
    // so the disabled short-circuit is proven by the absence of a throw.
    const { subsystem, emitted } = makeSubsystem({
      snapshot: { getSnapshot: () => [{ provider: "codex", status: "loading", enabled: false }] },
    });

    await subsystem.handleListProviderModelsRequest({
      type: "list_provider_models_request",
      provider: "codex",
      requestId: "m1",
    });

    const res = findByType(emitted, "list_provider_models_response");
    expect(res?.payload.error).toBe("Provider codex is disabled");
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
