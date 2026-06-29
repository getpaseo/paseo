import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";

const CREATED_AT = "2026-06-29T11:12:42.000Z";
const HEALTHY_UPDATED_AT = "2026-06-29T11:40:00.000Z";
const ORPHAN_ARCHIVED_AT = "2026-06-29T11:35:35.000Z";

interface StaleAgentFixture {
  healthyProjectId: string;
  healthyWorkspaceId: string;
  orphanWorkspaceId: string;
  healthyAgentId: string;
  orphanAgentId: string;
  paseoHomeRoot: string;
  cleanupPaths: string[];
}

test("agent fetch RPCs tolerate an agent whose workspace project record is gone", async () => {
  const fixture = seedStaleAgentFixture();
  let daemon: TestPaseoDaemon | null = null;
  let client: DaemonClient | null = null;

  try {
    daemon = await createTestPaseoDaemon({ paseoHomeRoot: fixture.paseoHomeRoot, cleanup: false });
    client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    await client.connect();

    const agents = await client.fetchAgents({
      requestId: "req-agent-rpc-list",
      filter: { includeArchived: true },
    });
    const history = await client.fetchAgentHistory({
      requestId: "req-agent-rpc-history",
    });
    const orphanAgent = await client.fetchAgent({
      requestId: "req-agent-rpc-detail",
      agentId: fixture.orphanAgentId,
    });

    expect(agents.entries.map(toAgentEntrySummary)).toEqual([healthyAgentSummary(fixture)]);
    expect(agents.pageInfo).toEqual({
      nextCursor: null,
      prevCursor: null,
      hasMore: false,
    });
    expect(history.entries.map(toAgentEntrySummary)).toEqual([healthyAgentSummary(fixture)]);
    expect(history.pageInfo).toEqual({
      nextCursor: null,
      prevCursor: null,
      hasMore: false,
    });
    expect({
      agentId: orphanAgent?.agent.id,
      workspaceId: orphanAgent?.agent.workspaceId,
      archivedAt: orphanAgent?.agent.archivedAt,
      project: orphanAgent?.project,
    }).toEqual({
      agentId: fixture.orphanAgentId,
      workspaceId: fixture.orphanWorkspaceId,
      archivedAt: ORPHAN_ARCHIVED_AT,
      project: null,
    });
  } finally {
    await client?.close().catch(() => undefined);
    await daemon?.close().catch(() => undefined);
    for (const target of fixture.cleanupPaths) {
      rmSync(target, { recursive: true, force: true });
    }
  }
});

function seedStaleAgentFixture(): StaleAgentFixture {
  const healthyCwd = mkdtempSync(path.join(os.tmpdir(), "paseo-healthy-agent-"));
  const orphanCwd = mkdtempSync(path.join(os.tmpdir(), "paseo-orphan-agent-"));
  const paseoHomeRoot = mkdtempSync(path.join(os.tmpdir(), "paseo-orphan-agent-home-"));
  const paseoHome = path.join(paseoHomeRoot, ".paseo");
  const projectsDir = path.join(paseoHome, "projects");
  const agentsDir = path.join(paseoHome, "agents");
  const healthyProjectId = "proj-healthy-agent-rpc";
  const healthyWorkspaceId = "ws-healthy-agent-rpc";
  const orphanWorkspaceId = "c:\\Users\\paseo\\stale-project";
  const orphanProjectId = "proj-removed-agent-rpc";
  const healthyAgentId = "agent-healthy-rpc";
  const orphanAgentId = "agent-orphan-rpc";

  mkdirSync(projectsDir, { recursive: true });
  mkdirSync(agentsDir, { recursive: true });
  writeJson(path.join(projectsDir, "projects.json"), [
    {
      projectId: healthyProjectId,
      rootPath: healthyCwd,
      kind: "non_git",
      displayName: "healthy",
      customName: null,
      createdAt: CREATED_AT,
      updatedAt: HEALTHY_UPDATED_AT,
      archivedAt: null,
    },
  ]);
  writeJson(path.join(projectsDir, "workspaces.json"), [
    {
      workspaceId: healthyWorkspaceId,
      projectId: healthyProjectId,
      cwd: healthyCwd,
      kind: "directory",
      displayName: "healthy",
      title: null,
      branch: null,
      baseBranch: null,
      createdAt: CREATED_AT,
      updatedAt: HEALTHY_UPDATED_AT,
      archivedAt: null,
    },
    {
      workspaceId: orphanWorkspaceId,
      projectId: orphanProjectId,
      cwd: orphanCwd,
      kind: "directory",
      displayName: "stale project",
      title: null,
      branch: null,
      baseBranch: null,
      createdAt: CREATED_AT,
      updatedAt: ORPHAN_ARCHIVED_AT,
      archivedAt: ORPHAN_ARCHIVED_AT,
    },
  ]);
  writeJson(path.join(agentsDir, `${healthyAgentId}.json`), {
    id: healthyAgentId,
    provider: "codex",
    cwd: healthyCwd,
    workspaceId: healthyWorkspaceId,
    createdAt: CREATED_AT,
    updatedAt: HEALTHY_UPDATED_AT,
    lastActivityAt: HEALTHY_UPDATED_AT,
    lastUserMessageAt: null,
    title: "Healthy Agent",
    labels: {},
    lastStatus: "idle",
    lastModeId: "full-access",
    config: null,
    persistence: null,
  });
  writeJson(path.join(agentsDir, `${orphanAgentId}.json`), {
    id: orphanAgentId,
    provider: "codex",
    cwd: orphanCwd,
    workspaceId: orphanWorkspaceId,
    createdAt: CREATED_AT,
    updatedAt: ORPHAN_ARCHIVED_AT,
    lastActivityAt: ORPHAN_ARCHIVED_AT,
    lastUserMessageAt: null,
    title: "Orphaned Archived Agent",
    labels: {},
    lastStatus: "closed",
    lastModeId: "full-access",
    config: null,
    persistence: null,
    archivedAt: ORPHAN_ARCHIVED_AT,
  });

  return {
    healthyProjectId,
    healthyWorkspaceId,
    orphanWorkspaceId,
    healthyAgentId,
    orphanAgentId,
    paseoHomeRoot,
    cleanupPaths: [healthyCwd, orphanCwd, paseoHomeRoot],
  };
}

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

interface AgentDirectoryEntrySummaryInput {
  agent: {
    id: string;
    workspaceId?: string;
    archivedAt?: string | null;
  };
  project: {
    projectKey: string;
    projectName: string;
    workspaceName?: string | null;
  };
}

function healthyAgentSummary(fixture: StaleAgentFixture) {
  return {
    agentId: fixture.healthyAgentId,
    workspaceId: fixture.healthyWorkspaceId,
    archivedAt: null,
    projectKey: fixture.healthyProjectId,
    projectName: "healthy",
    workspaceName: "healthy",
  };
}

function toAgentEntrySummary(entry: AgentDirectoryEntrySummaryInput) {
  return {
    agentId: entry.agent.id,
    workspaceId: entry.agent.workspaceId,
    archivedAt: entry.agent.archivedAt ?? null,
    projectKey: entry.project.projectKey,
    projectName: entry.project.projectName,
    workspaceName: entry.project.workspaceName ?? null,
  };
}
