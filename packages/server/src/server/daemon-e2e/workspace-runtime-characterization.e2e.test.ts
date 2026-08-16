import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FileVersion } from "@getpaseo/protocol/messages";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { createWorkspaceRuntimeService } from "../workspace-runtime/index.js";
import {
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
  FileBackedProjectRegistry,
  FileBackedWorkspaceRegistry,
} from "../workspace-registry.js";

const FIXTURE_PROVIDER = "workspace-runtime-fixture";
const FIXTURE_MODEL = "fixture-model";
const fixtureAgentPath = fileURLToPath(
  new URL(
    "../../../../../runtimes/fixture/test/fixtures/workspace-runtime-acp-agent.mjs",
    import.meta.url,
  ),
);
const fixtureRuntimePath = fileURLToPath(
  new URL("../../../../../runtimes/fixture/src/index.mjs", import.meta.url),
);

interface CharacterizedWorkspace {
  cwd: string;
  id: string;
  projectId: string;
  kind: "local" | "worktree";
}

let daemon: TestPaseoDaemon;
let client: DaemonClient;
const cleanupRoots: string[] = [];

beforeAll(async () => {
  daemon = await createTestPaseoDaemon({
    mcpEnabled: false,
    providerOverrides: {
      [FIXTURE_PROVIDER]: {
        extends: "acp",
        label: "Workspace Runtime Fixture",
        command: [process.execPath, fixtureAgentPath],
        models: [{ id: FIXTURE_MODEL, label: "Fixture Model", isDefault: true }],
        params: { supportsMcpServers: false },
        enabled: true,
      },
    },
  });
  client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.3.0-beta.2",
    reconnect: { enabled: false },
  });
  await client.connect();
  await client.fetchAgents({ subscribe: { subscriptionId: "runtime-characterization-agents" } });
});

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await daemon?.close();
  for (const root of cleanupRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createRepository(): string {
  const root = mkdtempSync(path.join(tmpdir(), "workspace-runtime-characterization-"));
  cleanupRoots.push(root);
  const repo = path.join(root, "repo");
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@getpaseo.local"], {
    cwd: repo,
    stdio: "pipe",
  });
  execFileSync("git", ["config", "user.name", "Paseo Test"], { cwd: repo, stdio: "pipe" });
  writeFileSync(path.join(repo, "characterized.txt"), "before\n");
  writeFileSync(path.join(repo, "binary.bin"), Buffer.alloc(700_000, 0xa5));
  writeFileSync(
    path.join(repo, "paseo.json"),
    JSON.stringify({
      worktree: {
        setup: [
          `${JSON.stringify(process.execPath)} -e "require('fs').writeFileSync('setup-output.txt', 'setup complete\\n')"`,
        ],
      },
      scripts: {
        characterize: {
          command:
            "sleep 1; printf workspace-script > workspace-script-output.txt; printf runtime-script-ok",
        },
      },
    }),
  );
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "pipe" });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "characterization fixture"], {
    cwd: repo,
    stdio: "pipe",
  });
  return repo;
}

function createBarrierRepository(mode: "complete" | "fail" = "complete"): string {
  const repo = createRepository();
  writeFileSync(
    path.join(repo, "setup-barrier.mjs"),
    mode === "complete"
      ? `import { existsSync, writeFileSync } from "node:fs";
process.stdout.write("setup-streamed-before-release\\n");
writeFileSync("setup-environment.json", JSON.stringify({
  custom: process.env.PASEO_SETUP_CUSTOM_INHERITED,
  supervised: process.env.PASEO_SUPERVISED,
  electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE,
  bashEnv: process.env.BASH_ENV,
  home: process.env.HOME,
  path: process.env.PATH,
  source: process.env.PASEO_SOURCE_CHECKOUT_PATH,
  root: process.env.PASEO_ROOT_PATH,
  worktree: process.env.PASEO_WORKTREE_PATH,
  branch: process.env.PASEO_BRANCH_NAME,
  port: process.env.PASEO_WORKTREE_PORT,
}));
const timer = setInterval(() => {
  if (!existsSync("release-setup")) return;
  clearInterval(timer);
  writeFileSync("setup-after-release.txt", "completed\\n");
}, 10);
`
      : `process.stdout.write("setup-failed-after-publication\\n"); process.exit(7);\n`,
  );
  writeFileSync(
    path.join(repo, "paseo.json"),
    JSON.stringify({
      worktree: { setup: [`${JSON.stringify(process.execPath)} setup-barrier.mjs`] },
    }),
  );
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "pipe" });
  execFileSync("git", ["commit", "--amend", "--no-edit"], { cwd: repo, stdio: "pipe" });
  return repo;
}

