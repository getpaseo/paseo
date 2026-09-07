import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

test("a plugin transforms workspace creation and observes its committed lifecycle", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-lifecycle-"));
  const daemon = await createTestPaseoDaemon({ daemonVersion: "0.8.0" });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.8.0" });
  try {
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id: "lifecycle", requirements: { paseo: ">=0.8.0" } }),
    );
    await writeFile(
      path.join(directory, "index.server.ts"),
      `
export default function contribute(server) {
  server.before("workspace.create", ({ request }) => {
    return { ...request, title: "Created through a hook" };
  });
  server.on("workspace.created", (event) => {
    console.log(JSON.stringify({ hook: "workspace.created", event }));
  });
  server.on("workspace.archived", (event) => {
    console.log(JSON.stringify({ hook: "workspace.archived", event }));
  });
  return () => {};
}
`,
    );
    await client.connect();
    await client.fetchAgents({ subscribe: { subscriptionId: "lifecycle" } });
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    const created = await client.createWorkspace({
      source: { kind: "directory", path: directory },
    });
    expect(created.workspace?.name).toBe("Created through a hook");
    const workspaceId = created.workspace!.id;
    await client.archiveWorkspace(workspaceId);
    await expect
      .poll(async () => {
        const logs = await client.getPluginLogs("lifecycle");
        return logs
          .filter((entry) => {
            return entry.message.startsWith('{"hook":');
          })
          .map((entry) => {
            return JSON.parse(entry.message);
          });
      })
      .toMatchObject([
        { hook: "workspace.created", event: { workspace: { id: workspaceId, cwd: directory } } },
        { hook: "workspace.archived", event: { workspace: { id: workspaceId } } },
      ]);
  } finally {
    await client.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("plugins observe turns, answer permissions, and observe archive without blocking the agent", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-turn-hooks-"));
  const daemon = await createTestPaseoDaemon({ daemonVersion: "0.8.0" });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.8.0" });
  try {
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id: "turn-hooks", requirements: { paseo: ">=0.8.0" } }),
    );
    await writeFile(
      path.join(directory, "index.server.ts"),
      `
export default function contribute(server) {
  server.on("agent.turn_started", (event) => {
    console.log(JSON.stringify({ hook: "agent.turn_started", event }));
  });
  server.on("agent.turn_ended", (event) => {
    console.log(JSON.stringify({ hook: "agent.turn_ended", event }));
  });
  server.on("agent.permission_requested", async (event, context) => {
    console.log(JSON.stringify({ hook: "agent.permission_requested", event }));
    await context.paseo.agents.ref(event.agent.id).respondToPermission({
      requestId: event.request.id,
      response: { behavior: "deny", message: "Declined by plugin" },
    });
  });
  server.on("agent.permission_resolved", (event) => {
    console.log(JSON.stringify({ hook: "agent.permission_resolved", event }));
  });
  server.on("agent.archived", (event) => {
    console.log(JSON.stringify({ hook: "agent.archived", event }));
  });
  return () => {};
}
`,
    );
    await client.connect();
    await client.fetchAgents({ subscribe: { subscriptionId: "turn-hooks" } });
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    const agent = await client.createAgent({
      provider: "claude",
      cwd: directory,
      title: "Turn hooks",
      modeId: "default",
    });
    await client.sendMessage(agent.id, "Run rm -f permission.txt");
    await expect
      .poll(
        async () => {
          const logs = await client.getPluginLogs("turn-hooks");
          return logs
            .filter((entry) => {
              return entry.message.startsWith('{"hook":');
            })
            .map((entry) => {
              return JSON.parse(entry.message);
            })
            .sort((left, right) => {
              return left.hook.localeCompare(right.hook);
            });
        },
        { timeout: 10_000 },
      )
      .toMatchObject([
        {
          hook: "agent.permission_requested",
          event: { request: { input: { command: "rm -f permission.txt" } } },
        },
        { hook: "agent.permission_resolved", event: { resolution: { behavior: "deny" } } },
        {
          hook: "agent.turn_ended",
          event: { outcome: { kind: "completed" }, timeline: expect.any(Array) },
        },
        { hook: "agent.turn_started", event: { agent: { id: agent.id } } },
      ]);
    await client.archiveAgent(agent.id);
    await expect
      .poll(async () => {
        const logs = await client.getPluginLogs("turn-hooks");
        return logs.filter((entry) => {
          return entry.message.startsWith('{"hook":"agent.archived"');
        }).length;
      })
      .toBe(1);
  } finally {
    await client.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("agent creation hooks change the provider and environment before the session opens", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-agent-hooks-"));
  const daemon = await createTestPaseoDaemon({ daemonVersion: "0.8.0" });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.8.0" });
  try {
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id: "agent-hooks", requirements: { paseo: ">=0.8.0" } }),
    );
    await writeFile(
      path.join(directory, "index.server.ts"),
      `
export default function contribute(server) {
  server.before("agent.create", ({ request }) => {
    return { ...request, config: { ...request.config, provider: "codex" }, env: { ...request.env, HOOK_CREATE: "created" } };
  });
  server.before("agent.session_open", ({ request }) => {
    console.log(JSON.stringify({ hook: "agent.session_open", request }));
    return { ...request, env: { ...request.env, HOOK_OPEN: "opened" } };
  });
  server.on("agent.created", (event) => {
    console.log(JSON.stringify({ hook: "agent.created", event }));
  });
  return () => {};
}
`,
    );
    await client.connect();
    await client.fetchAgents({ subscribe: { subscriptionId: "agent-hooks" } });
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    const agent = await client.createAgent({
      provider: "claude",
      cwd: directory,
      title: "Hook test",
    });
    expect(agent.provider).toBe("codex");
    await expect
      .poll(async () => {
        const logs = await client.getPluginLogs("agent-hooks");
        return logs
          .filter((entry) => {
            return entry.message.startsWith('{"hook":');
          })
          .map((entry) => {
            return JSON.parse(entry.message);
          });
      })
      .toMatchObject([
        {
          hook: "agent.session_open",
          request: { agentId: agent.id, env: { HOOK_CREATE: "created" } },
        },
        { hook: "agent.created", event: { agent: { id: agent.id, provider: "codex" } } },
      ]);
    await client.archiveAgent(agent.id);
  } finally {
    await client.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("invalid output from an untyped plugin rejects creation before later callbacks run", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-invalid-hook-"));
  const daemon = await createTestPaseoDaemon({ daemonVersion: "0.8.0" });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.8.0" });
  try {
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id: "invalid-hook", requirements: { paseo: ">=0.8.0" } }),
    );
    await writeFile(
      path.join(directory, "index.server.ts"),
      `
export default function contribute(server) {
  server.before("workspace.create", () => {
    return { source: { kind: "worktree", branchName: 42 } };
  });
  server.before("workspace.create", ({ request }) => {
    console.log("Unexpected later callback");
    return request;
  });
  return () => {};
}
`,
    );
    await client.connect();
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    const result = await client.createWorkspace({ source: { kind: "directory", path: directory } });
    expect(result.workspace).toBeNull();
    expect(result.error).toContain("Plugin invalid-hook before workspace.create failed");
    const logs = await client.getPluginLogs("invalid-hook");
    expect(
      logs.some((entry) => {
        return entry.message.includes("Unexpected later callback");
      }),
    ).toBe(false);
  } finally {
    await client.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
