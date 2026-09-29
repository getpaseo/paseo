import { test, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { DaemonClient } from "./test-utils/index.js";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import { createTestAgentClients } from "./test-utils/fake-agent-client.js";
import { getFullAccessConfig } from "./daemon-e2e/agent-configs.js";

// `paseo run --notify-on-finish` and `paseo send --notify-on-finish` name the
// calling agent on the plain create/send requests. The daemon must then wake
// that caller exactly as agent-scoped MCP create_agent/send_agent_prompt do.

test("CLI create and send wake the calling agent only when asked", async () => {
  // The parent is the only claude agent, so every claude turn is a wake-up.
  const parentPrompts: string[] = [];
  const agentClients = createTestAgentClients();
  const claude = agentClients.claude!;
  const createSession = claude.createSession.bind(claude);
  claude.createSession = async (...args) => {
    const session = await createSession(...args);
    const startTurn = session.startTurn.bind(session);
    session.startTurn = async (prompt, ...rest) => {
      parentPrompts.push(typeof prompt === "string" ? prompt : JSON.stringify(prompt));
      return startTurn(prompt, ...rest);
    };
    return session;
  };

  const daemon = await createTestPaseoDaemon({ agentClients });
  const cwd = mkdtempSync(path.join(tmpdir(), "paseo-cli-notify-"));
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.1.82",
  });

  try {
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    expect(client.getLastServerInfoMessage()?.features?.callerFinishNotifications).toBe(true);

    const workspace = await client.createWorkspace({ source: { kind: "directory", path: cwd } });
    const parent = await client.createAgent({
      ...getFullAccessConfig("claude"),
      cwd,
      workspaceId: workspace.workspace!.id,
      title: "Orchestrator",
    });

    const quietChild = await client.createAgent({
      ...getFullAccessConfig("codex"),
      cwd,
      callerAgentId: parent.id,
      title: "Quiet child",
      initialPrompt: "say done",
    });
    await client.waitForFinish(quietChild.id, 60_000);
    await client.sendAgentMessage(quietChild.id, "say done again", { callerAgentId: parent.id });
    await client.waitForFinish(quietChild.id, 60_000);

    const notifyingChild = await client.createAgent({
      ...getFullAccessConfig("codex"),
      cwd,
      callerAgentId: parent.id,
      notifyOnFinish: true,
      title: "Notifying child",
      initialPrompt: "say done",
    });
    await vi.waitFor(() => expect(parentPrompts).toHaveLength(1), {
      timeout: 60_000,
      interval: 100,
    });
    expect(parentPrompts[0]).toContain(`Agent ${notifyingChild.id} (Notifying child) finished.`);

    await client.sendAgentMessage(quietChild.id, "report back", {
      callerAgentId: parent.id,
      notifyOnFinish: true,
    });
    await vi.waitFor(() => expect(parentPrompts).toHaveLength(2), {
      timeout: 60_000,
      interval: 100,
    });
    expect(parentPrompts[1]).toContain(`Agent ${quietChild.id} (Quiet child) finished.`);

    await expect(
      client.sendAgentMessage(quietChild.id, "report back", {
        callerAgentId: "missing-caller",
        notifyOnFinish: true,
      }),
    ).rejects.toThrow("Caller agent missing-caller not found");
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 180000);