function waitForRawMessage<T extends SessionOutboundMessage>(
  selectedClient: DaemonClient,
  predicate: (message: SessionOutboundMessage) => message is T,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("Timed out waiting for public daemon message"));
    }, 15_000);
    const unsubscribe = selectedClient.subscribeRawMessages((message) => {
      if (!predicate(message)) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(message);
    });
  });
}

async function createCharacterizedWorkspace(kind: "local" | "worktree") {
  const repo = createRepository();
  const result = await client.createWorkspace({
    runtimeId: kind,
    source:
      kind === "local"
        ? { kind: "directory", path: repo }
        : {
            kind: "worktree",
            cwd: repo,
            action: "branch-off",
            branchName: "characterized-worktree",
            worktreeSlug: "characterized-worktree",
            baseBranch: "main",
          },
  });
  const workspace = result.workspace;
  if (!workspace?.workspaceDirectory) {
    throw new Error(result.error ?? `Failed to create ${kind} workspace`);
  }
  const projection = await client.fetchWorkspaces();
  expect(projection.entries.map((candidate) => candidate.id)).toContain(workspace.id);
  return {
    cwd: workspace.workspaceDirectory,
    id: workspace.id,
    projectId: workspace.projectId,
    kind,
  } satisfies CharacterizedWorkspace;
}

async function waitForTerminalOutput(terminalId: string, marker: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const decoder = new TextDecoder();
    let output = "";
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for terminal output: ${marker}`));
    }, 15_000);
    const unsubscribe = client.onTerminalStreamEvent((event) => {
      if (event.terminalId !== terminalId || event.type !== "output") return;
      output += decoder.decode(event.data, { stream: true });
      if (!output.includes(marker)) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(output);
    });
  });
}

async function expectFileEditAndWatch(workspace: CharacterizedWorkspace): Promise<void> {
  const listing = await client.listDirectory(workspace.cwd, ".", undefined, workspace.id);
  expect(listing.entries.map((entry) => entry.name)).toContain("characterized.txt");

  const initialRead = await client.readFile(
    workspace.cwd,
    "characterized.txt",
    undefined,
    workspace.id,
  );
  expect(new TextDecoder().decode(initialRead.bytes)).toBe("before\n");

  let resolveUpdate!: (version: FileVersion) => void;
  const updated = new Promise<FileVersion>((resolve) => {
    resolveUpdate = resolve;
  });
  const fileSubscription = await client.subscribeFile(
    { cwd: workspace.cwd, path: "characterized.txt", workspaceId: workspace.id },
    resolveUpdate,
  );
  expect(fileSubscription.initial).toMatchObject({ status: "ready", size: 7 });
  if (fileSubscription.initial.status !== "ready") {
    throw new Error("Expected characterized.txt to be ready");
  }

  const write = await client.writeFile({
    cwd: workspace.cwd,
    path: "characterized.txt",
    content: "after\n",
    expectedModifiedAt: fileSubscription.initial.modifiedAt,
    expectedRevision: fileSubscription.initial.revision,
    workspaceId: workspace.id,
  });
  expect(write).toMatchObject({ status: "written", size: 6 });
  await expect(updated).resolves.toMatchObject({ status: "ready", size: 6 });
  fileSubscription.unsubscribe();

  const writtenRead = await client.readFile(
    workspace.cwd,
    "characterized.txt",
    undefined,
    workspace.id,
  );
  expect(new TextDecoder().decode(writtenRead.bytes)).toBe("after\n");
  const binaryRead = await client.readFile(workspace.cwd, "binary.bin", undefined, workspace.id);
  expect(binaryRead.bytes).toEqual(new Uint8Array(Buffer.alloc(700_000, 0xa5)));

  const download = await client.requestDownloadToken(
    workspace.cwd,
    "binary.bin",
    undefined,
    workspace.id,
  );
  expect(download.error).toBeNull();
  const response = await fetch(
    `http://127.0.0.1:${daemon.port}/api/files/download?token=${download.token}`,
  );
  expect(response.status).toBe(200);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(binaryRead.bytes);
}

async function expectGitObservation(workspace: CharacterizedWorkspace): Promise<void> {
  const workspaceGit = client.bindWorkspaceGit({ workspaceId: workspace.id, cwd: workspace.cwd });
  await expect
    .poll(() => workspaceGit.getStatus(), { timeout: 15_000 })
    .toMatchObject({
      isGit: true,
      isDirty: true,
    });
  const diff = await workspaceGit.getDiff({ mode: "uncommitted" });
  expect(diff.error).toBeNull();
  expect(diff.files).toContainEqual(
    expect.objectContaining({ path: "characterized.txt", status: "ok" }),
  );
  await expect(
    workspaceGit.commit({ message: "characterize runtime Git", addAll: true }),
  ).resolves.toMatchObject({ success: true, error: null });
  await expect(workspaceGit.refresh()).resolves.toMatchObject({ success: true, error: null });
  await expect(workspaceGit.getStatus()).resolves.toMatchObject({ isGit: true, isDirty: false });
}

