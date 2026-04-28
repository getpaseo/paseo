import { describe, it, expect, beforeEach, afterEach } from "vitest";
import pino from "pino";

import { IndexingService, type IndexingWorkspaceAdapter } from "./service.js";
import type { IndexingState } from "./types.js";
import type { IndexingToolDetection } from "./detector.js";

function makeAdapter(
  seed: Record<string, IndexingState | undefined> = {},
): IndexingWorkspaceAdapter & {
  data: Map<string, IndexingState | undefined>;
} {
  const data = new Map(Object.entries(seed));
  return {
    data,
    async list() {
      return Array.from(data.entries()).map(([workspaceId, indexing]) => ({
        workspaceId,
        indexing,
      }));
    },
    async get(workspaceId: string) {
      if (!data.has(workspaceId)) return null;
      return { workspaceId, indexing: data.get(workspaceId) };
    },
    async setIndexing(workspaceId, next) {
      if (next === null) data.delete(workspaceId);
      else data.set(workspaceId, next);
    },
  };
}

function makeService(
  adapter: IndexingWorkspaceAdapter,
  detect?: () => Promise<IndexingToolDetection>,
) {
  return new IndexingService({
    adapter,
    logger: pino({ enabled: false }),
    detect: detect ?? (async () => baseDetection()),
  });
}

function baseDetection(): IndexingToolDetection {
  return {
    codeReviewGraph: { name: "code-review-graph", installed: true, version: "2.4.1" },
    pipx: { name: "pipx", installed: true, version: "1.4.3" },
    python3: {
      name: "python3",
      installed: true,
      version: "Python 3.12.0",
      meetsMinimumVersion: true,
    },
    canInstall: true,
    suggestedInstall: null,
  };
}

describe("IndexingService.getState", () => {
  it("returns default state for unknown workspace (enabled by default)", async () => {
    const svc = makeService(makeAdapter());
    const state = await svc.getState("missing");
    expect(state.enabled).toBe(true);
    expect(state.status.phase).toBe("idle");
  });

  it("returns default state (enabled) when workspace has no indexing field", async () => {
    const adapter = makeAdapter({ ws1: undefined });
    const svc = makeService(adapter);
    const state = await svc.getState("ws1");
    expect(state.enabled).toBe(true);
  });

  it("returns persisted state when present", async () => {
    const persisted: IndexingState = {
      enabled: true,
      watchlist: ["dist"],
      exposeTo: { "claude-code": { enabled: true } },
      status: { phase: "ready", nodeCount: 12 },
    };
    const svc = makeService(makeAdapter({ ws1: persisted }));
    expect(await svc.getState("ws1")).toEqual(persisted);
  });
});

describe("IndexingService.setEnabled", () => {
  it("flips enabled and persists", async () => {
    const adapter = makeAdapter({ ws1: undefined });
    const svc = makeService(adapter);
    const result = await svc.setEnabled("ws1", true);
    expect(result.enabled).toBe(true);
    expect(adapter.data.get("ws1")?.enabled).toBe(true);
  });

  it("preserves existing watchlist and exposeTo when toggling", async () => {
    const seed: IndexingState = {
      enabled: false,
      watchlist: ["node_modules"],
      exposeTo: { codex: { enabled: true } },
      status: { phase: "idle" },
    };
    const svc = makeService(makeAdapter({ ws1: seed }));
    const result = await svc.setEnabled("ws1", true);
    expect(result.watchlist).toEqual(["node_modules"]);
    expect(result.exposeTo.codex).toEqual({ enabled: true });
  });
});

