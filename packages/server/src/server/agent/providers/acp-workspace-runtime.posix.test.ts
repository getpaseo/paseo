import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { createWorkspaceRuntimeService } from "../../workspace-runtime/index.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { ACPAgentSession } from "./acp-agent.js";
import { GenericACPAgentClient } from "./generic-acp-agent.js";
import { bindProviderWorkspace } from "./workspace/index.js";

const fixtureAgent = new URL(
  "../../../../../../runtimes/fixture/test/fixtures/workspace-runtime-acp-agent.mjs",
  import.meta.url,
);
const fixtureRuntime = fileURLToPath(
  new URL("../../../../../../runtimes/fixture/src/index.mjs", import.meta.url),
);

const posixDescribe = describe.runIf(process.platform !== "win32");

posixDescribe("ACP workspace terminal execution", () => {
  test("uses the selected workspace runtime for ACP-created terminal commands", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-acp-runtime-"));
    const cwd = path.join(root, "workspace");
    await mkdir(cwd);
    const runtimeIds = new Map<string, string>();
    const runtime = createWorkspaceRuntimeService({
      paseoHome: path.join(root, "home"),
      resolveRuntimeId: async (workspaceId) => runtimeIds.get(workspaceId) ?? null,
      persistRuntimeId: async (workspaceId, runtimeId) => {
        runtimeIds.set(workspaceId, runtimeId);
      },
      ...lifecycleRecords(runtimeIds),
    });
    await runtime.create({
      workspaceId: "acp-workspace",
      runtimeId: "local",
      project: { id: "project", source: { kind: "host-directory", path: cwd } },
      placement: { kind: "existing" },
    });
    const session = new ACPAgentSession(
      { provider: "acp-test", cwd },
      {
        provider: "acp-test",
        logger: createTestLogger(),
        defaultCommand: ["unused"],
        defaultModes: [],
        capabilities: {
          supportsStreaming: true,
          supportsSessionPersistence: false,
          supportsImages: false,
          supportsFileAttachments: false,
          supportsAudioAttachments: false,
          supportsModes: false,
          supportsModels: false,
          supportsThinking: false,
          supportsMcp: false,
          supportsSlashCommands: false,
        },
        workspace: bindProviderWorkspace({
          runtime: await runtime.bind("acp-workspace"),
          cwd: ".",
          policy: {
            environment: { type: "inherit-sanitized-host", hostEnvironment: process.env },
            sharedHostProviders: new Set(["opencode"]),
          },
        }),
      },
    );

    try {
      const terminal = await session.createTerminal({
        sessionId: "session",
        command: process.execPath,
        args: ["-e", "process.stdout.write(`${process.cwd()}|λ`);process.exit(12)"],
        cwd,
      });
      await expect(
        session.waitForTerminalExit({ sessionId: "session", terminalId: terminal.terminalId }),
      ).resolves.toEqual({ exitCode: 12, signal: null });
      await expect(
        session.terminalOutput({ sessionId: "session", terminalId: terminal.terminalId }),
      ).resolves.toMatchObject({ output: `${await realpath(cwd)}|λ` });
    } finally {
      await session.close();
      await runtime.destroy("acp-workspace");
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each(["local", "worktree", "fixture"] as const)(
    "discovers and launches an ACP provider through the selected %s workspace",
    async (selectedRuntimeId) => {
      const root = await mkdtemp(path.join(tmpdir(), "paseo-acp-provider-runtime-"));
      const cwd = path.join(root, "workspace");
      await mkdir(cwd);
      await copyFile(fixtureAgent, path.join(cwd, "fixture-agent.mjs"));
      await chmod(path.join(cwd, "fixture-agent.mjs"), 0o755);
      await writeFile(path.join(cwd, "committed.txt"), "before\n");
      execFileSync("git", ["init", "-b", "main"], { cwd });
      execFileSync("git", ["config", "user.email", "test@getpaseo.local"], { cwd });
      execFileSync("git", ["config", "user.name", "Paseo Test"], { cwd });
      execFileSync("git", ["add", "."], { cwd });
      execFileSync("git", ["commit", "-m", "fixture"], { cwd });
      const runtimeIds = new Map<string, string>();
      const fixtureStateDirectory = path.join(root, "fixture-state");
      await mkdir(fixtureStateDirectory);
      const service = createWorkspaceRuntimeService({
        paseoHome: path.join(root, "home"),
        resolveRuntimeId: async (workspaceId) => runtimeIds.get(workspaceId) ?? null,
        persistRuntimeId: async (workspaceId, persistedRuntimeId) =>
          runtimeIds.set(workspaceId, persistedRuntimeId),
        externalRuntimes:
          selectedRuntimeId === "fixture"
            ? {
                fixture: {
                  type: "command",
                  command: [process.execPath, fixtureRuntime],
                  options: { stateDirectory: fixtureStateDirectory },
                },
              }
            : undefined,
        ...lifecycleRecords(runtimeIds),
      });
      await service.create({
        workspaceId: "provider-workspace",
        runtimeId: selectedRuntimeId,
        project: { id: "project", source: { kind: "host-directory", path: cwd } },
        placement:
          selectedRuntimeId !== "worktree"
            ? { kind: "existing" }
            : { kind: "branch", branchName: "provider-worktree", baseRef: "main" },
      });
      const workspace = bindProviderWorkspace({
        runtime: await service.bind("provider-workspace"),
        cwd: ".",
        policy: {
          environment: {
            type: "inherit-sanitized-host",
            hostEnvironment: {
              ...process.env,
              PASEO_DAEMON_ONLY_PROVIDER_ENV: "daemon-visible",
            },
          },
          sharedHostProviders: new Set(["opencode"]),
        },
      });
      const client = new GenericACPAgentClient({
        logger: createTestLogger(),
        command: ["./fixture-agent.mjs"],
      });

      try {
        await expect(
          client.isAvailable({
            scope: "workspace",
            cwd,
            workspaceId: "provider-workspace",
            workspace,
            force: false,
          }),
        ).resolves.toBe(true);
        await expect(
          client.fetchCatalog({
            scope: "workspace",
            cwd,
            workspaceId: "provider-workspace",
            workspace,
            force: false,
            timeoutMs: 2_000,
          }),
        ).resolves.toMatchObject({ models: [{ id: "fixture-model" }] });
        const session = await client.createSession(
          { provider: "acp", cwd },
          { agentId: "fixture-agent", workspace },
        );
        await expect(session.run("runtime edit")).resolves.toMatchObject({
          finalText: "fixture completed: runtime edit",
        });
        await expect(workspace.readWorkspaceText("stdio-agent-output.txt")).resolves.toBe(
          "runtime edit\n",
        );
        await expect(workspace.readWorkspaceText("stdio-agent-env.txt")).resolves.toBe(
          "daemon-visible\n",
        );
        await session.close();
      } finally {
        await service.destroy("provider-workspace");
        await rm(root, { recursive: true, force: true });
      }
    },
    15_000,
  );
});

function lifecycleRecords(runtimeIds: Map<string, string>) {
  return {
    beginWorkspaceDeletion: async () => {},
    removeWorkspaceRecord: async (workspaceId: string) => {
      runtimeIds.delete(workspaceId);
    },
  };
}