async function expectTerminalCommand(workspace: CharacterizedWorkspace): Promise<void> {
  let resolveFileUpdate!: (version: FileVersion) => void;
  const fileUpdated = new Promise<FileVersion>((resolve) => {
    resolveFileUpdate = resolve;
  });
  const fileSubscription = await client.subscribeFile(
    { cwd: workspace.cwd, path: "terminal-edit.txt", workspaceId: workspace.id },
    resolveFileUpdate,
  );
  expect(fileSubscription.initial).toMatchObject({ status: "missing" });
  const terminal = await client.createTerminal(
    workspace.cwd,
    `${workspace.kind} terminal`,
    undefined,
    {
      workspaceId: workspace.id,
    },
  );
  const terminalId = terminal.terminal?.id;
  if (!terminalId) throw new Error(terminal.error ?? "Failed to create terminal");
  const marker = "runtime-terminal-ok";
  const command = "printf terminal-edit > terminal-edit.txt; printf '%s%s\\n' runtime-terminal- ok";
  expect(command).not.toContain(marker);
  try {
    const terminalOutput = waitForTerminalOutput(terminalId, marker);
    await client.subscribeTerminal(terminalId);
    client.sendTerminalInput(terminalId, { type: "input", data: `${command}\r` });
    await expect(terminalOutput).resolves.toContain(marker);
    await expect(fileUpdated).resolves.toMatchObject({ status: "ready", size: 13 });
    const edit = await client.readFile(workspace.cwd, "terminal-edit.txt", undefined, workspace.id);
    expect(new TextDecoder().decode(edit.bytes)).toBe("terminal-edit");
  } finally {
    fileSubscription.unsubscribe();
    await client.killTerminal(terminalId);
  }
}

async function expectWorkspaceScript(workspace: CharacterizedWorkspace): Promise<void> {
  const listed = await client.listWorkspaceScripts(workspace.id);
  expect(listed.scripts).toContainEqual(
    expect.objectContaining({ scriptName: "characterize", lifecycle: "stopped" }),
  );
  const started = await client.startWorkspaceScriptWithStatus(workspace.id, "characterize");
  expect(started.error).toBeNull();
  const terminalId = started.script?.terminalId;
  if (!terminalId) throw new Error("Workspace script did not expose its terminal");
  await client.subscribeTerminal(terminalId);
  await expect(waitForTerminalOutput(terminalId, "runtime-script-ok")).resolves.toContain(
    "runtime-script-ok",
  );
  await expect
    .poll(
      () =>
        readWorkspaceTextFile(workspace.id, workspace.cwd, "workspace-script-output.txt").catch(
          () => "missing",
        ),
      { timeout: 15_000 },
    )
    .toBe("workspace-script");
}

async function expectProviderDiscoveryAndAgentExecution(
  workspace: CharacterizedWorkspace,
): Promise<void> {
  await client.refreshProvidersSnapshot({
    cwd: workspace.cwd,
    ...(workspace.kind === "local" ? { workspaceId: workspace.id } : {}),
    providers: [FIXTURE_PROVIDER],
  });
  const providers = await client.getProvidersSnapshot({
    cwd: workspace.cwd,
    ...(workspace.kind === "local" ? { workspaceId: workspace.id } : {}),
  });
  expect(providers.entries).toContainEqual(
    expect.objectContaining({
      provider: FIXTURE_PROVIDER,
      label: "Workspace Runtime Fixture",
      status: "ready",
      models: [expect.objectContaining({ id: FIXTURE_MODEL })],
    }),
  );

  const agent = await client.createAgent({
    provider: FIXTURE_PROVIDER,
    model: FIXTURE_MODEL,
    cwd: workspace.cwd,
    workspaceId: workspace.id,
    title: `${workspace.kind} stdio fixture`,
  });
  await client.sendMessage(agent.id, `characterize ${workspace.kind}`);
  const finished = await client.waitForFinish(agent.id, 30_000);
  expect(finished.status).toBe("idle");
  const agentRead = await client.readFile(
    workspace.cwd,
    "stdio-agent-output.txt",
    undefined,
    workspace.id,
  );
  expect(new TextDecoder().decode(agentRead.bytes)).toBe(`characterize ${workspace.kind}\n`);
}

