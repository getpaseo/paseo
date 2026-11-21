import { resolveWorkspaceRootAgent } from "../workspace-directory.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { buildStoredAgentPayload } from "./agent-projections.js";
import { AgentStorage } from "./agent-storage.js";
import { AgentDirectory, type BackgroundVisibility } from "./directory.js";
import type { ManagedAgent } from "./agent-manager.js";
import type { PersistedWorkspaceRecord } from "../workspace-registry.js";

const NOW = "2026-03-01T12:00:00.000Z";

let home: string;
let storage: AgentStorage;
let directory: AgentDirectory;

function workspace(workspaceId: string, background: boolean): PersistedWorkspaceRecord {
  return {
    workspaceId,
    projectId: "project",
    cwd: home,
    kind: "local_checkout",
    displayName: workspaceId,
    background,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
  };
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "agent-directory-"));
  storage = new AgentStorage(home, createTestLogger());
  const base = {
    provider: "codex",
    cwd: home,
    createdAt: NOW,
    updatedAt: NOW,
    labels: {},
    lastStatus: "idle" as const,
  };
  await storage.upsert({ ...base, id: "visible", workspaceId: "open" });
  await storage.upsert({ ...base, id: "background", workspaceId: "open", background: true });
  await storage.upsert({ ...base, id: "in-background-workspace", workspaceId: "hidden" });
  await storage.upsert({ ...base, id: "internal", workspaceId: "open", internal: true });
  const workspaces = [workspace("open", false), workspace("hidden", true)];
  directory = new AgentDirectory({
    storage,
    manager: { listAgents: () => [] },
    workspaces: {
      get: async (id) => workspaces.find((entry) => entry.workspaceId === id) ?? null,
    },
    projectLive: () => {
      throw new Error("No live agents in this suite");
    },
    projectStored: (record) =>
      buildStoredAgentPayload(record, ["codex"], (_provider, own) => own ?? {}),
    isProviderVisible: () => true,
    isStoredProviderAvailable: () => true,
  });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function listedIds(includeBackground: BackgroundVisibility): Promise<string[]> {
  return (await directory.list({ includeBackground })).map((agent) => agent.id).toSorted();
}

test("default lists hide agents that are background or live in a background workspace", async () => {
  expect(await listedIds(false)).toEqual(["visible"]);
});

test("inclusive lists show every background agent", async () => {
  expect(await listedIds(true)).toEqual(["background", "in-background-workspace", "visible"]);
});

test("workspace-only visibility hides agent-level background agents from older clients", async () => {
  expect(await listedIds("workspaces")).toEqual(["in-background-workspace", "visible"]);
});

test("includes applies the same visibility to a single agent", async () => {
  const background = { workspaceId: "open", background: true };
  const inBackgroundWorkspace = { workspaceId: "hidden" };
  expect(await directory.includes(background)).toBe(false);
  expect(await directory.includes(background, "workspaces")).toBe(false);
  expect(await directory.includes(background, true)).toBe(true);
  expect(await directory.includes(inBackgroundWorkspace)).toBe(false);
  expect(await directory.includes(inBackgroundWorkspace, "workspaces")).toBe(true);
});

test("prompt recency ignores background agents", async () => {
  const base = {
    provider: "codex",
    cwd: home,
    workspaceId: "open",
    createdAt: NOW,
    updatedAt: NOW,
    labels: {},
    lastStatus: "idle" as const,
  };
  await storage.upsert({ ...base, id: "visible", lastUserMessageAt: "2026-03-02T00:00:00.000Z" });
  await storage.upsert({
    ...base,
    id: "background",
    background: true,
    lastUserMessageAt: "2026-03-03T00:00:00.000Z",
  });
  expect(await directory.workspaceLastUserMessageTimes()).toEqual(
    new Map([["open", "2026-03-02T00:00:00.000Z"]]),
  );
});