describe("IndexingService.setExposeTo", () => {
  let adapter: ReturnType<typeof makeAdapter>;
  let svc: IndexingService;

  beforeEach(() => {
    adapter = makeAdapter({ ws1: undefined });
    svc = makeService(adapter);
  });

  it("adds an agent entry", async () => {
    const result = await svc.setExposeTo("ws1", "claude-code", { enabled: true });
    expect(result.exposeTo["claude-code"]).toEqual({ enabled: true });
  });

  it("disables an agent without removing the entry", async () => {
    await svc.setExposeTo("ws1", "claude-code", { enabled: false });
    const state = await svc.getState("ws1");
    expect(state.exposeTo["claude-code"]).toEqual({ enabled: false });
  });

  it("removes an entry when passed null", async () => {
    await svc.setExposeTo("ws1", "claude-code", { enabled: false });
    await svc.setExposeTo("ws1", "claude-code", null);
    const state = await svc.getState("ws1");
    expect(state.exposeTo["claude-code"]).toBeUndefined();
  });

  it("supports per-tool granular lists", async () => {
    const result = await svc.setExposeTo("ws1", "codex", {
      enabled: true,
      enabledTools: ["crg_blast_radius"],
    });
    expect(result.exposeTo.codex?.enabledTools).toEqual(["crg_blast_radius"]);
  });
});

describe("IndexingService.update", () => {
  it("validates the merged state via the schema", async () => {
    const svc = makeService(makeAdapter({ ws1: undefined }));
    await expect(
      svc.update("ws1", {
        // @ts-expect-error invalid phase, runtime check only
        status: { phase: "bogus" },
      }),
    ).rejects.toThrow();
  });

  it("merges patches over existing state", async () => {
    const seed: IndexingState = {
      enabled: true,
      watchlist: ["a"],
      exposeTo: {},
      status: { phase: "idle" },
    };
    const svc = makeService(makeAdapter({ ws1: seed }));
    const result = await svc.update("ws1", {
      status: { phase: "indexing", progress: 42 },
    });
    expect(result.enabled).toBe(true);
    expect(result.status).toEqual({ phase: "indexing", progress: 42 });
  });
});

describe("IndexingService.listEnabled", () => {
  it("returns only workspaces with indexing.enabled === true", async () => {
    const adapter = makeAdapter({
      ws1: { enabled: true, watchlist: [], exposeTo: {}, status: { phase: "ready" } },
      ws2: { enabled: false, watchlist: [], exposeTo: {}, status: { phase: "idle" } },
      ws3: undefined,
    });
    const svc = makeService(adapter);
    const enabled = await svc.listEnabled();
    expect(enabled.map((e) => e.workspaceId)).toEqual(["ws1"]);
  });
});

describe("IndexingService.setStatus + onStatus", () => {
  it("persists status and notifies subscribers", async () => {
    const seed: IndexingState = {
      enabled: true,
      watchlist: [],
      exposeTo: {},
      status: { phase: "idle" },
    };
    const adapter = makeAdapter({ ws1: seed });
    const svc = makeService(adapter);
    const events: Array<{ workspaceId: string; phase: string }> = [];
    const unsubscribe = svc.onStatus((e) =>
      events.push({ workspaceId: e.workspaceId, phase: e.status.phase }),
    );
    await svc.setStatus("ws1", { phase: "indexing", progress: 10 });
    expect(adapter.data.get("ws1")?.status).toEqual({ phase: "indexing", progress: 10 });
    expect(events).toEqual([{ workspaceId: "ws1", phase: "indexing" }]);
    unsubscribe();
    await svc.setStatus("ws1", { phase: "ready", nodeCount: 42 });
    expect(events).toHaveLength(1); // listener removed
  });

  it("supports multiple subscribers independently", async () => {
    const adapter = makeAdapter({
      ws1: { enabled: true, watchlist: [], exposeTo: {}, status: { phase: "idle" } },
    });
    const svc = makeService(adapter);
    const a: number[] = [];
    const b: number[] = [];
    svc.onStatus(() => a.push(1));
    svc.onStatus(() => b.push(1));
    await svc.setStatus("ws1", { phase: "indexing", progress: 0 });
    expect(a).toEqual([1]);
    expect(b).toEqual([1]);
  });
});