async function readWorkspaceTextFile(
  workspaceId: string,
  cwd: string,
  filePath: string,
): Promise<string> {
  const file = await client.readFile(cwd, filePath, undefined, workspaceId);
  return new TextDecoder().decode(file.bytes);
}

describe("current workspace runtime journeys", () => {
  test("local workspace uses the public daemon/client behavior", async () => {
    const workspace = await createCharacterizedWorkspace("local");
    try {
      const records = JSON.parse(
        readFileSync(path.join(daemon.paseoHome, "projects", "workspaces.json"), "utf8"),
      ) as Array<{ workspaceId: string; runtime?: { runtimeId: string } }>;
      expect(records.find((record) => record.workspaceId === workspace.id)?.runtime).toEqual({
        runtimeId: "local",
      });
      expect(existsSync(path.join(workspace.cwd, "setup-output.txt"))).toBe(false);
      await expectFileEditAndWatch(workspace);
      await expectGitObservation(workspace);
      await expectTerminalCommand(workspace);
      await expectWorkspaceScript(workspace);
      await expectProviderDiscoveryAndAgentExecution(workspace);
      const archive = await client.archiveWorkspace(workspace.id);
      expect(archive.error).toBeNull();
      expect(existsSync(workspace.cwd)).toBe(true);
      expect(readFileSync(path.join(workspace.cwd, "characterized.txt"), "utf8")).toBe("after\n");
      await client.restoreWorkspace(workspace.id);
      const removal = await client.removeProject(workspace.projectId);
      expect(removal.removedWorkspaceIds).toContain(workspace.id);
      expect(existsSync(workspace.cwd)).toBe(true);
    } finally {
      await client.removeProject(workspace.projectId).catch(() => undefined);
    }
  }, 120_000);

  test("owned worktree runs setup and uses the same public daemon/client behavior", async () => {
    const workspace = await createCharacterizedWorkspace("worktree");
    try {
      const records = JSON.parse(
        readFileSync(path.join(daemon.paseoHome, "projects", "workspaces.json"), "utf8"),
      ) as Array<{ workspaceId: string; runtime?: { runtimeId: string } }>;
      expect(records.find((record) => record.workspaceId === workspace.id)?.runtime).toEqual({
        runtimeId: "worktree",
      });
      await expect
        .poll(() => client.fetchWorkspaceSetupStatus(workspace.id), { timeout: 30_000 })
        .toMatchObject({ snapshot: { status: "completed", error: null } });
      await expect(
        readWorkspaceTextFile(workspace.id, workspace.cwd, "setup-output.txt"),
      ).resolves.toBe("setup complete\n");

      await expectFileEditAndWatch(workspace);
      await expectGitObservation(workspace);
      await expectTerminalCommand(workspace);
      await expectWorkspaceScript(workspace);
      await expectProviderDiscoveryAndAgentExecution(workspace);

      let resolveRestoredObservation!: () => void;
      const restoredObservation = new Promise<void>((resolve) => {
        resolveRestoredObservation = resolve;
      });
      const restoredSubscription = await client.subscribeFile(
        { cwd: workspace.cwd, path: "characterized.txt", workspaceId: workspace.id },
        (version) => {
          if (version.status === "ready") resolveRestoredObservation();
        },
      );
      if (restoredSubscription.initial.status !== "ready") {
        throw new Error("Expected characterized.txt before archive");
      }

      const archive = await client.archiveWorkspace(workspace.id);
      expect(archive.error).toBeNull();
      expect(existsSync(workspace.cwd)).toBe(true);
      expect(readFileSync(path.join(workspace.cwd, "characterized.txt"), "utf8")).toBe("after\n");

      await client.restoreWorkspace(workspace.id);
      const restoredWrite = await client.writeFile({
        cwd: workspace.cwd,
        path: "characterized.txt",
        content: "restored\n",
        expectedModifiedAt: restoredSubscription.initial.modifiedAt,
        expectedRevision: restoredSubscription.initial.revision,
        workspaceId: workspace.id,
      });
      expect(restoredWrite.status).toBe("written");
      await expect(restoredObservation).resolves.toBeUndefined();
      restoredSubscription.unsubscribe();
      expect(readFileSync(path.join(workspace.cwd, "characterized.txt"), "utf8")).toBe(
        "restored\n",
      );

      const removal = await client.removeProject(workspace.projectId);
      expect(removal.removedWorkspaceIds).toContain(workspace.id);
      expect(existsSync(workspace.cwd)).toBe(false);
    } finally {
      if (existsSync(workspace.cwd)) {
        await client.removeProject(workspace.projectId).catch(() => undefined);
      }
    }
  }, 120_000);

  test("owned worktree publishes, streams setup, and runs an agent before setup releases", async () => {
    const repo = createBarrierRepository();
    const bashEnvMarker = path.join(repo, "bash-env-was-sourced");
    const bashEnvStartup = path.join(repo, "setup-bash-env.sh");
    writeFileSync(bashEnvStartup, `printf sourced > ${JSON.stringify(bashEnvMarker)}\n`);
    const originalCustom = process.env.PASEO_SETUP_CUSTOM_INHERITED;
    const originalSupervised = process.env.PASEO_SUPERVISED;
    const originalElectronRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
    const originalBashEnv = process.env.BASH_ENV;
    process.env.PASEO_SETUP_CUSTOM_INHERITED = "custom daemon value with spaces";
    process.env.PASEO_SUPERVISED = "must-be-sanitized";
    process.env.ELECTRON_RUN_AS_NODE = "must-be-sanitized";
    process.env.BASH_ENV = bashEnvStartup;
    const messages: SessionOutboundMessage[] = [];
    const unsubscribe = client.subscribeRawMessages((message) => messages.push(message));
    let workspace: CharacterizedWorkspace | undefined;
    try {
      const created = await client.createWorkspace({
        runtimeId: "worktree",
        source: {
          kind: "worktree",
          cwd: repo,
          action: "branch-off",
          branchName: "causal-worktree",
          worktreeSlug: "causal-worktree",
          baseBranch: "main",
        },
      });
      if (!created.workspace?.workspaceDirectory) {
        throw new Error(created.error ?? "Causal worktree creation failed");
      }
      workspace = {
        id: created.workspace.id,
        projectId: created.workspace.projectId,
        cwd: created.workspace.workspaceDirectory,
        kind: "worktree",
      };

      expect(existsSync(path.join(workspace.cwd, "release-setup"))).toBe(false);
      expect(
        messages.some(
          (message) =>
            message.type === "workspace.create.response" &&
            message.payload.workspace?.id === workspace?.id,
        ),
      ).toBe(true);
      expect(
        messages.some(
          (message) =>
            message.type === "workspace_update" &&
            message.payload.kind === "upsert" &&
            message.payload.workspace.id === workspace?.id,
        ),
      ).toBe(true);

      const isRunningSetup = (
        message: SessionOutboundMessage,
      ): message is Extract<SessionOutboundMessage, { type: "workspace_setup_progress" }> =>
        message.type === "workspace_setup_progress" &&
        message.payload.workspaceId === workspace?.id &&
        message.payload.status === "running" &&
        message.payload.detail.commands.some(
          (command) =>
            command.status === "running" && command.log.includes("setup-streamed-before-release"),
        );
      const running =
        messages.find(isRunningSetup) ??
        (await waitForRawMessage(
          client,
          (
            message,
          ): message is Extract<SessionOutboundMessage, { type: "workspace_setup_progress" }> =>
            isRunningSetup(message),
        ));
      expect(running.payload.detail.worktreePath).toBe(workspace.cwd);
      expect(running.payload.detail.commands[0]?.cwd).toBe(workspace.cwd);
      expect(existsSync(path.join(workspace.cwd, "setup-after-release.txt"))).toBe(false);
      const setupEnvironment = JSON.parse(
        await readWorkspaceTextFile(workspace.id, workspace.cwd, "setup-environment.json"),
      ) as Record<string, string | undefined>;
      expect(setupEnvironment).toMatchObject({
        custom: "custom daemon value with spaces",
        home: process.env.HOME,
        path: process.env.PATH,
        source: realpathSync(repo),
        root: realpathSync(repo),
        worktree: workspace.cwd,
        branch: "causal-worktree",
        port: expect.stringMatching(/^\d+$/u),
      });
      expect(setupEnvironment.supervised).toBeUndefined();
      expect(setupEnvironment.electronRunAsNode).toBeUndefined();
      expect(setupEnvironment.bashEnv).toBeUndefined();
      expect(existsSync(bashEnvMarker)).toBe(false);

      await client.refreshProvidersSnapshot({
        cwd: workspace.cwd,
        workspaceId: workspace.id,
        providers: [FIXTURE_PROVIDER],
      });
      const agent = await client.createAgent({
        provider: FIXTURE_PROVIDER,
        model: FIXTURE_MODEL,
        cwd: workspace.cwd,
        workspaceId: workspace.id,
        title: "agent before setup release",
      });
      await client.sendMessage(agent.id, "agent-before-release");
      expect((await client.waitForFinish(agent.id, 30_000)).status).toBe("idle");
      await expect(
        readWorkspaceTextFile(workspace.id, workspace.cwd, "stdio-agent-output.txt"),
      ).resolves.toBe("agent-before-release\n");
      expect(existsSync(path.join(workspace.cwd, "release-setup"))).toBe(false);

      writeFileSync(path.join(workspace.cwd, "release-setup"), "release\n");
      await expect
        .poll(() => client.fetchWorkspaceSetupStatus(workspace!.id), { timeout: 15_000 })
        .toMatchObject({ snapshot: { status: "completed", error: null } });
      await expect(
        readWorkspaceTextFile(workspace.id, workspace.cwd, "setup-after-release.txt"),
      ).resolves.toBe("completed\n");
    } finally {
      restoreProcessEnvironment("PASEO_SETUP_CUSTOM_INHERITED", originalCustom);
      restoreProcessEnvironment("PASEO_SUPERVISED", originalSupervised);
      restoreProcessEnvironment("ELECTRON_RUN_AS_NODE", originalElectronRunAsNode);
      restoreProcessEnvironment("BASH_ENV", originalBashEnv);
      unsubscribe();
      if (workspace) await client.removeProject(workspace.projectId).catch(() => undefined);
    }
  }, 120_000);

  test("setup failure after publication leaves the worktree usable", async () => {
    const repo = createBarrierRepository("fail");
    const created = await client.createWorkspace({
      runtimeId: "worktree",
      source: {
        kind: "worktree",
        cwd: repo,
        action: "branch-off",
        branchName: "failed-setup-worktree",
        worktreeSlug: "failed-setup-worktree",
        baseBranch: "main",
      },
    });
    if (!created.workspace?.workspaceDirectory) throw new Error(created.error ?? "create failed");
    const workspace = {
      id: created.workspace.id,
      projectId: created.workspace.projectId,
      cwd: created.workspace.workspaceDirectory,
      kind: "worktree" as const,
    };
    try {
      await expect
        .poll(() => client.fetchWorkspaceSetupStatus(workspace.id), { timeout: 15_000 })
        .toMatchObject({ snapshot: { status: "failed" } });
      await expectFileEditAndWatch(workspace);
      await expectGitObservation(workspace);
      await expectTerminalCommand(workspace);
    } finally {
      await client.removeProject(workspace.projectId).catch(() => undefined);
    }
  }, 120_000);
});

function restoreProcessEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("catalog selection creates through a configured runtime while omission remains local", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "workspace-runtime-selection-"));
  cleanupRoots.push(root);
  const repo = path.join(root, "repo");
  const stateDirectory = path.join(root, "fixture-state");
  mkdirSync(stateDirectory, { recursive: true });
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@getpaseo.local"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Paseo Test"], { cwd: repo });
  writeFileSync(path.join(repo, "selection.txt"), "fixture\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: repo });
  const selectedDaemon = await createTestPaseoDaemon({
    mcpEnabled: false,
    workspaceRuntimes: {
      fixture: {
        type: "command",
        label: "Fixture",
        command: [process.execPath, fixtureRuntimePath],
        options: { stateDirectory },
      },
    },
  });
  const selectedClient = new DaemonClient({
    url: `ws://127.0.0.1:${selectedDaemon.port}/ws`,
    reconnect: { enabled: false },
  });
  try {
    await selectedClient.connect();
    await expect(selectedClient.listWorkspaceRuntimes()).resolves.toMatchObject({
      runtimes: [
        { runtimeId: "local", builtin: true, requiresGitProject: false },
        { runtimeId: "worktree", builtin: true, requiresGitProject: true },
        {
          runtimeId: "fixture",
          builtin: false,
          label: "Fixture",
          requiresGitProject: true,
        },
      ],
    });
    const explicit = await selectedClient.createWorkspace({
      source: { kind: "directory", path: repo },
      runtimeId: "fixture",
    });
    const omitted = await selectedClient.createWorkspace({
      source: { kind: "directory", path: repo },
    });
    if (!explicit.workspace || !omitted.workspace) {
      throw new Error(explicit.error ?? omitted.error ?? "Workspace creation failed");
    }
    const records = JSON.parse(
      readFileSync(path.join(selectedDaemon.paseoHome, "projects", "workspaces.json"), "utf8"),
    ) as Array<{ workspaceId: string; runtime?: { runtimeId: string } }>;
    expect(
      records.find((record) => record.workspaceId === explicit.workspace?.id)?.runtime,
    ).toEqual({
      runtimeId: "fixture",
    });
    expect(records.find((record) => record.workspaceId === omitted.workspace?.id)?.runtime).toEqual(
      {
        runtimeId: "local",
      },
    );
  } finally {
    await selectedClient.close().catch(() => undefined);
    await selectedDaemon.close();
  }
});

