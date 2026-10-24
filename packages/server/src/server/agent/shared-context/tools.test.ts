import { describe, expect, test } from "vitest";

import { registerSharedContextTools } from "./tools.js";
import type { SharedContextStore } from "./store.js";
import type { PaseoToolDefinition } from "../tools/types.js";

interface RegisteredTool {
  name: string;
  definition: PaseoToolDefinition;
}

function registerTools(options: {
  store: Pick<SharedContextStore, "list" | "save" | "get">;
  resolveProjectIdForCwd: (cwd: string) => Promise<string | null>;
  callerAgentId?: string;
  callerAgent?: { id: string; cwd: string; title: string | null } | null;
}) {
  const tools = new Map<string, RegisteredTool>();
  registerSharedContextTools({
    registerTool: (name, config, handler) => {
      tools.set(name, {
        name,
        definition: {
          name,
          title: config.title,
          description: config.description ?? name,
          inputSchema: config.inputSchema,
          outputSchema: config.outputSchema,
          handler,
        } as PaseoToolDefinition,
      });
    },
    store: options.store,
    resolveProjectIdForCwd: options.resolveProjectIdForCwd,
    callerAgentId: options.callerAgentId,
    resolveCallerAgent: () => options.callerAgent ?? null,
  });
  return tools;
}

async function execute(
  tools: Map<string, RegisteredTool>,
  name: string,
  input: Record<string, unknown>,
) {
  const tool = tools.get(name);
  if (!tool) {
    throw new Error(`tool not registered: ${name}`);
  }
  return tool.definition.handler(input as never, {});
}

function createStoreStub() {
  const entries: Array<Record<string, string | null>> = [];
  return {
    entries,
    store: {
      save: async (_projectId: string, input: Record<string, unknown>) => {
        const entry = {
          id: `ctx_${entries.length}`,
          kind: input.kind as string,
          title: input.title as string,
          body: input.body as string,
          authorAgentId: (input.authorAgentId as string | null) ?? null,
          authorLabel: (input.authorLabel as string | null) ?? null,
          createdAt: "2026-09-27T00:00:00.000Z",
        };
        entries.push(entry);
        return entry;
      },
      list: async () => entries,
      get: async (_projectId: string, ids: string[]) =>
        entries.filter((entry) => ids.includes(entry.id as string)),
    } satisfies Pick<SharedContextStore, "list" | "save" | "get">,
  };
}

describe("shared context tools", () => {
  test("registers context_save, context_list, and context_read", () => {
    const { store } = createStoreStub();
    const tools = registerTools({
      store,
      resolveProjectIdForCwd: async () => null,
    });
    expect([...tools.keys()].sort()).toEqual(["context_list", "context_read", "context_save"]);
  });

  test("context_save resolves the caller agent's cwd and records the author", async () => {
    const { store, entries } = createStoreStub();
    const tools = registerTools({
      store,
      resolveProjectIdForCwd: async (cwd) => (cwd === "/repo" ? "prj_aaaa" : null),
      callerAgentId: "agent-1",
      callerAgent: { id: "agent-1", cwd: "/repo", title: "Repo scout" },
    });

    const result = await execute(tools, "context_save", {
      kind: "learning",
      title: "Build system",
      body: "Bazel, not npm.",
    });
    expect(result.structuredContent).toMatchObject({
      entry: {
        kind: "learning",
        title: "Build system",
        authorAgentId: "agent-1",
        authorLabel: "Repo scout",
      },
    });
    expect(entries).toHaveLength(1);
  });

  test("context_save defaults the kind to note", async () => {
    const { store } = createStoreStub();
    const tools = registerTools({
      store,
      resolveProjectIdForCwd: async () => "prj_aaaa",
      callerAgentId: "agent-1",
      callerAgent: { id: "agent-1", cwd: "/repo", title: null },
    });
    const result = await execute(tools, "context_save", { title: "T", body: "B" });
    expect(result.structuredContent).toMatchObject({ entry: { kind: "note" } });
  });

  test("context_save requires cwd outside agent-scoped sessions", async () => {
    const { store } = createStoreStub();
    const tools = registerTools({
      store,
      resolveProjectIdForCwd: async () => "prj_aaaa",
    });
    await expect(execute(tools, "context_save", { title: "T", body: "B" })).rejects.toThrow(
      "cwd is required outside an agent-scoped session",
    );
    await expect(
      execute(tools, "context_save", { title: "T", body: "B", cwd: "/repo" }),
    ).resolves.toMatchObject({ structuredContent: { entry: { authorAgentId: null } } });
  });

  test("context tools fail clearly when the cwd has no project", async () => {
    const { store } = createStoreStub();
    const tools = registerTools({
      store,
      resolveProjectIdForCwd: async () => null,
      callerAgentId: "agent-1",
      callerAgent: { id: "agent-1", cwd: "/repo", title: null },
    });
    await expect(execute(tools, "context_save", { title: "T", body: "B" })).rejects.toThrow(
      /No Paseo project found for \/repo/,
    );
  });

  test("context_list filters by kind and query", async () => {
    const { store, entries } = createStoreStub();
    entries.push(
      {
        id: "ctx_0",
        kind: "research",
        title: "Auth research",
        body: "OAuth2 with PKCE everywhere.",
        authorAgentId: null,
        authorLabel: null,
        createdAt: "2026-09-26T00:00:00.000Z",
      },
      {
        id: "ctx_1",
        kind: "preference",
        title: "Commit style",
        body: "Conventional commits.",
        authorAgentId: null,
        authorLabel: null,
        createdAt: "2026-09-27T00:00:00.000Z",
      },
    );
    const tools = registerTools({
      store,
      resolveProjectIdForCwd: async () => "prj_aaaa",
      callerAgentId: "agent-1",
      callerAgent: { id: "agent-1", cwd: "/repo", title: null },
    });

    const all = await execute(tools, "context_list", {});
    expect(all.structuredContent).toMatchObject({
      entries: [{ id: "ctx_1" }, { id: "ctx_0" }],
    });

    const byKind = await execute(tools, "context_list", { kind: "preference" });
    expect(byKind.structuredContent).toMatchObject({
      entries: [{ id: "ctx_1", kind: "preference" }],
    });

    const byQuery = await execute(tools, "context_list", { query: "oauth" });
    expect(byQuery.structuredContent).toMatchObject({ entries: [{ id: "ctx_0" }] });
  });

  test("context_read returns full entries by id", async () => {
    const { store, entries } = createStoreStub();
    entries.push({
      id: "ctx_0",
      kind: "research",
      title: "Auth research",
      body: "Full body.",
      authorAgentId: "agent-9",
      authorLabel: "Scout",
      createdAt: "2026-09-26T00:00:00.000Z",
    });
    const tools = registerTools({
      store,
      resolveProjectIdForCwd: async () => "prj_aaaa",
      callerAgentId: "agent-1",
      callerAgent: { id: "agent-1", cwd: "/repo", title: null },
    });
    const result = await execute(tools, "context_read", { ids: ["ctx_0", "ctx_missing"] });
    expect(result.structuredContent).toEqual({
      entries: [entries[0]],
    });
  });
});
