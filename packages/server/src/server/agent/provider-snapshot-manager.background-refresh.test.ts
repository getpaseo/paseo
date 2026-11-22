import { BUILTIN_PROVIDER_IDS } from "@getpaseo/protocol/provider-manifest";
import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import type {
  AgentClient,
  AgentModelDefinition,
  AgentProvider,
  ProviderSnapshotEntry,
} from "./agent-sdk-types.js";
import type { ProviderRefreshTimers } from "./provider-refresh-schedule.js";
import { ProviderSnapshotManager } from "./provider-snapshot-manager.js";

const MINUTE = 60_000;
const INTERVAL_MS = 30 * MINUTE;

interface Probe {
  minute: number;
  provider: AgentProvider;
}

class FakeRefreshTimers implements ProviderRefreshTimers {
  private time = 0;
  private nextId = 0;
  private readonly pending = new Map<number, { at: number; run: () => void }>();

  now(): number {
    return this.time;
  }

  schedule(run: () => void, delayMs: number): () => void {
    const id = this.nextId++;
    this.pending.set(id, { at: this.time + delayMs, run });
    return () => this.pending.delete(id);
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  get minute(): number {
    return this.time / MINUTE;
  }

  /** Fires due timers in order, letting each refresh settle before the next timer. */
  async advanceMinutes(minutes: number): Promise<void> {
    const end = this.time + minutes * MINUTE;
    for (;;) {
      const next = [...this.pending].sort(([, a], [, b]) => a.at - b.at)[0];
      if (!next || next[1].at > end) break;
      this.pending.delete(next[0]);
      this.time = next[1].at;
      next[1].run();
      await settle();
    }
    this.time = end;
  }
}

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function model(provider: AgentProvider, id: string): AgentModelDefinition {
  return { provider, id, label: id };
}

interface TestProvider {
  models: AgentModelDefinition[];
  failure?: Error;
  /** Reports the catalogue as missing models discovery could not confirm. */
  incomplete?: boolean;
  available: boolean;
  /** Holds the next catalogue key resolution open until the test releases it. */
  keyHold?: Promise<void>;
  /** Holds the next availability check open until the test releases it. */
  availabilityHold?: Promise<void>;
  shutdowns: number;
  /** `force` of each catalogue request, in order. */
  forces: boolean[];
  /** Holds the next probe open until the test releases it. */
  hold?: Promise<void>;
}

function createHarness(options: { enabled: AgentProvider[]; disabled?: AgentProvider[] }) {
  const timers = new FakeRefreshTimers();
  const probes: Probe[] = [];
  const providers = new Map<AgentProvider, TestProvider>();
  const extraClients: Partial<Record<AgentProvider, AgentClient>> = {};
  for (const provider of [...options.enabled, ...(options.disabled ?? [])]) {
    const state: TestProvider = {
      models: [model(provider, `${provider}-1`)],
      available: true,
      forces: [],
      shutdowns: 0,
    };
    providers.set(provider, state);
    extraClients[provider] = createClient(provider, state, () =>
      probes.push({ minute: timers.minute, provider }),
    );
  }
  const providerOverrides = Object.fromEntries(
    BUILTIN_PROVIDER_IDS.filter((id) => !options.enabled.includes(id)).map((id) => [
      id,
      { enabled: false },
    ]),
  );
  const manager = new ProviderSnapshotManager({
    logger: createTestLogger(),
    providerOverrides,
    extraClients,
    backgroundRefresh: { intervalMs: INTERVAL_MS, timers },
  });
  const changes: ProviderSnapshotEntry[][] = [];
  manager.on("change", ({ current }) => changes.push(current.records.map(({ entry }) => entry)));
  return {
    manager,
    timers,
    probes,
    changes,
    provider: (provider: AgentProvider) => providers.get(provider)!,
    globalEntry: (provider: AgentProvider) =>
      manager.getSnapshot().records.find(({ entry }) => entry.provider === provider)!.entry,
  };
}

function createClient(
  provider: AgentProvider,
  state: TestProvider,
  onProbe: () => void,
): AgentClient {
  return {
    provider,
    capabilities: {
      supportsStreaming: false,
      supportsSessionPersistence: false,
      supportsDynamicModes: false,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: false,
    },
    async createSession() {
      throw new Error("not implemented");
    },
    async resumeSession() {
      throw new Error("not implemented");
    },
    async getCatalogCacheKey() {
      const hold = state.keyHold;
      state.keyHold = undefined;
      await hold;
      return undefined;
    },
    async isAvailable() {
      const hold = state.availabilityHold;
      state.availabilityHold = undefined;
      await hold;
      return state.available;
    },
    async shutdown() {
      state.shutdowns += 1;
    },
    async fetchCatalog(options) {
      onProbe();
      state.forces.push(options.force === true);
      const hold = state.hold;
      state.hold = undefined;
      await hold;
      if (state.failure) throw state.failure;
      return state.incomplete
        ? { models: state.models, modes: [], incomplete: true }
        : { models: state.models, modes: [] };
    },
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

describe("ProviderSnapshotManager background refresh", () => {
  test("refreshes each enabled provider once per interval, one provider per slot", async () => {
    const harness = createHarness({ enabled: ["codex", "claude", "opencode"], disabled: ["pi"] });
    try {
      await harness.timers.advanceMinutes(80);

      expect(harness.probes).toEqual([
        { minute: 30, provider: "claude" },
        { minute: 40, provider: "codex" },
        { minute: 50, provider: "opencode" },
        { minute: 60, provider: "claude" },
        { minute: 70, provider: "codex" },
        { minute: 80, provider: "opencode" },
      ]);
    } finally {
      harness.manager.destroy();
    }
  });

  test("a manual refresh pushes that provider's background refresh one interval later", async () => {
    const harness = createHarness({ enabled: ["codex"] });
    try {
      await harness.timers.advanceMinutes(10);
      await harness.manager.refreshSettingsSnapshot({ providers: ["codex"] });
      await harness.timers.advanceMinutes(50);

      expect(harness.probes).toEqual([
        { minute: 10, provider: "codex" },
        { minute: 60, provider: "codex" },
      ]);
    } finally {
      harness.manager.destroy();
    }
  });

  test("a slow refresh does not delay other providers' slots", async () => {
    const harness = createHarness({ enabled: ["codex", "claude"] });
    try {
      const held = deferred();
      harness.provider("claude").hold = held.promise;
      await harness.timers.advanceMinutes(50);
      held.resolve();
      await settle();
      await harness.timers.advanceMinutes(10);

      expect(harness.probes).toEqual([
        { minute: 30, provider: "claude" },
        { minute: 45, provider: "codex" },
        { minute: 60, provider: "claude" },
      ]);
    } finally {
      harness.manager.destroy();
    }
  });

  test("background probes do not ask providers for a forced refresh", async () => {
    const harness = createHarness({ enabled: ["codex"] });
    try {
      await harness.timers.advanceMinutes(30);
      await harness.manager.refreshSettingsSnapshot({ providers: ["codex"] });

      expect(harness.provider("codex").forces).toEqual([false, true]);
    } finally {
      harness.manager.destroy();
    }
  });

  test("joins discovery already in flight instead of probing again", async () => {
    const harness = createHarness({ enabled: ["codex"] });
    try {
      await harness.timers.advanceMinutes(29);
      const held = deferred();
      harness.provider("codex").hold = held.promise;
      const read = harness.manager.listProviders({ providers: ["codex"], wait: true });
      await settle();
      await harness.timers.advanceMinutes(1);
      held.resolve();
      const [entry] = await read;

      expect(entry).toMatchObject({ status: "ready", models: [{ id: "codex-1" }] });
      expect(harness.probes).toEqual([{ minute: 29, provider: "codex" }]);
    } finally {
      harness.manager.destroy();
    }
  });

  test("publishes a change only when the refreshed catalogue differs", async () => {
    const harness = createHarness({ enabled: ["codex"] });
    try {
      await harness.manager.listProviders({ providers: ["codex"], wait: true });
      const warmed = harness.globalEntry("codex");
      harness.changes.length = 0;

      await harness.timers.advanceMinutes(30);
      expect(harness.probes).toHaveLength(2);
      expect(harness.changes).toEqual([]);
      expect(harness.globalEntry("codex")).toBe(warmed);

      harness.provider("codex").models = [model("codex", "codex-1"), model("codex", "codex-2")];
      await harness.timers.advanceMinutes(30);

      expect(harness.probes).toHaveLength(3);
      expect(harness.changes).toHaveLength(1);
      expect(harness.globalEntry("codex").models?.map(({ id }) => id)).toEqual([
        "codex-1",
        "codex-2",
      ]);
    } finally {
      harness.manager.destroy();
    }
  });

  test("keeps the ready catalogue when a background refresh fails or finds the provider unavailable", async () => {
    const harness = createHarness({ enabled: ["codex"] });
    try {
      await harness.manager.listProviders({ providers: ["codex"], wait: true });
      const warmed = harness.globalEntry("codex");
      harness.changes.length = 0;
      harness.provider("codex").failure = new Error("network unreachable");

      await harness.timers.advanceMinutes(30);

      expect(harness.probes).toHaveLength(2);
      expect(harness.changes).toEqual([]);
      expect(harness.globalEntry("codex")).toBe(warmed);

      harness.provider("codex").failure = undefined;
      harness.provider("codex").available = false;
      await harness.timers.advanceMinutes(30);

      expect(harness.changes).toEqual([]);
      expect(harness.globalEntry("codex")).toBe(warmed);

      harness.provider("codex").available = true;
      harness.provider("codex").failure = new Error("network unreachable");
      await harness.manager.refreshSettingsSnapshot({ providers: ["codex"] });
      expect(harness.globalEntry("codex")).toMatchObject({
        status: "error",
        error: "network unreachable",
      });
    } finally {
      harness.manager.destroy();
    }
  });

  test("keeps the ready catalogue when a background refresh returns an incomplete one", async () => {
    const harness = createHarness({ enabled: ["codex"] });
    try {
      harness.provider("codex").models = [model("codex", "codex-1"), model("codex", "codex-2")];
      await harness.manager.listProviders({ providers: ["codex"], wait: true });
      const warmed = harness.globalEntry("codex");
      harness.changes.length = 0;
      harness.provider("codex").models = [model("codex", "codex-1")];
      harness.provider("codex").incomplete = true;

      await harness.timers.advanceMinutes(30);

      expect(harness.probes).toHaveLength(2);
      expect(harness.changes).toEqual([]);
      expect(harness.globalEntry("codex")).toBe(warmed);

      await harness.manager.refreshSettingsSnapshot({ providers: ["codex"] });
      expect(harness.globalEntry("codex").models?.map(({ id }) => id)).toEqual(["codex-1"]);
    } finally {
      harness.manager.destroy();
    }
  });

  test("a background refresh arriving while a manual refresh resolves its catalogue key does not weaken it", async () => {
    const harness = createHarness({ enabled: ["codex"] });
    try {
      await harness.manager.listProviders({ providers: ["codex"], wait: true });
      await harness.timers.advanceMinutes(29);
      harness.provider("codex").failure = new Error("network unreachable");
      const keyHeld = deferred();
      harness.provider("codex").keyHold = keyHeld.promise;
      const manual = harness.manager.refreshSettingsSnapshot({ providers: ["codex"] });
      await settle();

      // The manual refresh at minute 29 makes the provider due again at the minute-60 tick.
      await harness.timers.advanceMinutes(31);
      keyHeld.resolve();
      await manual;

      expect(harness.provider("codex").forces).toEqual([false, true]);
      expect(harness.globalEntry("codex")).toMatchObject({
        status: "error",
        error: "network unreachable",
      });
    } finally {
      harness.manager.destroy();
    }
  });

  test("follows provider enablement changes", async () => {
    const harness = createHarness({ enabled: ["codex", "claude"] });
    try {
      harness.manager.applyMutableProviderConfig({ claude: { enabled: false } });
      await harness.timers.advanceMinutes(60);
      expect(harness.probes).toEqual([
        { minute: 30, provider: "codex" },
        { minute: 60, provider: "codex" },
      ]);

      harness.probes.length = 0;
      harness.manager.applyMutableProviderConfig({ claude: { enabled: true } });
      await settle();
      await harness.timers.advanceMinutes(45);

      expect(harness.probes).toEqual([
        { minute: 60, provider: "claude" },
        { minute: 90, provider: "codex" },
        { minute: 105, provider: "claude" },
      ]);
    } finally {
      harness.manager.destroy();
    }
  });

  test("shutdown stops a running probe before it starts catalogue discovery", async () => {
    const harness = createHarness({ enabled: ["codex"] });
    const held = deferred();
    harness.provider("codex").availabilityHold = held.promise;
    await harness.timers.advanceMinutes(30);

    const stopped = harness.manager.shutdown();
    held.resolve();
    await stopped;
    await settle();

    expect(harness.probes).toEqual([]);
    expect(harness.provider("codex").shutdowns).toBe(1);
  });

  test("destroy and shutdown cancel the scheduled refresh", async () => {
    const destroyed = createHarness({ enabled: ["codex"] });
    expect(destroyed.timers.pendingCount).toBe(1);
    destroyed.manager.destroy();
    expect(destroyed.timers.pendingCount).toBe(0);

    const shutDown = createHarness({ enabled: ["codex"] });
    expect(shutDown.timers.pendingCount).toBe(1);
    await shutDown.manager.shutdown();
    expect(shutDown.timers.pendingCount).toBe(0);
    await shutDown.timers.advanceMinutes(60);
    expect(shutDown.probes).toEqual([]);
  });
});
