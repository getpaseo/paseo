import { connectDaemonClient } from "./daemon-client-loader";
import { startIsolatedHostDaemon } from "./isolated-host-daemon";
import { seedWorkspace } from "./seed-client";
import { getE2EDaemonPort } from "./daemon-port";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { expect, type Page } from "@playwright/test";
import { daemonWsRoutePattern } from "./daemon-port";
import type { SeededWorkspace } from "./seed-client";

type WebSocketMessage = string | Buffer;

export interface ManagedSubagentArchiveGate {
  release(): void;
  waitForRequest(): Promise<void>;
}

export interface ManagedSubagentArchiveRejection {
  waitForRejection(): Promise<void>;
}

export interface SeededSubagentPair {
  parent: {
    id: string;
    title: string;
  };
  child: {
    id: string;
    title: string;
  };
  workspaceId: string;
}

export interface SeededCrossWorkspaceSubagentPair {
  parent: {
    id: string;
    workspaceId: string;
  };
  child: {
    id: string;
    workspaceId: string;
  };
}

export async function seedParentWithSubagent(
  workspace: Pick<SeededWorkspace, "client" | "repoPath" | "workspaceId">,
  input: { parentTitle: string; childTitle: string },
): Promise<SeededSubagentPair> {
  const parent = await workspace.client.createAgent({
    provider: "mock",
    cwd: workspace.repoPath,
    workspaceId: workspace.workspaceId,
    title: input.parentTitle,
    modeId: "load-test",
    model: "ten-second-stream",
  });
  const child = await seedSubagent(workspace, { parentId: parent.id, title: input.childTitle });

  return {
    parent: {
      id: parent.id,
      title: input.parentTitle,
    },
    child,
    workspaceId: workspace.workspaceId,
  };
}

/** Seeds an idle Paseo subagent of an existing agent in the same workspace. */
export async function seedSubagent(
  workspace: Pick<SeededWorkspace, "client" | "repoPath" | "workspaceId">,
  input: { parentId: string; title: string },
): Promise<{ id: string; title: string }> {
  const child = await workspace.client.createAgent({
    provider: "mock",
    cwd: workspace.repoPath,
    workspaceId: workspace.workspaceId,
    title: input.title,
    modeId: "load-test",
    model: "ten-second-stream",
    labels: {
      [PARENT_AGENT_ID_LABEL]: input.parentId,
    },
  });
  return { id: child.id, title: input.title };
}

export async function seedParentWithCrossWorkspaceSubagent(
  workspace: Pick<SeededWorkspace, "client" | "repoPath" | "workspaceId" | "projectId">,
  input: { parentTitle: string; childTitle: string },
): Promise<SeededCrossWorkspaceSubagentPair> {
  const parent = await workspace.client.createAgent({
    provider: "mock",
    cwd: workspace.repoPath,
    workspaceId: workspace.workspaceId,
    title: input.parentTitle,
    modeId: "load-test",
    model: "ten-second-stream",
  });
  const createdWorkspace = await workspace.client.createWorkspace({
    source: {
      kind: "directory",
      path: workspace.repoPath,
      projectId: workspace.projectId,
    },
    title: "Subagent workspace",
  });
  if (!createdWorkspace.workspace) {
    throw new Error(createdWorkspace.error ?? "Failed to create subagent workspace");
  }

  const child = await workspace.client.createAgent({
    provider: "mock",
    cwd: workspace.repoPath,
    workspaceId: createdWorkspace.workspace.id,
    title: input.childTitle,
    modeId: "load-test",
    model: "five-minute-stream",
    initialPrompt: "stay running",
    labels: {
      [PARENT_AGENT_ID_LABEL]: parent.id,
    },
  });
  await workspace.client.waitForAgentUpsert(
    child.id,
    (snapshot) => snapshot.status === "running",
    15_000,
  );

  return {
    parent: {
      id: parent.id,
      workspaceId: workspace.workspaceId,
    },
    child: {
      id: child.id,
      workspaceId: createdWorkspace.workspace.id,
    },
  };
}

/**
 * Opens the subagents panel, and leaves it open if it already is — the pill is a toggle, and a
 * second click would close the thing the caller is about to assert on. The panel also closes on
 * its own whenever a row navigates away, so a flow that comes back to the parent reopens it.
 */
export async function openSubagentsTrack(page: Page): Promise<void> {
  const panel = page.getByTestId("subagents-track-header-panel");
  if ((await panel.count()) === 0) {
    await page.getByTestId("subagents-track-header").click();
  }
  await expect(panel).toBeVisible({ timeout: 30_000 });
}

