import { describe, expect, test } from "vitest";

import { resolveCreateAgentTitles } from "./agent/create-agent-title.js";

describe("resolveCreateAgentTitles", () => {
  test("derives a provisional title from prompt when explicit title is absent", () => {
    const resolved = resolveCreateAgentTitles({
      configTitle: undefined,
      initialPrompt: "Implement auth retries with backoff\n\ninclude tests",
    });

    expect(resolved.explicitTitle).toBeNull();
    expect(resolved.provisionalTitle).toBe("Implement auth retries with backoff");
  });

  test("preserves explicit title and does not treat it as provisional", () => {
    const resolved = resolveCreateAgentTitles({
      configTitle: "  Keep This Title  ",
      initialPrompt: "Ignored prompt title",
    });

    expect(resolved.explicitTitle).toBe("Keep This Title");
    expect(resolved.provisionalTitle).toBe("Keep This Title");
  });

  test("returns null values when prompt and title are empty", () => {
    const resolved = resolveCreateAgentTitles({
      configTitle: "   ",
      initialPrompt: "   ",
    });

    expect(resolved.explicitTitle).toBeNull();
    expect(resolved.provisionalTitle).toBeNull();
  });
});

import { afterEach, beforeEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentManager } from "./agent/agent-manager.js";
import { AgentStorage } from "./agent/agent-storage.js";
import { MockLoadTestAgentClient } from "./agent/providers/mock-load-test-agent.js";
import { ContextualTitles, canGenerateContextualTitle } from "./contextual-titles.js";
import {
  FileBackedWorkspaceRegistry,
  createPersistedWorkspaceRecord,
} from "./workspace-registry.js";
import { createTestLogger } from "../test-utils/test-logger.js";

