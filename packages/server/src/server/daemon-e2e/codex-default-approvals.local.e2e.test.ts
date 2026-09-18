import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import pino from "pino";
import { expect, test, type TestContext } from "vitest";
import { z } from "zod";

import { CodexAppServerAgentClient } from "../agent/providers/codex-app-server-agent.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createMessageCollector } from "../test-utils/message-collector.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { createCodexApprovalFixture } from "../test-utils/codex-approval-fixture.js";

interface ApprovalScenario {
  reviewer: "user" | "auto_review";
  modeId: "auto" | "auto-review";
}

async function createApprovalHarness(context: TestContext, scenario: ApprovalScenario) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-default-approvals-"));
  context.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "workspace");
  await mkdir(cwd);
  await writeFile(
    path.join(cwd, "write-marker.cjs"),
    'require("node:fs").writeFileSync(process.argv[2], "approved");\n',
  );
  const fixture = await createCodexApprovalFixture({ context, root, modeId: scenario.modeId });

  const records: Record<string, unknown>[] = [];
  const logger = pino(
    { level: "trace" },
    new Writable({
      write(chunk, _encoding, callback) {
        const record: Record<string, unknown> = JSON.parse(chunk.toString());
        if (record.msg === "provider.codex.raw_event") records.push(record);
        callback();
      },
    }),
  );
  // Only model output is scripted; Codex, its sandbox, and Paseo's approval path are real.
  const daemon = await createTestPaseoDaemon({
    logger,
    agentClients: {
      codex: new CodexAppServerAgentClient(logger, {
        env: { CODEX_HOME: fixture.codexHome },
        command: { mode: "append", args: ["-c", `approvals_reviewer="${scenario.reviewer}"`] },
      }),
    },
  });
  context.onTestFinished(() => daemon.close());
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  context.onTestFinished(() => client.close());
  const collector = createMessageCollector(client);
  context.onTestFinished(() => collector.unsubscribe());
  const permissionRequests: unknown[] = [];
  context.onTestFinished(
    client.on("agent_permission_request", (message) => permissionRequests.push(message)),
  );
  await client.connect();
  await client.fetchAgents({ subscribe: { subscriptionId: "default-approvals" } });
  const agent = await client.createAgent({
    provider: "codex",
    cwd,
    modeId: scenario.modeId,
    title: "Default Permissions approval regression",
    thinkingOptionId: "low",
    model: "mock-model",
    providerOptions: {
      sandbox_workspace_write: {
        writable_roots: [],
        exclude_slash_tmp: true,
        exclude_tmpdir_env_var: true,
      },
    },
  });
  return { client, agent, root, records, collector, permissionRequests };
}

type ApprovalHarness = Awaited<ReturnType<typeof createApprovalHarness>>;

function approvalPrompt(marker: string): string {
  return [
    `Run exactly: node write-marker.cjs ../${marker}`,
    'Use exec_command with sandbox_permissions="require_escalated" and request approval.',
    "The target is a disposable test file outside the workspace; I authorize this write.",
    "Use no other tool or command and do not change the path or script.",
    "After the command completes, reply DONE. If denied, stop without retrying.",
  ].join(" ");
}

async function expectUserApproval(context: TestContext, harness: ApprovalHarness) {
  const { client, agent, records, collector, root, permissionRequests } = harness;
  records.length = 0;
  collector.clear();
  permissionRequests.length = 0;
  const marker = path.join(root, "user-approved.txt");
  await client.sendAgentMessage(agent.id, approvalPrompt("user-approved.txt"));
  const pending = await client.waitForFinish(agent.id, 120_000);
  context.task.meta.beforeUserResponse = structuredClone({
    status: pending.status,
    fileExists: existsSync(marker),
    records,
  });
  expect(pending.status).toBe("permission");

  // A second RPC observes the same unresolved request before the client responds.
  const before = await client.fetchAgent({ agentId: agent.id });
  assert(before, "The agent must remain available while waiting for approval");
  const snapshot = before.agent;
  expect(snapshot.currentModeId).toBe("auto");
  expect(snapshot.pendingPermissions).toHaveLength(1);
  expect(snapshot.pendingPermissions).toEqual(pending.final?.pendingPermissions);
  context.task.meta.pendingApproval = structuredClone({
    pendingPermissions: snapshot.pendingPermissions,
    websocketMessages: collector.messages,
  });
  const permission = snapshot.pendingPermissions[0];
  expect(permission.kind).toBe("tool");
  expect(existsSync(marker)).toBe(false);
  const threadId = z.string().parse(permission.metadata?.threadId);
  expect(records).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        method: "item/commandExecution/requestApproval",
        params: expect.objectContaining({
          threadId,
          command: expect.stringContaining("write-marker.cjs"),
        }),
      }),
    ]),
  );
  expect(records.map((record) => record.method)).not.toContain("item/autoApprovalReview/started");
  expect(permissionRequests).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "agent_permission_request",
        payload: expect.objectContaining({ agentId: agent.id }),
      }),
    ]),
  );

  await client.respondToPermission(agent.id, permission.id, { behavior: "allow" });
  await client.waitForAgentUpsert(agent.id, (state) => state.pendingPermissions.length === 0);
  const finished = await client.waitForFinish(agent.id, 120_000);
  expect(finished.status).toBe("idle");
  expect(readFileSync(marker, "utf8")).toBe("approved");
  const after = await client.fetchAgent({ agentId: agent.id });
  assert(after, "The agent must remain available after approval");
  expect(after.agent.pendingPermissions).toEqual([]);
  context.task.meta.afterUserResponse = {
    threadId,
    requestId: permission.id,
    decision: "allow",
    status: finished.status,
    fileContent: readFileSync(marker, "utf8"),
    pendingPermissions: after.agent.pendingPermissions,
  };
  return threadId;
}

test("Default Permissions waits for the user with global auto-review configured", async (context) => {
  const harness = await createApprovalHarness(context, { reviewer: "auto_review", modeId: "auto" });
  await expectUserApproval(context, harness);
}, 300_000);

test("switching from Auto-review to Default waits for the user on the same thread", async (context) => {
  const harness = await createApprovalHarness(context, { reviewer: "user", modeId: "auto-review" });
  const { client, agent, records, root, permissionRequests } = harness;
  await client.sendAgentMessage(agent.id, approvalPrompt("auto-approved.txt"));
  const first = await client.waitForFinish(agent.id, 120_000);
  expect(first.status).toBe("idle");
  expect(readFileSync(path.join(root, "auto-approved.txt"), "utf8")).toBe("approved");
  expect(records.map((record) => record.method)).toContain("item/autoApprovalReview/completed");
  expect(permissionRequests).toEqual([]);
  const threadId = z
    .string()
    .parse(records.find((record) => record.method === "turn/started")?.sessionId);
  context.task.meta.autoReviewTurn = structuredClone({ threadId, records });
  await client.setAgentMode(agent.id, "auto");
  expect(await expectUserApproval(context, harness)).toBe(threadId);
  expect(records.map((record) => record.method)).not.toContain("thread/started");
}, 420_000);