/** On compact the track opens as a sheet, which closes once a row is chosen. */
export async function openSubagentFromCompactTrack(page: Page, childId: string): Promise<void> {
  await page.getByTestId("subagents-track-header").click();
  await page.getByTestId(`subagents-track-row-${childId}`).click();
}

export async function expectSubagentRowVisible(page: Page, childId: string): Promise<void> {
  await expect(page.getByTestId(`subagents-track-row-${childId}`)).toBeVisible({
    timeout: 30_000,
  });
}

export async function expectSubagentRowGone(page: Page, childId: string): Promise<void> {
  await expect(page.getByTestId(`subagents-track-row-${childId}`)).toHaveCount(0, {
    timeout: 30_000,
  });
}

export async function expectManagedSubagentUnarchived(
  workspace: { client: Pick<SeededWorkspace["client"], "fetchAgent"> },
  childId: string,
): Promise<void> {
  await expect(workspace.client.fetchAgent({ agentId: childId })).resolves.toMatchObject({
    agent: { id: childId, archivedAt: null },
  });
}

export async function expectManagedSubagentArchived(
  workspace: { client: Pick<SeededWorkspace["client"], "fetchAgent"> },
  childId: string,
): Promise<void> {
  await expect
    .poll(() => workspace.client.fetchAgent({ agentId: childId }), { timeout: 30_000 })
    .toMatchObject({ agent: { id: childId, archivedAt: expect.any(String) } });
}

export async function archiveFinishedSubagents(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Archive finished subagents" }).click();
}

export async function expectArchiveFinishedInProgress(
  page: Page,
  completed: number,
  total: number,
): Promise<void> {
  await expect(page.getByRole("button", { name: "Archive finished subagents" })).toBeDisabled();
  await expect(page.getByText(`${completed}/${total}`, { exact: true })).toBeVisible();
}

export async function expectArchiveFinishedRetry(
  page: Page,
  failed: number,
  total: number,
): Promise<void> {
  await expect(page.getByText(`Retry (${failed}/${total})`, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Archive finished subagents" })).toBeEnabled();
}

export async function holdManagedSubagentArchiveRequest(
  page: Page,
  subagentId: string,
): Promise<ManagedSubagentArchiveGate> {
  let released = false;
  let resolveRequest: (() => void) | undefined;
  const delayedForwards: Array<() => void> = [];
  const request = new Promise<void>((resolve) => {
    resolveRequest = resolve;
  });

  await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      if (isArchiveRequestForSubagent(message, subagentId) && !released) {
        delayedForwards.push(() => server.send(message));
        resolveRequest?.();
        return;
      }
      server.send(message);
    });
    server.onMessage((message) => ws.send(message));
  });

  return {
    release() {
      released = true;
      for (const forward of delayedForwards.splice(0)) forward();
    },
    waitForRequest: () => request,
  };
}

export async function rejectNextManagedSubagentArchiveRequest(
  page: Page,
  subagentId: string,
): Promise<ManagedSubagentArchiveRejection> {
  let resolveRejection: (() => void) | undefined;
  const rejection = new Promise<void>((resolve) => {
    resolveRejection = resolve;
  });
  let rejected = false;

  await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      const requestId = archiveRequestId(message, subagentId);
      if (requestId && !rejected) {
        rejected = true;
        // A daemon-rejected archive RPC: the request never reaches the daemon, and its normal
        // correlated error travels back through the real browser client and mutation rollback.
        ws.send(
          JSON.stringify({
            type: "session",
            message: {
              type: "rpc_error",
              payload: {
                requestId,
                requestType: "archive_agent_request",
                error: "Archive rejected for test",
                code: "archive_rejected",
              },
            },
          }),
        );
        resolveRejection?.();
        return;
      }
      server.send(message);
    });
    server.onMessage((message) => ws.send(message));
  });

  return { waitForRejection: () => rejection };
}

function isArchiveRequestForSubagent(message: WebSocketMessage, subagentId: string): boolean {
  return archiveRequestId(message, subagentId) !== null;
}

function archiveRequestId(message: WebSocketMessage, subagentId: string): string | null {
  const rawMessage = typeof message === "string" ? message : message.toString("utf8");
  try {
    const envelope = JSON.parse(rawMessage) as {
      type?: unknown;
      message?: { type?: unknown; agentId?: unknown; requestId?: unknown };
    };
    if (
      envelope.type === "session" &&
      envelope.message?.type === "archive_agent_request" &&
      envelope.message.agentId === subagentId &&
      typeof envelope.message.requestId === "string"
    ) {
      return envelope.message.requestId;
    }
    return null;
  } catch {
    return null;
  }
}