describe("Accepted prompt contextual titles", () => {
  let directory: string;
  let manager: AgentManager;
  let storage: AgentStorage;
  let workspaces: FileBackedWorkspaceRegistry;
  let titles: ContextualTitles | undefined;
  const logger = createTestLogger();
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "pandaos-contextual-titles-"));
    storage = new AgentStorage(join(directory, "agents"), logger);
    workspaces = new FileBackedWorkspaceRegistry(join(directory, "workspaces.json"), logger);
    manager = new AgentManager({
      clients: { mock: new MockLoadTestAgentClient(logger) },
      registry: storage,
      logger,
      paseoToolsEnabled: false,
    });
    await workspaces.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "workspace-fixture",
        projectId: "project-fixture",
        cwd: directory,
        kind: "directory",
        displayName: "Fixture",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
  });
  afterEach(async () => {
    await titles?.dispose();
    await storage.flush();
    await rm(directory, { recursive: true, force: true });
  });
  async function create(title?: string) {
    return manager.createAgent(
      {
        provider: "mock",
        cwd: directory,
        title,
        featureValues: { mockAssistantResponse: "Fixture response" },
      },
      undefined,
      { workspaceId: "workspace-fixture" },
    );
  }
  async function send(agentId: string, prompt: string) {
    for await (const event of manager.streamAgent(agentId, prompt, {
      clientMessageId: crypto.randomUUID(),
    })) {
      void event;
    }
    await storage.flush();
  }
  function observe(
    generate = vi.fn(async () => ({
      title: "Repair login token refresh",
      branch: "repair-login-token-refresh",
    })),
  ) {
    titles = new ContextualTitles({
      agentManager: manager,
      agentStorage: storage,
      workspaceRegistry: workspaces,
      generate,
      emitWorkspaceUpdate: async () => {},
      onError: (error) => {
        throw error;
      },
    });
    return generate;
  }
  test("leaves greetings unnamed, uses the third actual prompt and persists stable meaningful titles", async () => {
    const generate = observe();
    const agent = await create();
    await send(agent.id, "hi");
    await send(agent.id, "welche skills kannst du nutzen?");
    expect(generate).not.toHaveBeenCalled();
    expect((await storage.get(agent.id))?.title).toBeNull();
    await send(agent.id, "Repair login token refresh with regression tests");
    await vi.waitFor(async () =>
      expect((await storage.get(agent.id))?.titleSource).toBe("generated"),
    );
    expect(generate.mock.calls[0][0].prompt).toContain("welche skills");
    expect(generate.mock.calls[0][0].prompt).toContain("Repair login token refresh");
    await vi.waitFor(async () =>
      expect((await workspaces.get("workspace-fixture"))?.title).toBe("Repair login token refresh"),
    );
    await send(agent.id, "Also add a timeout test");
    expect(generate).toHaveBeenCalledTimes(1);
    expect(
      (await new AgentStorage(join(directory, "agents"), logger).get(agent.id))?.titleSource,
    ).toBe("generated");
  });
  test("observes actual provider user echoes when older callers omit a message ID", async () => {
    const generate = observe();
    const agent = await create();
    for await (const event of manager.streamAgent(agent.id, "Repair login token refresh")) {
      void event;
    }
    await vi.waitFor(async () =>
      expect((await storage.get(agent.id))?.titleSource).toBe("generated"),
    );
    expect(generate).toHaveBeenCalledTimes(1);
  });

  test("upgrades only legacy names matching the actual first message and preserves custom names", async () => {
    const generate = observe();
    const agent = await create();
    await send(agent.id, "hi");
    const legacy = (await storage.get(agent.id))!;
    await storage.upsert({ ...legacy, title: "hi", titleSource: undefined });
    expect(canGenerateContextualTitle({ ...legacy, title: "Unrelated custom title" }, "hi")).toBe(
      false,
    );
    await send(agent.id, "Repair login token refresh");
    await vi.waitFor(async () =>
      expect((await storage.get(agent.id))?.titleSource).toBe("generated"),
    );
    expect(generate).toHaveBeenCalledTimes(1);
  });

  test("preserves explicit user names and manual same-text renames during generation", async () => {
    const explicit = await create("My carefully chosen title");
    const generate = observe();
    await send(explicit.id, "Repair login token refresh");
    expect(generate).not.toHaveBeenCalled();
    expect((await storage.get(explicit.id))?.title).toBe("My carefully chosen title");
    const unnamed = await create();
    await manager.setTitle(unnamed.id, "Repair login token refresh");
    await send(unnamed.id, "Repair login token refresh");
    expect(generate).not.toHaveBeenCalled();
    expect((await storage.get(unnamed.id))?.titleSource).toBe("manual");
  });
  test("rejects a delayed generated title after an actual manual rename and preserves manually named workspace", async () => {
    let release!: (value: { title: string; branch: string }) => void;
    const generate = vi.fn(
      () =>
        new Promise<{ title: string; branch: string }>((resolve) => {
          release = resolve;
        }),
    );
    observe(generate);
    const agent = await create();
    await send(agent.id, "Fix login bug");
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    await manager.setTitle(agent.id, "Hand picked mission");
    const apply = vi.spyOn(storage, "applyContextualTitle");
    release({ title: "Late generated title", branch: "late-title" });
    await vi.waitFor(() =>
      expect(apply).toHaveBeenCalledWith(agent.id, "Late generated title", null, "generated"),
    );
    await titles!.dispose();
    expect((await storage.get(agent.id))?.title).toBe("Hand picked mission");
    expect((await storage.get(agent.id))?.titleSource).toBe("manual");
    await workspaces.update("workspace-fixture", (current) => ({
      ...current,
      title: "Fix login bug",
      titleSource: "manual",
    }));
    const another = await create();
    observe();
    await send(another.id, "Fix login bug");
    await vi.waitFor(async () =>
      expect((await storage.get(another.id))?.titleSource).toBe("generated"),
    );
    expect((await workspaces.get("workspace-fixture"))?.title).toBe("Fix login bug");
  });
});
