import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { expect, test } from "vitest";
import type { PluginBeforeRequests, PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { ClaudeAgentClient } from "../agent/providers/claude/agent.js";
import { CodexAppServerAgentClient } from "../agent/providers/codex-app-server-agent.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

type RecordedHook =
  | {
      [Name in keyof PluginLifecycleEvents]: { hook: Name; data: PluginLifecycleEvents[Name] };
    }[keyof PluginLifecycleEvents]
  | {
      [Name in keyof PluginBeforeRequests]: {
        hook: `before ${Name}`;
        data: { request: PluginBeforeRequests[Name] };
      };
    }[keyof PluginBeforeRequests];

const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
const evidenceDirectory = path.join(repoRoot, ".dev", "lifecycle-proof");

async function readHooks(client: DaemonClient): Promise<RecordedHook[]> {
  const logs = await client.getPluginLogs("lifecycle-logger");
  const events: RecordedHook[] = [];
  for (const entry of logs) {
    if (entry.message.startsWith('{"hook":')) {
      events.push(JSON.parse(entry.message) as RecordedHook);
    }
  }
  return events;
}

async function endedTurns(client: DaemonClient, agentId: string) {
  const events = await readHooks(client);
  return events.filter((event): event is Extract<RecordedHook, { hook: "agent.turn_ended" }> => {
    return event.hook === "agent.turn_ended" && event.data.agent.id === agentId;
  });
}

async function waitForTurns(client: DaemonClient, agentId: string, count: number): Promise<void> {
  await expect
    .poll(
      async () => {
        return (await endedTurns(client, agentId)).length;
      },
      { timeout: 120_000, interval: 250 },
    )
    .toBe(count);
}

async function waitForPermission(client: DaemonClient, agentId: string, command: string) {
  let requestId = "";
  await expect
    .poll(
      async () => {
        const events = await readHooks(client);
        for (const event of events) {
          if (
            event.hook === "agent.permission_requested" &&
            event.data.agent.id === agentId &&
            event.data.request.input?.command === command
          ) {
            requestId = event.data.request.id;
          }
        }
        return requestId;
      },
      { timeout: 120_000, interval: 250 },
    )
    .not.toBe("");
  return requestId;
}

test.skipIf(process.platform !== "linux")(
  "all lifecycle hooks and the example actions work with a real Claude agent on an isolated daemon",
  async () => {
    await mkdir(evidenceDirectory, { recursive: true });
    const fixture = await mkdtemp(path.join(tmpdir(), "paseo-real-hooks-"));
    const project = path.join(fixture, "project");
    await mkdir(path.join(project, ".claude"), { recursive: true });
    await writeFile(
      path.join(project, ".claude", "settings.json"),
      JSON.stringify({ permissions: { ask: ["Bash"] } }),
    );
    await writeFile(path.join(project, "canary.txt"), "preserve me\n");
    execFileSync("git", ["init", "-b", "main"], { cwd: project, stdio: "pipe" });
    execFileSync("git", ["add", "."], { cwd: project });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Lifecycle Test",
        "-c",
        "user.email=lifecycle@example.invalid",
        "commit",
        "-m",
        "Fixture",
      ],
      { cwd: project, stdio: "pipe" },
    );
    const destination = pino.destination({
      dest: path.join(evidenceDirectory, "daemon.log"),
      sync: true,
    });
    const logger = pino({ level: "info" }, destination);
    const daemon = await createTestPaseoDaemon({
      daemonVersion: "0.8.0",
      logger,
      agentClients: {
        claude: new ClaudeAgentClient({ logger }),
        codex: new CodexAppServerAgentClient(logger),
      },
      mcpEnabled: false,
    });
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.8.0",
    });
    const proof: Record<string, unknown> = {
      port: daemon.port,
      paseoHome: daemon.paseoHome,
      startedAt: new Date().toISOString(),
    };
    try {
      await client.connect();
      await client.fetchAgents({ subscribe: { subscriptionId: "real-hooks" } });
      await client.patchDaemonConfig({ pluginsEnabled: true });
      await client.installDirectoryPlugin(path.join(repoRoot, "plugin-examples/lifecycle-logger"));
      await client.installDirectoryPlugin(path.join(repoRoot, "plugin-examples/lifecycle-actions"));
      const created = await client.createWorkspace({
        title: "Isolated lifecycle example",
        source: { kind: "directory", path: project },
      });
      expect(created.error).toBeNull();
      const workspace = created.workspace!;
      expect(workspace.workspaceKind).toBe("worktree");
      expect(workspace.workspaceDirectory).not.toBe(project);
      proof.workspace = workspace;
      const agent = await client.createAgent({
        provider: "codex",
        cwd: workspace.workspaceDirectory,
        workspaceId: workspace.id,
        title: "Real lifecycle example",
      });
      expect(agent.provider).toBe("claude");
      proof.agent = { id: agent.id, requestedProvider: "codex", actualProvider: agent.provider };

      await client.sendMessage(
        agent.id,
        "This is a hook integration test. Reply exactly: out of credits. If the next user message is Try again., reply exactly RETRY_OK instead. Do not use tools.",
      );
      await waitForTurns(client, agent.id, 2);
      const retryTurns = await endedTurns(client, agent.id);
      expect(assistantText(retryTurns[1].data.timeline)).toBe("RETRY_OK");
      proof.followup = "RETRY_OK";

      await client.sendMessage(
        agent.id,
        "Call the Bash tool with exactly git status. Do not combine it with other commands. Then reply STATUS_OK.",
      );
      await waitForTurns(client, agent.id, 3);
      const approvalId = await waitForPermission(client, agent.id, "git status");
      expect(await readHooks(client)).toContainEqual(
        expect.objectContaining({
          hook: "agent.permission_resolved",
          data: expect.objectContaining({
            requestId: approvalId,
            resolution: expect.objectContaining({ behavior: "allow" }),
          }),
        }),
      );
      proof.approvedRequestId = approvalId;

      await client.sendMessage(
        agent.id,
        "Call the Bash tool with exactly rm -rf canary.txt. If declined, do not try any other command or tool. Reply DECLINED and stop.",
      );
      await waitForTurns(client, agent.id, 4);
      const deniedId = await waitForPermission(client, agent.id, "rm -rf canary.txt");
      expect(await readHooks(client)).toContainEqual(
        expect.objectContaining({
          hook: "agent.permission_resolved",
          data: expect.objectContaining({
            requestId: deniedId,
            resolution: expect.objectContaining({ behavior: "deny" }),
          }),
        }),
      );
      expect(await readFile(path.join(workspace.workspaceDirectory, "canary.txt"), "utf8")).toBe(
        "preserve me\n",
      );
      proof.deniedRequestId = deniedId;
      proof.canaryPreserved = true;

      const envCommand = 'printf \'%s|%s\' "$PASEO_HOOK_CREATE_EXAMPLE" "$PASEO_HOOK_OPEN_EXAMPLE"';
      await client.sendMessage(
        agent.id,
        `Call Bash with exactly this command: ${envCommand}. Reply with its exact output only.`,
      );
      const envPermission = await waitForPermission(client, agent.id, envCommand);
      await client.respondToPermission(agent.id, envPermission, { behavior: "allow" });
      await waitForTurns(client, agent.id, 5);
      const envTurns = await endedTurns(client, agent.id);
      expect(assistantText(envTurns[4].data.timeline)).toBe("created|opened");
      proof.environmentOutput = "created|opened";

      await client.refreshAgent(agent.id);
      await daemon.daemon.agentManager.closeAgent(agent.id);
      await client.sendMessage(agent.id, "Reply exactly RESUMED. Do not use tools.");
      await waitForTurns(client, agent.id, 6);

      await client.sendMessage(
        agent.id,
        "Write a detailed 2000-word essay about binary trees. Do not use tools.",
      );
      await expect
        .poll(
          async () => {
            return (await readHooks(client)).filter((event) => {
              return event.hook === "agent.turn_started" && event.data.agent.id === agent.id;
            }).length;
          },
          { timeout: 30_000 },
        )
        .toBe(7);
      await client.cancelAgent(agent.id);
      await waitForTurns(client, agent.id, 7);
      expect((await endedTurns(client, agent.id))[6].data.outcome.kind).toBe("canceled");
      await client.archiveAgent(agent.id);

      const failed = await client.createAgent({
        provider: "claude",
        model: "haiku",
        cwd: workspace.workspaceDirectory,
        workspaceId: workspace.id,
        title: "Expected runtime crash",
      });
      await client.sendMessage(failed.id, "Reply READY. Do not use tools.");
      await waitForTurns(client, failed.id, 1);
      const rows = execFileSync("ps", ["-eo", "pid=,ppid=,args="], { encoding: "utf8" }).split(
        "\n",
      );
      const providerPids: number[] = [];
      for (const row of rows) {
        const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(row);
        if (match && Number(match[2]) === process.pid && match[3].includes("claude")) {
          const cwd = await readlink(`/proc/${match[1]}/cwd`);
          if (cwd === workspace.workspaceDirectory) {
            providerPids.push(Number(match[1]));
          }
        }
      }
      expect(providerPids).toHaveLength(1);
      const providerPid = providerPids[0];
      await client.sendMessage(
        failed.id,
        "Write a detailed 2000-word essay about binary trees. Do not use tools.",
      );
      process.kill(providerPid, "SIGKILL");
      await waitForTurns(client, failed.id, 2);
      expect((await endedTurns(client, failed.id))[1].data.outcome.kind).toBe("failed");
      proof.crashedProviderPid = providerPid;
      await client.archiveAgent(failed.id);
      await client.archiveWorkspace(workspace.id);
      await expect
        .poll(async () => {
          const names = new Set(
            (await readHooks(client)).map((event) => {
              return event.hook;
            }),
          );
          return [...names].sort();
        })
        .toEqual([
          "agent.archived",
          "agent.created",
          "agent.permission_requested",
          "agent.permission_resolved",
          "agent.turn_ended",
          "agent.turn_started",
          "before agent.create",
          "before agent.session_open",
          "before workspace.create",
          "workspace.archived",
          "workspace.created",
        ]);
      const openReasons = (await readHooks(client))
        .filter((event) => {
          return event.hook === "before agent.session_open";
        })
        .map((event) => {
          return event.data.request.reason;
        });
      expect(openReasons).toContain("create");
      expect(openReasons).toContain("refresh");
      expect(openReasons).toContain("resume");
      proof.passed = true;
    } finally {
      proof.finishedAt = new Date().toISOString();
      await writeFile(path.join(evidenceDirectory, "proof.json"), JSON.stringify(proof, null, 2));
      const logs = await client.getPluginLogs("lifecycle-logger").catch(() => {
        return [];
      });
      await writeFile(
        path.join(evidenceDirectory, "hooks.jsonl"),
        logs
          .filter((entry) => {
            return entry.message.startsWith('{"hook":');
          })
          .map((entry) => {
            return entry.message;
          })
          .join("\n") + "\n",
      );
      await client.close();
      await daemon.close();
      destination.end();
      await rm(fixture, { recursive: true, force: true });
    }
  },
  600_000,
);

function assistantText(timeline: readonly AgentTimelineItem[]): string {
  let text = "";
  for (const item of timeline) {
    if (item.type === "user_message") {
      text = "";
    } else if (item.type === "assistant_message") {
      text += item.text;
    }
  }
  return text;
}