describe("IndexingService.syncAgentConfigs", () => {
  let tmpHome: string;
  beforeEach(async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    tmpHome = await mkdtemp(path.join(os.tmpdir(), "hubcode-svc-"));
  });
  afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(tmpHome, { recursive: true, force: true });
  });

  it("writes hubcode entry to agents enabled for any indexed workspace", async () => {
    const adapter = makeAdapter({
      ws1: {
        enabled: true,
        watchlist: [],
        exposeTo: { "claude-code": { enabled: true } },
        status: { phase: "ready" },
      },
    });
    const svc = makeService(adapter);
    const outcomes = await svc.syncAgentConfigs({
      detectedAgentIds: ["claude-code", "codex"],
      hubcodeMcpUrl: "http://127.0.0.1:6767/mcp/agents",
      home: tmpHome,
    });
    expect(outcomes.find((o) => o.agentId === "claude-code")?.status).toBe("written");
    // codex doesn't support http, returns unsupported
    expect(outcomes.find((o) => o.agentId === "codex")?.status).toBe("unsupported");
  });

  it("treats missing exposeTo entry as default-on (writes entry)", async () => {
    const adapter = makeAdapter({
      ws1: {
        enabled: true,
        watchlist: [],
        exposeTo: {},
        status: { phase: "ready" },
      },
    });
    const svc = makeService(adapter);
    const outcomes = await svc.syncAgentConfigs({
      detectedAgentIds: ["claude-code"],
      hubcodeMcpUrl: "http://127.0.0.1:6767/mcp/agents",
      home: tmpHome,
    });
    expect(outcomes[0]?.status).toBe("written");
  });

  it("removes entry for agents explicitly disabled across all workspaces", async () => {
    const adapter = makeAdapter({
      ws1: {
        enabled: true,
        watchlist: [],
        exposeTo: { "claude-code": { enabled: false } },
        status: { phase: "ready" },
      },
    });
    const svc = makeService(adapter);
    // First write so something exists
    await svc.update("ws1", {
      exposeTo: { "claude-code": { enabled: true } },
    });
    await svc.syncAgentConfigs({
      detectedAgentIds: ["claude-code"],
      hubcodeMcpUrl: "http://127.0.0.1:6767/mcp/agents",
      home: tmpHome,
    });
    // Now disable
    await svc.update("ws1", {
      exposeTo: { "claude-code": { enabled: false } },
    });
    const outcomes = await svc.syncAgentConfigs({
      detectedAgentIds: ["claude-code"],
      hubcodeMcpUrl: "http://127.0.0.1:6767/mcp/agents",
      home: tmpHome,
    });
    expect(outcomes[0]?.status).toBe("removed");
  });

  it("removes entries when no workspace has indexing enabled", async () => {
    const adapter = makeAdapter({
      ws1: {
        enabled: false,
        watchlist: [],
        exposeTo: { "claude-code": { enabled: true } },
        status: { phase: "idle" },
      },
    });
    const svc = makeService(adapter);
    const outcomes = await svc.syncAgentConfigs({
      detectedAgentIds: ["claude-code"],
      hubcodeMcpUrl: "http://127.0.0.1:6767/mcp/agents",
      home: tmpHome,
    });
    // Was never written, so removal is "skipped"
    expect(outcomes[0]?.status).toBe("skipped");
  });
});

describe("IndexingService.getDetection", () => {
  it("caches detection across calls", async () => {
    let calls = 0;
    const svc = makeService(makeAdapter(), async () => {
      calls += 1;
      return baseDetection();
    });
    await svc.getDetection();
    await svc.getDetection();
    expect(calls).toBe(1);
  });

  it("force-refreshes when requested", async () => {
    let calls = 0;
    const svc = makeService(makeAdapter(), async () => {
      calls += 1;
      return baseDetection();
    });
    await svc.getDetection();
    await svc.getDetection(true);
    expect(calls).toBe(2);
  });

  it("propagates the detection result verbatim", async () => {
    const svc = makeService(makeAdapter(), async () => ({
      ...baseDetection(),
      canInstall: false,
      suggestedInstall: "brew install pipx && pipx install code-review-graph",
    }));
    const result = await svc.getDetection();
    expect(result.canInstall).toBe(false);
    expect(result.suggestedInstall).toContain("brew");
  });
});
