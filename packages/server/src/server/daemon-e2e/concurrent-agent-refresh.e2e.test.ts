import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import type { AgentClient, AgentSession } from "../agent/agent-sdk-types.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const artifactRoot = path.resolve(".artifacts");
mkdirSync(artifactRoot, { recursive: true });
const resources: { daemon: TestPaseoDaemon; clients: DaemonClient[]; cwd: string }[] = [];
const releases: (() => void)[] = [];
afterEach(async () => {
  releases.splice(0).forEach((release) => release());
  for (const { daemon, clients, cwd } of resources.splice(0)) {
    await Promise.all(clients.map((client) => client.close()));
    await daemon.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

function heldHistoryProvider() {
  const historyStarted = deferred();
  const releaseHistory = deferred();
  releases.push(releaseHistory.resolve);
  const base = createTestAgentClient("claude");
  let resumes = 0;
  const provider: AgentClient = {
    provider: base.provider,
    capabilities: base.capabilities,
    createSession: (...args) => base.createSession(...args),
    fetchCatalog: (...args) => base.fetchCatalog(...args),
    isAvailable: (...args) => base.isAvailable(...args),
    async resumeSession(...args) {
      resumes += 1;
      const session = await base.resumeSession(...args);
      // Delay provider history through its public interface, keeping the manager real.
      return new Proxy(session, {
        get(target, key: keyof AgentSession) {
          if (key === "streamHistory")
            return async function* () {
              historyStarted.resolve();
              await releaseHistory.promise;
              yield* target.streamHistory();
            };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
  return { provider, historyStarted, releaseHistory, resumes: () => resumes };
}

async function setup(provider: AgentClient, agentId?: string, appVersions = ["0.14.0", "0.14.0"]) {
  const cwd = mkdtempSync(path.join(artifactRoot, "concurrent-refresh-"));
  const daemon = await createTestPaseoDaemon({ agentClients: { claude: provider } });
  const clients = appVersions.map(
    (appVersion) => new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion }),
  );
  resources.push({ daemon, clients, cwd });
  await Promise.all(clients.map((client) => client.connect()));
  await Promise.all(clients.map((client) => client.fetchAgents({ subscribe: {} })));
  const agent = await daemon.daemon.agentManager.createAgent({ provider: "claude", cwd }, agentId, {
    workspaceId: undefined,
  });
  return { clients, agent, cwd };
}

test("refreshes from separate connections share the reload until history is ready", async () => {
  const provider = heldHistoryProvider();
  const { clients, agent } = await setup(provider.provider);
  const first = clients[0].refreshAgent(agent.id);
  await provider.historyStarted.promise;
  const second = clients[1].refreshAgent(agent.id);
  // The following RPC traverses the same connection after the second refresh request.
  await clients[1].fetchAgents();
  provider.releaseHistory.resolve();
  const results = await Promise.all([first, second]);
  expect(results.map((result) => result.agentId)).toEqual([agent.id, agent.id]);
  expect(provider.resumes()).toBe(1);
  await clients[0].refreshAgent(agent.id);
  expect(provider.resumes()).toBe(2);
});

test("refreshing the same id in separate daemons does not share a provider reload", async () => {
  const provider = heldHistoryProvider();
  const firstDaemon = await setup(provider.provider);
  const secondDaemon = await setup(createTestAgentClient("claude"), firstDaemon.agent.id);
  const first = firstDaemon.clients[0].refreshAgent(firstDaemon.agent.id);
  await provider.historyStarted.promise;
  const second = secondDaemon.clients[0].refreshAgent(secondDaemon.agent.id);
  await secondDaemon.clients[0].fetchAgents();
  // The other daemon must finish without releasing the first one's provider history.
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let independent: boolean;
  try {
    independent = await Promise.race([
      second.then(() => true),
      new Promise<boolean>((resolve) => {
        deadline = setTimeout(() => resolve(false), 5000);
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
  provider.releaseHistory.resolve();
  await Promise.all([first, second]);
  expect(independent).toBe(true);
});

test("concurrent refreshes share a failure and a later retry starts a new reload", async () => {
  const resumeStarted = deferred();
  const releaseResume = deferred();
  releases.push(releaseResume.resolve);
  let resumes = 0;
  const provider = createTestAgentClient("claude", {
    beforeResumeSession: async () => {
      resumes += 1;
      if (resumes === 1) {
        resumeStarted.resolve();
        await releaseResume.promise;
        throw new Error("provider resume failed");
      }
    },
  });
  const { clients, agent } = await setup(provider);
  const first = clients[0].refreshAgent(agent.id);
  // Attach handlers before releasing the rejected provider operation.
  const outcome = Promise.allSettled([first]);
  await resumeStarted.promise;
  const second = clients[1].refreshAgent(agent.id);
  const retryOutcome = Promise.allSettled([second]);
  await clients[1].fetchAgents();
  releaseResume.resolve();
  const results = [...(await outcome), ...(await retryOutcome)];
  expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
  for (const result of results) {
    if (result.status === "rejected")
      expect(String(result.reason)).toContain("provider resume failed");
  }
  expect(resumes).toBe(1);
  await expect(clients[0].refreshAgent(agent.id)).resolves.toMatchObject({ agentId: agent.id });
  expect(resumes).toBe(2);
});

test("a legacy caller restores its workspace when joining a modern refresh", async () => {
  const provider = heldHistoryProvider();
  const {
    clients: [modern, legacy],
    cwd,
  } = await setup(provider.provider, undefined, ["0.1.105", "0.1.104"]);
  // An independent repository prevents archive from owning the enclosing test checkout.
  execFileSync("git", ["init", "-b", "main", cwd], { stdio: "pipe" });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Paseo Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    ],
    { cwd, stdio: "pipe" },
  );
  const created = await modern.createWorkspace({ source: { kind: "directory", path: cwd } });
  expect(created.error).toBeNull();
  const workspace = created.workspace!;
  const agent = await modern.createAgent({ provider: "claude", cwd, workspaceId: workspace.id });
  await modern.archiveWorkspace(workspace.id);
  expect((await modern.fetchWorkspaces()).entries.some((entry) => entry.id === workspace.id)).toBe(
    false,
  );
  const first = modern.refreshAgent(agent.id);
  await provider.historyStarted.promise;
  expect((await modern.fetchWorkspaces()).entries.some((entry) => entry.id === workspace.id)).toBe(
    false,
  );
  const joining = legacy.refreshAgent(agent.id);
  const outcomes = Promise.allSettled([first, joining]);
  try {
    await expect
      .poll(
        async () =>
          (await legacy.fetchWorkspaces()).entries.some((entry) => entry.id === workspace.id),
        { timeout: 5000 },
      )
      .toBe(true);
  } finally {
    provider.releaseHistory.resolve();
  }
  expect((await outcomes).map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
});
