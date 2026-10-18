import pino from "pino";
import { expect, test, vi } from "vitest";
import type { StoredAgentRecord } from "./agent/agent-storage.js";
import type { AgentSubscriber, ManagedAgent } from "./agent/agent-manager.js";
import type { FirstAgentContext } from "@getpaseo/protocol/messages";
import type { AgentManager } from "./agent/agent-manager.js";
import type { ProviderSnapshotManager } from "./agent/provider-snapshot-manager.js";
import { WorkspaceAutoName } from "./workspace-auto-name.js";
import { createPersistedWorkspaceRecord, type WorkspaceRegistry } from "./workspace-registry.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

test.each([null, "Nom manuel", "Name this workspace"])(
  "auto-name preserves archival and concurrent manual title %s",
  async (manualTitle) => {
    let workspace = createPersistedWorkspaceRecord({
      workspaceId: "workspace-auto-name",
      projectId: "project-auto-name",
      cwd: "/workspace",
      kind: "directory",
      displayName: "workspace",
      createdAt: "2026-08-08T00:00:00.000Z",
      updatedAt: "2026-08-08T00:00:00.000Z",
    });
    const mutationStarted = deferred();
    const allowMutation = deferred();
    const updateEmitted = deferred();
    const workspaceRegistry = {
      update: async (_workspaceId, updater) => {
        mutationStarted.resolve();
        await allowMutation.promise;
        workspace = updater(workspace);
        return workspace;
      },
    } satisfies Pick<WorkspaceRegistry, "update">;
    const autoName = new WorkspaceAutoName({
      agentManager: {} as AgentManager,
      workspaceRegistry,
      workspaceGitService: {} as WorkspaceGitService,
      providerSnapshotManager: {} as ProviderSnapshotManager,
      readDaemonConfig: () => ({}),
      gitMutation: { notifyGitMutation: async () => {} },
      emitWorkspaceUpdateForCwd: async () => {},
      emitWorkspaceUpdateForWorkspaceId: async () => updateEmitted.resolve(),
      logger: pino({ level: "silent" }),
      generateWorkspaceName: async () => ({ title: "generated", branch: null }),
    });

    autoName.scheduleForDirectory({
      workspaceId: workspace.workspaceId,
      cwd: workspace.cwd,
      firstAgentContext: { prompt: "Name this workspace" },
    });
    await mutationStarted.promise;
    const archivedAt = "2026-08-08T00:01:00.000Z";
    workspace = { ...workspace, updatedAt: archivedAt, archivedAt, title: manualTitle };
    allowMutation.resolve();
    await updateEmitted.promise;

    expect(workspace).toMatchObject({
      title: manualTitle ?? "generated",
      archivedAt,
    });
  },
);

function namingHarness() {
  let workspace = createPersistedWorkspaceRecord({
    workspaceId: "naming",
    projectId: "project",
    cwd: "/workspace",
    kind: "directory",
    displayName: "workspace",
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
  });
  const agents: StoredAgentRecord[] = [];
  const timelines = new Map<string, string[]>();
  let historyPrimed = true;
  let subscriber: AgentSubscriber = () => {};
  const generate = vi.fn(
    async (
      _options: import("./worktree-branch-name-generator.js").GenerateBranchNameFromFirstAgentContextOptions,
    ) => ({
      title: "Réparer les titres des espaces existants",
      branch: "repair-existing-workspace-automatic-title",
    }),
  );
  const emit = vi.fn(async () => {});
  const history = vi.fn(
    async (_agent: StoredAgentRecord): Promise<FirstAgentContext | null> => null,
  );
  const manager = {
    subscribe: (callback: AgentSubscriber) => {
      subscriber = callback;
      return () => {};
    },
    listAgents: () => [],
    getAgent: (id: string) => {
      const record = agents.find((agent) => agent.id === id);
      return record
        ? ({ ...record, config: record.config ?? {}, historyPrimed } as unknown as ManagedAgent)
        : null;
    },
    getTimeline: (id: string) =>
      (timelines.get(id) ?? []).map((text) => ({ type: "user_message" as const, text })),
  } as unknown as AgentManager;
  const registry = {
    get: async () => workspace,
    list: async () => [workspace],
    update: async (_id: string, updater: (current: typeof workspace) => typeof workspace) => {
      workspace = updater(workspace);
      return workspace;
    },
  };
  const make = () => {
    const naming = new WorkspaceAutoName({
      agentManager: manager,
      workspaceRegistry: registry,
      workspaceGitService: {} as WorkspaceGitService,
      providerSnapshotManager: {} as ProviderSnapshotManager,
      readDaemonConfig: () => ({}),
      gitMutation: { notifyGitMutation: async () => {} },
      emitWorkspaceUpdateForCwd: emit,
      emitWorkspaceUpdateForWorkspaceId: emit,
      logger: pino({ level: "silent" }),
      generateWorkspaceName: generate,
    });
    naming.start({
      workspaceRegistry: registry,
      listAgents: async () => agents,
      readFirstContext: history,
    });
    return naming;
  };
  const naming = make();
  const addAgent = (
    id: string,
    createdAt = "2026-10-01T00:00:00Z",
    labels: Record<string, string> = {},
    internal = false,
  ) => {
    agents.push({
      id,
      provider: "codex",
      workspaceId: "naming",
      cwd: "/workspace",
      createdAt,
      updatedAt: createdAt,
      labels,
      internal,
      lastStatus: "idle",
      config: { model: "selected-model" },
    });
  };
  const send = (id: string, text: string) => {
    timelines.set(id, [...(timelines.get(id) ?? []), text]);
    subscriber({
      type: "agent_stream",
      agentId: id,
      event: { type: "timeline", provider: "codex", item: { type: "user_message", text } },
    });
  };
  return {
    naming,
    make,
    addAgent,
    send,
    generate,
    emit,
    history,
    getWorkspace: () => workspace,
    setHistoryPrimed: (value: boolean) => {
      historyPrimed = value;
    },
    setWorkspace: (next: typeof workspace) => {
      workspace = next;
    },
  };
}