test("provider probes match user workspace snapshots for every host-backed runtime", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "workspace-runtime-provider-probes-"));
  cleanupRoots.push(root);
  const stateDirectory = path.join(root, "fixture-state");
  const materializeRoot = path.join(root, "fixture-workspaces");
  mkdirSync(stateDirectory, { recursive: true });
  const probeDaemon = await createTestPaseoDaemon({
    mcpEnabled: false,
    providerOverrides: {
      claude: { enabled: false },
      codex: { enabled: false },
      copilot: { enabled: false },
      opencode: { enabled: false },
      pi: { enabled: false },
      [FIXTURE_PROVIDER]: {
        extends: "acp",
        label: "Workspace Runtime Fixture",
        command: [process.execPath, fixtureAgentPath],
        models: [{ id: FIXTURE_MODEL, label: "Fixture Model", isDefault: true }],
        params: { supportsMcpServers: false },
        enabled: true,
      },
    },
    workspaceRuntimes: {
      fixture: {
        type: "command",
        label: "Fixture",
        command: [process.execPath, fixtureRuntimePath],
        options: { stateDirectory, materializeRoot },
      },
    },
  });
  const probeClient = new DaemonClient({
    url: `ws://127.0.0.1:${probeDaemon.port}/ws`,
    appVersion: "0.3.1",
    reconnect: { enabled: false },
  });
  try {
    await probeClient.connect();
    for (const runtimeId of ["local", "worktree", "fixture"] as const) {
      const repo = path.join(root, `repo-${runtimeId}`);
      execFileSync("git", ["init", "-b", "main", repo], { stdio: "pipe" });
      execFileSync("git", ["config", "user.email", "test@getpaseo.local"], { cwd: repo });
      execFileSync("git", ["config", "user.name", "Paseo Test"], { cwd: repo });
      copyFileSync(fixtureAgentPath, path.join(repo, "fixture-agent.mjs"));
      chmodSync(path.join(repo, "fixture-agent.mjs"), 0o755);
      execFileSync("git", ["add", "."], { cwd: repo });
      execFileSync("git", ["commit", "-m", "fixture"], { cwd: repo });
      const added = await probeClient.addProject(repo);
      if (!added.project) throw new Error(added.error ?? `Failed to add ${runtimeId} project`);

      const ensured = await probeClient.ensureWorkspaceRuntimeProbe({
        projectId: added.project.projectId,
        runtimeId,
      });
      expect(ensured).toMatchObject({ status: "ready", error: null });
      const probeSnapshot = await probeClient.getProvidersSnapshot({
        workspaceId: ensured.workspaceId!,
      });
      const created = await probeClient.createWorkspace({
        source:
          runtimeId === "worktree"
            ? {
                kind: "worktree",
                projectId: added.project.projectId,
                action: "branch-off",
                branchName: `probe-${runtimeId}`,
                worktreeSlug: `probe-${runtimeId}`,
                baseBranch: "main",
              }
            : { kind: "directory", path: repo, projectId: added.project.projectId },
        runtimeId,
      });
      if (!created.workspace) throw new Error(created.error ?? `Failed to create ${runtimeId}`);
      const workspaceSnapshot = await probeClient.getProvidersSnapshot({
        workspaceId: created.workspace.id,
      });
      expect(probeSnapshot.entries.map(({ fetchedAt: _fetchedAt, ...entry }) => entry)).toEqual(
        workspaceSnapshot.entries.map(({ fetchedAt: _fetchedAt, ...entry }) => entry),
      );
      expect(probeSnapshot.entries).toContainEqual(
        expect.objectContaining({ provider: FIXTURE_PROVIDER, status: "ready" }),
      );
      const listed = await probeClient.fetchWorkspaces({
        filter: { projectId: added.project.projectId },
      });
      expect(listed.entries.map((entry) => entry.id)).toEqual([created.workspace.id]);
      await probeClient.removeProject(added.project.projectId);
    }
  } finally {
    await probeClient.close().catch(() => undefined);
    await probeDaemon.close();
  }
}, 120_000);

