import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { buildStoredAgentPayload } from "./agent-projections.js";
import { AgentStorage } from "./agent-storage.js";
import { AgentDirectory, type BackgroundVisibility } from "./directory.js";
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
      list: async () => workspaces,
    },
    projectLive: () => {
      throw new Error("No live agents in this suite");
    },
    projectStored: (record) => buildStoredAgentPayload(record, ["codex"]),
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