export async function detachSubagentFromTrack(page: Page, childId: string): Promise<void> {
  const row = page.getByTestId(`subagents-track-row-${childId}`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.hover();

  page.once("dialog", (dialog) => {
    expect(dialog.message()).toContain("Detach subagent?");
    void dialog.accept();
  });

  const detachButton = page.getByTestId(`subagents-track-detach-${childId}`);
  await expect(detachButton).toBeVisible({ timeout: 30_000 });
  await detachButton.click();
}

/** The primary children come from the real agent MCP endpoint on A. */
export async function delegateFleetThroughMcp() {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } =
    await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const { z } = await import("zod");
  type DaemonClient = import("@getpaseo/client/internal/daemon-client").DaemonClient;
  const workspace = await seedWorkspace({ repoPrefix: "fleet-mcp-" });
  const destination = await startIsolatedHostDaemon(`fleet_${crypto.randomUUID()}`);
  const a = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "fleet-seed-A" });
  const b = await connectDaemonClient<DaemonClient>({
    clientIdPrefix: "fleet-observe-B",
    port: destination.port,
  });
  const serverId = a.getLastServerInfoMessage()!.serverId;
  const mcp = new Client({ name: "fleet-parent", version: "1" });
  const close = async () => {
    await mcp.close();
    await Promise.allSettled([a.close(), b.close()]);
    await destination.close();
    await workspace.cleanup();
  };
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await mcp.callTool({ name, arguments: args });
    expect(response, name).not.toMatchObject({ isError: true });
    return z.record(z.string(), z.unknown()).parse(response.structuredContent);
  };
  try {
    const parent = await a.createAgent({
      provider: "mock",
      model: "e2e-fast-stream",
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: "Fleet parent",
      modeId: "load-test",
    });
    const registration = await a.addHost({
      connection: `127.0.0.1:${destination.port}`,
      label: "Fleet B",
    });
    await expect
      .poll(
        async () =>
          (await a.listHosts()).hosts.find(
            (row) => row.registrationId === registration.registrationId,
          )?.status,
      )
      .toBe("online");
    await mcp.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${getE2EDaemonPort()}/mcp/agents?callerAgentId=${parent.id}`),
      ),
    );
    expect(await call("list_hosts")).toMatchObject({
      hosts: expect.arrayContaining([
        expect.objectContaining({ serverId: destination.serverId, label: "Fleet B" }),
      ]),
    });
    const target = await call("create_workspace", {
      serverId: destination.serverId,
      isolation: "local",
      path: workspace.repoPath,
      title: "B workspace",
    });
    expect(await call("list_workspaces", { serverId: destination.serverId })).toMatchObject({
      workspaces: expect.arrayContaining([
        expect.objectContaining({ workspaceId: target.workspaceId }),
      ]),
    });
    const createChild = async (targetServerId: string, workspaceId: string, title: string) => {
      const result = await call("create_agent", {
        serverId: targetServerId,
        workspaceId,
        title,
        provider: "mock/e2e-fast-stream",
        settings: { modeId: "load-test" },
        initialPrompt: `Finish ${title}`,
      });
      return {
        serverId: targetServerId,
        agentId: z.string().parse(result.agentId),
        workspaceId,
        title,
      };
    };
    const local = await createChild(serverId, workspace.workspaceId, "MCP child on A");
    const remote = await createChild(
      destination.serverId,
      z.string().parse(target.workspaceId),
      "MCP child on B",
    );
    // Existing SDK reservation creates unrelated equal-ID fixtures; primary children remain MCP-created.
    await b.createAgent({
      agentId: local.agentId,
      provider: "mock",
      model: "e2e-fast-stream",
      cwd: workspace.repoPath,
      workspaceId: String(target.workspaceId),
      title: "Unrelated on B",
      modeId: "load-test",
    });
    await a.createAgent({
      agentId: remote.agentId,
      provider: "mock",
      model: "e2e-fast-stream",
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: "Unrelated on A",
      modeId: "load-test",
    });
    return {
      workspace,
      destination,
      parent,
      serverId,
      local,
      remote,
      a,
      b,
      close,
      async expectCompletion(child: typeof local) {
        await expect
          .poll(async () => {
            const timeline = await a.fetchAgentTimeline(parent.id, {
              direction: "tail",
              limit: 100,
            });
            return timeline.entries
              .flatMap(({ item }) =>
                item.type === "tool_call" && item.agentMessage ? [item.agentMessage] : [],
              )
              .filter(
                (message) =>
                  message.event === "finished" &&
                  message.sender.id === child.agentId &&
                  message.text.includes(`Server: ${child.serverId}`),
              ).length;
          })
          .toBe(1);
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
