import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";

import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";

const CREATED_AT = "2026-11-04T08:00:00.000Z";
const UPDATED_AT = "2026-11-04T09:00:00.000Z";

test("parent archive publishes the detached stored survivor to subscribed clients", async () => {
  const fixture = seedFixture();
  let daemon: TestPaseoDaemon | null = null;
  let observer: DaemonClient | null = null;
  let actor: DaemonClient | null = null;
  try {
    daemon = await createTestPaseoDaemon({ paseoHomeRoot: fixture.paseoHomeRoot, cleanup: false });
    const url = `ws://127.0.0.1:${daemon.port}/ws`;
    observer = new DaemonClient({ url });
    actor = new DaemonClient({ url });
    await observer.connect();
    await actor.connect();

    const updates: Array<{ id: string; labels: Record<string, string> }> = [];
    observer.subscribeRawMessages((message: SessionOutboundMessage) => {
      if (message.type === "agent_update" && message.payload.kind === "upsert") {
        updates.push({ id: message.payload.agent.id, labels: message.payload.agent.labels });
      }
    });
    await observer.fetchAgents({ filter: { includeBackground: true }, subscribe: {} });

    // A child already detached by hand remains independent of the parent archive.
    await actor.detachAgent("child-manual");
    await actor.archiveAgent("parent");

    const survivor = await actor.fetchAgent({ agentId: "child-survivor" });
    expect(survivor?.agent.archivedAt).toBeNull();
    expect(survivor?.agent.labels).toEqual({});
    await expect
      .poll(() => updates.findLast((update) => update.id === "child-survivor")?.labels)
      .toEqual({});
    const manual = await actor.fetchAgent({ agentId: "child-manual" });
    expect(manual?.agent.archivedAt).toBeNull();
    expect(manual?.agent.labels).toEqual({});
  } finally {
    await observer?.close().catch(() => undefined);
    await actor?.close().catch(() => undefined);
    await daemon?.close().catch(() => undefined);
    for (const target of fixture.cleanupPaths) rmSync(target, { recursive: true, force: true });
  }
});

function seedFixture() {
  const artifacts = path.join(process.cwd(), ".artifacts");
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(path.join(artifacts, "archive-detach-"));
  const parentCwd = path.join(root, "parent");
  const childCwd = path.join(root, "child");
  const paseoHomeRoot = path.join(root, "home");
  mkdirSync(parentCwd);
  mkdirSync(childCwd);
  const paseoHome = path.join(paseoHomeRoot, ".paseo");
  const projectsDir = path.join(paseoHome, "projects");
  const agentsDir = path.join(paseoHome, "agents");
  mkdirSync(projectsDir, { recursive: true });
  mkdirSync(agentsDir, { recursive: true });
  const project = (projectId: string, rootPath: string) => ({
    projectId,
    rootPath,
    kind: "non_git",
    displayName: projectId,
    customName: null,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    archivedAt: null,
  });
  const workspace = (workspaceId: string, projectId: string, cwd: string) => ({
    workspaceId,
    projectId,
    cwd,
    kind: "directory",
    displayName: workspaceId,
    title: null,
    branch: null,
    baseBranch: null,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    archivedAt: null,
  });
  writeJson(path.join(projectsDir, "projects.json"), [
    project("proj-parent", parentCwd),
    project("proj-child", childCwd),
  ]);
  writeJson(path.join(projectsDir, "workspaces.json"), [
    workspace("ws-parent", "proj-parent", parentCwd),
    workspace("ws-child", "proj-child", childCwd),
  ]);
  const agent = (id: string, cwd: string, workspaceId: string, labels: Record<string, string>) => ({
    id,
    provider: "codex",
    cwd,
    workspaceId,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    lastActivityAt: UPDATED_AT,
    lastUserMessageAt: null,
    title: id,
    labels,
    lastStatus: "closed",
    lastModeId: "full-access",
    config: null,
    persistence: null,
  });
  // Both children live in another workspace, so the parent's archive detaches rather than archives them.
  writeJson(path.join(agentsDir, "parent.json"), agent("parent", parentCwd, "ws-parent", {}));
  writeJson(
    path.join(agentsDir, "child-survivor.json"),
    agent("child-survivor", childCwd, "ws-child", { [PARENT_AGENT_ID_LABEL]: "parent" }),
  );
  writeJson(
    path.join(agentsDir, "child-manual.json"),
    agent("child-manual", childCwd, "ws-child", { [PARENT_AGENT_ID_LABEL]: "parent" }),
  );
  return { paseoHomeRoot, cleanupPaths: [root] };
}

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