test("names from a delayed first message and the first agent model, once across simultaneous triggers", async () => {
  const h = namingHarness();
  h.addAgent("first");
  h.addAgent("second", "2026-10-02T00:00:00Z");
  h.send("first", "Réparer les titres avec les pièces jointes ci-dessous");
  h.send("second", "Ignore this later request");
  h.send("first", "Ignore this later message too");
  await vi.waitFor(() => expect(h.emit).toHaveBeenCalledTimes(1));
  expect(h.generate).toHaveBeenCalledTimes(1);
  expect(h.generate.mock.calls[0]?.[0]).toMatchObject({
    firstAgentContext: { prompt: "Réparer les titres avec les pièces jointes ci-dessous" },
    currentSelection: { provider: "codex", model: "selected-model" },
  });
  expect(h.getWorkspace().title).toBe("Réparer les titres des espaces existants");
});

test("ignores internal agents and delegated agents", async () => {
  const h = namingHarness();
  h.addAgent("internal", undefined, {}, true);
  h.addAgent("child", undefined, { "paseo.parent-agent-id": "parent" });
  h.send("internal", "Internal task");
  h.send("child", "Delegated task");
  await h.naming.recover();
  expect(h.generate).not.toHaveBeenCalled();
});

test("uses creation attachments and the first agent rather than the focused selection", async () => {
  const h = namingHarness();
  h.addAgent("first");
  const context = {
    attachments: [
      {
        type: "github_pr" as const,
        mimeType: "application/github-pr" as const,
        number: 42,
        title: "Corriger les titres",
        url: "https://github.com/acme/repo/pull/42",
      },
    ],
  };
  h.naming.scheduleForDirectory(
    { workspaceId: "naming", cwd: "/workspace", firstAgentContext: context },
    { currentSelection: { provider: "wrong-provider", model: "wrong-model" } },
  );
  await vi.waitFor(() => expect(h.emit).toHaveBeenCalledTimes(1));
  expect(h.generate.mock.calls[0]?.[0]).toMatchObject({
    firstAgentContext: context,
    currentSelection: { provider: "codex", model: "selected-model" },
  });
});

test("stops after three failures and resumes saved initial context on the next daemon", async () => {
  const h = namingHarness();
  h.addAgent("first");
  h.generate.mockRejectedValue(new Error("Temporary failure"));
  h.send("first", "Initial request");
  await vi.waitFor(() => expect(h.generate).toHaveBeenCalledTimes(3));
  h.send("first", "Later request");
  await h.naming.recover();
  expect(h.generate).toHaveBeenCalledTimes(3);
  h.generate.mockResolvedValue({
    title: "Réparer les titres des espaces existants",
    branch: "repair-existing-workspace-automatic-title",
  });
  await h.make().recover();
  await vi.waitFor(() => expect(h.emit).toHaveBeenCalledTimes(1));
  expect(h.generate.mock.calls[3]?.[0]).toMatchObject({
    firstAgentContext: { prompt: "Initial request" },
  });
});

test("backfills the first retained message and leaves manual titles intact", async () => {
  const h = namingHarness();
  h.addAgent("first");
  h.history.mockResolvedValue({ prompt: "First retained message" });
  await h.naming.recover();
  await vi.waitFor(() => expect(h.emit).toHaveBeenCalledTimes(1));
  expect(h.generate.mock.calls[0]?.[0]).toMatchObject({
    firstAgentContext: { prompt: "First retained message" },
  });
  h.setWorkspace({ ...h.getWorkspace(), title: "Titre manuel" });
  await h.make().recover();
  expect(h.generate).toHaveBeenCalledTimes(1);
});

test("retains structured attachments from a delayed first prompt", async () => {
  const h = namingHarness();
  h.addAgent("first");
  const attachment = {
    type: "text" as const,
    mimeType: "text/plain" as const,
    text: "Contexte joint à la demande initiale",
  };
  h.naming.captureFirstPrompt("first", [
    { type: "text", text: "Réparer les titres des espaces existants" },
    attachment,
  ]);
  h.send("first", "Réparer les titres des espaces existants");
  await h.naming.recover();
  expect(h.generate).toHaveBeenCalledTimes(1);
  expect(h.generate.mock.calls[0]?.[0]).toMatchObject({
    firstAgentContext: {
      prompt: "Réparer les titres des espaces existants",
      attachments: [attachment],
    },
  });
  expect(h.getWorkspace().autoName?.firstAgentContext.attachments).toEqual([attachment]);
});

test("reads retained history before using a new message from an unhydrated resumed agent", async () => {
  const h = namingHarness();
  h.addAgent("first");
  h.setHistoryPrimed(false);
  h.history.mockResolvedValue({ prompt: "Original retained request" });
  h.send("first", "Later follow-up");
  await h.naming.recover();
  expect(h.generate.mock.calls[0]?.[0]).toMatchObject({
    firstAgentContext: { prompt: "Original retained request" },
  });
});