test("scoped status queries retain cross-workspace parent context", async () => {
  const base = { provider: "codex", cwd: home, createdAt: NOW, updatedAt: NOW };
  await storage.upsert({ ...base, id: "parent", workspaceId: "open" });
  await storage.upsert({
    ...base,
    id: "child",
    workspaceId: "hidden",
    labels: { "paseo.parent-agent-id": "parent" },
    lastStatus: "running",
  });
  const agents = await directory.list({
    workspaceIds: ["hidden"],
    includeBackground: true,
    includeAncestors: true,
  });
  const child = agents.find((agent) => agent.id === "child")!;
  expect(
    resolveWorkspaceRootAgent(child, new Map(agents.map((agent) => [agent.id, agent])))?.id,
  ).toBe("child");
  expect(child.status).toBe("running");
  expect(
    (await directory.list({ workspaceIds: ["hidden"], includeBackground: true })).map((a) => a.id),
  ).not.toContain("parent");
});

test("a hidden agent's activity shows on its nearest ancestor outside a background workspace", async () => {
  const base = { provider: "codex", cwd: home, createdAt: NOW, updatedAt: NOW };
  const childOf = (parentId: string) => ({ "paseo.parent-agent-id": parentId });
  await storage.upsert({ ...base, id: "parent", workspaceId: "open" });
  await storage.upsert({ ...base, id: "worker", workspaceId: "hidden", labels: childOf("parent") });
  await storage.upsert({ ...base, id: "nested", workspaceId: "hidden", labels: childOf("worker") });
  await storage.upsert({ ...base, id: "row", workspaceId: "open", labels: childOf("parent") });
  await storage.upsert({
    ...base,
    id: "helper",
    workspaceId: "hidden",
    background: true,
    labels: childOf("parent"),
  });
  await storage.upsert({ ...base, id: "loop-a", workspaceId: "hidden", labels: childOf("loop-b") });
  await storage.upsert({ ...base, id: "loop-b", workspaceId: "hidden", labels: childOf("loop-a") });
  async function rollupOf(agentId: string): Promise<string | null> {
    return directory.resolveRollupWorkspaceId((await storage.get(agentId))!);
  }

  // Structural only: an idle worker still resolves, so its finish can refresh the parent.
  expect(await rollupOf("worker")).toBe("open");
  expect(await rollupOf("nested")).toBe("open");
  // A visible row of its own, an agent-level background agent, no parent, or a cycle: no rollup.
  expect(await rollupOf("row")).toBeNull();
  expect(await rollupOf("helper")).toBeNull();
  expect(await rollupOf("in-background-workspace")).toBeNull();
  expect(await rollupOf("loop-a")).toBeNull();
});

test("hidden activity reads loaded agents without projecting them and skips idle ones", async () => {
  const base = { provider: "codex", cwd: home, createdAt: NOW, updatedAt: NOW };
  await storage.upsert({ ...base, id: "parent", workspaceId: "open" });
  function loaded(id: string, lifecycle: ManagedAgent["lifecycle"]): ManagedAgent {
    return {
      id,
      provider: "codex",
      workspaceId: "hidden",
      lifecycle,
      labels: { "paseo.parent-agent-id": "parent" },
      updatedAt: new Date(NOW),
    } as ManagedAgent;
  }
  const workspaces = [workspace("open", false), workspace("hidden", true)];
  const lookedUp: string[] = [];
  const hidden = new AgentDirectory({
    storage,
    manager: {
      listAgents: () => [
        loaded("turn", "running"),
        loaded("waiting", "idle"),
        loaded("background-work", "idle"),
      ],
      getAgentBackgroundWorkSummary: (agentId) =>
        agentId === "background-work" ? { count: 1 } : undefined,
    },
    workspaces: {
      get: async (id) => {
        lookedUp.push(id);
        return workspaces.find((entry) => entry.workspaceId === id) ?? null;
      },
    },
    projectLive: () => {
      throw new Error("Projected a live agent");
    },
    projectStored: (record) =>
      buildStoredAgentPayload(record, ["codex"], (_provider, own) => own ?? {}),
    isProviderVisible: () => true,
    isStoredProviderAvailable: () => true,
  });

  expect(await hidden.listHiddenRunningRollups()).toEqual([
    { workspaceId: "open", updatedAt: NOW },
    { workspaceId: "open", updatedAt: NOW },
  ]);
  // The idle agent never reaches a workspace lookup.
  expect(lookedUp).toEqual(["hidden", "open", "hidden", "open"]);
});