test("selected worktree provider journey stays behind the public daemon and client boundary", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "workspace-runtime-selected-worktree-"));
  cleanupRoots.push(root);
  const repo = path.join(root, "repo");
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@getpaseo.local"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Paseo Test"], { cwd: repo });
  writeFileSync(path.join(repo, "characterized.txt"), "before\n");
  copyFileSync(fixtureAgentPath, path.join(repo, "fixture-agent.mjs"));
  chmodSync(path.join(repo, "fixture-agent.mjs"), 0o755);
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "fixture"], {
    cwd: repo,
  });
  const paseoHomeRoot = path.join(root, "daemon-home");
  const paseoHome = path.join(paseoHomeRoot, ".paseo");
  mkdirSync(paseoHome, { recursive: true });
  const workspaceId = `selected-worktree-${Date.now()}`;
  let runtimeSelected = true;
  const seedRuntime = createWorkspaceRuntimeService({
    paseoHome,
    worktreesRoot: path.join(root, "worktrees"),
    resolveRuntimeId: async (id) => (id === workspaceId && runtimeSelected ? "worktree" : null),
    persistRuntimeId: async () => {
      runtimeSelected = true;
    },
    beginWorkspaceDeletion: async () => {},
    removeWorkspaceRecord: async () => {
      runtimeSelected = false;
    },
  });
  await seedRuntime.create({
    workspaceId,
    runtimeId: "worktree",
    project: { id: "selected-worktree-project", source: { kind: "host-directory", path: repo } },
    placement: {
      kind: "branch",
      branchName: "selected-worktree",
      baseRef: "main",
      worktreeSlug: workspaceId,
    },
  });
  const runtimeState = JSON.parse(
    readFileSync(
      path.join(
        paseoHome,
        "workspace-runtimes",
        "worktree",
        readdirSync(path.join(paseoHome, "workspace-runtimes", "worktree"))[0]!,
      ),
      "utf8",
    ),
  ) as { root: string };
  const seededProjectRegistry = new FileBackedProjectRegistry(
    path.join(paseoHome, "projects", "projects.json"),
    createTestLogger(),
  );
  const seededWorkspaceRegistry = new FileBackedWorkspaceRegistry(
    path.join(paseoHome, "projects", "workspaces.json"),
    createTestLogger(),
  );
  await seededProjectRegistry.initialize();
  await seededWorkspaceRegistry.initialize();
  const now = new Date().toISOString();
  await seededProjectRegistry.upsert(
    createPersistedProjectRecord({
      projectId: "selected-worktree-project",
      rootPath: repo,
      kind: "git",
      displayName: "selected-worktree-project",
      createdAt: now,
      updatedAt: now,
    }),
  );
  await seededWorkspaceRegistry.upsert(
    createPersistedWorkspaceRecord({
      workspaceId,
      projectId: "selected-worktree-project",
      cwd: runtimeState.root,
      kind: "worktree",
      displayName: "selected-worktree",
      branch: "selected-worktree",
      worktreeRoot: runtimeState.root,
      mainRepoRoot: repo,
      isPaseoOwnedWorktree: true,
      runtime: { runtimeId: "worktree" },
      createdAt: now,
      updatedAt: now,
    }),
  );
  const selectedDaemon = await createTestPaseoDaemon({
    paseoHomeRoot,
    cleanup: false,
    mcpEnabled: false,
    providerOverrides: {
      [FIXTURE_PROVIDER]: {
        extends: "acp",
        label: "Workspace Runtime Fixture",
        command: [path.join(runtimeState.root, "fixture-agent.mjs")],
        params: { supportsMcpServers: false },
        enabled: true,
      },
    },
  });
  const selectedClient = new DaemonClient({
    url: `ws://127.0.0.1:${selectedDaemon.port}/ws`,
    appVersion: "0.3.0-beta.2",
    reconnect: { enabled: false },
  });
  try {
    await selectedClient.connect();
    await selectedClient.fetchAgents({
      subscribe: { subscriptionId: "selected-worktree-agents" },
    });
    const snapshot = await selectedClient.getProvidersSnapshot({
      cwd: runtimeState.root,
      workspaceId,
    });
    expect(snapshot.entries).toContainEqual(
      expect.objectContaining({
        provider: FIXTURE_PROVIDER,
        status: "ready",
        models: [expect.objectContaining({ id: FIXTURE_MODEL })],
      }),
    );
    const agent = await selectedClient.createAgent({
      provider: FIXTURE_PROVIDER,
      model: FIXTURE_MODEL,
      cwd: runtimeState.root,
      workspaceId,
      title: "selected worktree fixture",
    });
    await selectedClient.sendMessage(agent.id, "selected worktree edit");
    await expect(selectedClient.waitForFinish(agent.id, 30_000)).resolves.toMatchObject({
      status: "idle",
    });
    const edited = await selectedClient.readFile(
      runtimeState.root,
      "stdio-agent-output.txt",
      undefined,
      workspaceId,
    );
    expect(new TextDecoder().decode(edited.bytes)).toBe("selected worktree edit\n");
    await expect(
      selectedClient.bindWorkspaceGit({ workspaceId, cwd: runtimeState.root }).getStatus(),
    ).resolves.toMatchObject({ isGit: true, isDirty: true });
  } finally {
    await selectedClient.close().catch(() => undefined);
    await selectedDaemon.close();
    await seedRuntime.destroy(workspaceId);
  }
}, 120_000);
