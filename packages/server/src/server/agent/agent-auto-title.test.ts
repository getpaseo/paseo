import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { createProviderSnapshotManagerStub } from "../test-utils/session-stubs.js";
import { createNoopWorkspaceGitService } from "../test-utils/workspace-git-service-stub.js";
import { WorkspaceAutoName } from "../workspace-auto-name.js";
import type { WorkspaceRegistry } from "../workspace-registry.js";
import type { GeneratedWorkspaceName } from "../worktree-branch-name-generator.js";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
});

async function fixture(generate: () => Promise<GeneratedWorkspaceName | null>) {
  vi.useFakeTimers();
  const cwd = mkdtempSync(join(tmpdir(), "paseo-agent-title-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(join(cwd, "agents"), logger);
  const manager = new AgentManager({
    clients: createTestAgentClients(),
    registry: storage,
    logger,
  });
  const autoName = new WorkspaceAutoName({
    agentManager: manager,
    workspaceRegistry: {} as WorkspaceRegistry,
    workspaceGitService: createNoopWorkspaceGitService(),
    providerSnapshotManager: createProviderSnapshotManagerStub().manager,
    readDaemonConfig: () => ({}),
    gitMutation: { notifyGitMutation: async () => {} },
    emitWorkspaceUpdateForCwd: async () => {},
    emitWorkspaceUpdateForWorkspaceId: async () => {},
    generateWorkspaceName: generate,
    logger,
  });
  cleanups.push(async () => {
    manager.prepareForShutdown();
    await Promise.all(manager.listAgents().map((agent) => manager.closeAgent(agent.id)));
    await manager.flushForShutdown();
    await storage.flush();
    rmSync(cwd, { recursive: true, force: true });
  });
  const create = (workspaceId: string, initialTitle = "请复刻这个网站的全部流程") =>
    manager.createAgent({ provider: "codex", cwd }, undefined, { workspaceId, initialTitle });
  return { manager, storage, autoName, create, cwd };
}

test("independently names multiple conversations sharing an existing workspace", async () => {
  const generate = vi.fn(async () => ({ title: "复刻网站流程", branch: "replicate-site" }));
  const f = await fixture(generate);
  for (const workspaceId of ["existing-directory", "existing-directory", "existing-worktree"]) {
    const agent = await f.create(workspaceId);
    f.autoName.scheduleForAgent({
      agentId: agent.id,
      cwd: f.cwd,
      firstAgentContext: { prompt: "请复刻这个网站的全部流程" },
      provisionalTitle: "请复刻这个网站的全部流程",
    });
    await vi.runAllTimersAsync();
    await vi.waitFor(async () => {
      expect((await f.storage.get(agent.id))?.title).toBe("复刻网站流程");
    });
  }
  expect(generate).toHaveBeenCalledTimes(3);
});

test("preserves a manual rename while title generation is pending", async () => {
  let finish!: (name: GeneratedWorkspaceName) => void;
  const f = await fixture(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const agent = await f.create("existing-directory");
  f.autoName.scheduleForAgent({
    agentId: agent.id,
    cwd: f.cwd,
    firstAgentContext: { prompt: "请复刻这个网站的全部流程" },
    provisionalTitle: "请复刻这个网站的全部流程",
  });
  await vi.advanceTimersByTimeAsync(0);
  await f.manager.updateAgentMetadata(agent.id, { title: "我自己取的名字" });
  finish({ title: "复刻网站流程", branch: null });
  await vi.runAllTimersAsync();
  expect((await f.storage.get(agent.id))?.title).toBe("我自己取的名字");
});

test("retries transient generation failure and deduplicates pending requests", async () => {
  const generate = vi
    .fn<() => Promise<GeneratedWorkspaceName | null>>()
    .mockResolvedValueOnce(null)
    .mockResolvedValue({ title: "复刻网站流程", branch: null });
  const f = await fixture(generate);
  const agent = await f.create("existing-directory");
  const input = {
    agentId: agent.id,
    cwd: f.cwd,
    firstAgentContext: { prompt: "请复刻这个网站的全部流程" },
    provisionalTitle: "请复刻这个网站的全部流程",
  };
  f.autoName.scheduleForAgent(input);
  f.autoName.scheduleForAgent(input);
  await vi.runAllTimersAsync();
  expect(generate).toHaveBeenCalledTimes(2);
  await vi.waitFor(async () => {
    expect((await f.storage.get(agent.id))?.title).toBe("复刻网站流程");
  });
});

test("keeps the provisional title when all attempts fail", async () => {
  const generate = vi.fn(async () => null);
  const f = await fixture(generate);
  const agent = await f.create("existing-directory");
  f.autoName.scheduleForAgent({
    agentId: agent.id,
    cwd: f.cwd,
    firstAgentContext: { prompt: "请复刻这个网站的全部流程" },
    provisionalTitle: "请复刻这个网站的全部流程",
  });
  await vi.runAllTimersAsync();
  expect(generate).toHaveBeenCalledTimes(3);
  expect((await f.storage.get(agent.id))?.title).toBe("请复刻这个网站的全部流程");
});

test("persists a generated title if the conversation closes during generation", async () => {
  const f = await fixture(async () => null);
  const agent = await f.create("existing-worktree");
  await f.manager.closeAgent(agent.id);
  expect(
    await f.manager.setGeneratedTitle(agent.id, "复刻网站流程", "请复刻这个网站的全部流程"),
  ).toBe(true);
  expect((await f.storage.get(agent.id))?.title).toBe("复刻网站流程");
  expect(await f.manager.setGeneratedTitle(agent.id, "过期结果", "请复刻这个网站的全部流程")).toBe(
    false,
  );
});
