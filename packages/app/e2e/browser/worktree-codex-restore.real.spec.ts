import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { test as base, expect, type Page } from "../support/fixtures";
import { buildHostAgentDetailRoute } from "@/utils/host-routes";
import { openSessions } from "../support/helpers/archive-tab";
import { getE2EDaemonPort } from "../support/helpers/daemon-port";
import { assertComposerIdle } from "../support/helpers/rewind-flow";
import { getServerId } from "../support/helpers/server-id";
import {
  archiveWorkspaceFromSidebar,
  expectWorkspaceAbsentFromSidebar,
} from "../support/helpers/sidebar";
import { createTempGitRepo } from "../support/helpers/workspace";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

const REPLY = "CODEX_WORKTREE_RESTORE_READY";
// This diagnosis owns cleanup so failed state can be retained for inspection.
const test = base.extend({
  projectOwnership: async ({ e2eWorkerClient }, provide) => {
    void e2eWorkerClient;
    await provide();
  },
});
const workspaceSchema = z.object({
  workspaceId: z.string(),
  projectId: z.string(),
  cwd: z.string(),
  isolation: z.literal("worktree"),
});

async function callPaseoTool(
  mcp: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const result = await mcp.callTool({ name, arguments: args }, undefined, { timeout: 240_000 });
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  return result.structuredContent;
}

async function openArchivedWorkspaceFromHistory(page: Page, agentId: string): Promise<void> {
  await openSessions(page);
  const row = page.getByTestId(`agent-row-${getServerId()}-${agentId}`);
  await expect(row).toContainText("Archived");
  await row.click();
  await expect(page.getByText("Workspace archived", { exact: true })).toBeVisible();
}

async function defaultCodexModel(mcp: Client): Promise<string> {
  const result = z
    .object({
      models: z.array(z.object({ id: z.string(), isDefault: z.boolean() })),
    })
    .parse(await callPaseoTool(mcp, "list_models", { provider: "codex" }));
  const model = result.models.find((entry) => entry.isDefault);
  if (!model) throw new Error("Codex did not advertise a default model");
  return model.id;
}

async function restoreWorkspace(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(page.getByText("Workspace archived", { exact: true })).toHaveCount(0, {
    timeout: 60_000,
  });
}

async function unarchiveAgent(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Unarchive", exact: true }).click({ timeout: 30_000 });
  await expect(page.getByText("This agent is archived", { exact: true })).toHaveCount(0, {
    timeout: 60_000,
  });
}

test.use({
  e2eDaemonConfig: { version: 1, daemon: { mcp: { enabled: true } } },
  trace: "on",
  video: "on",
});

async function reloadWithoutAgentCache(page: Page): Promise<void> {
  const url = page.url();
  const cdp = await page.context().newCDPSession(page);
  // Unmount first so an open connection cannot repopulate the cache while it is cleared.
  await page.goto("about:blank");
  await cdp.send("Storage.clearDataForOrigin", {
    origin: new URL(url).origin,
    storageTypes: "indexeddb,cache_storage",
  });
  await cdp.send("Network.clearBrowserCache");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await page.goto(url);
  await cdp.detach();
}

test("a fresh client restores an archived Codex agent across a reload without agent cache", async ({
  page,
  e2eWorkerClient: client,
}, testInfo) => {
  test.setTimeout(600_000);
  const repo = await createTempGitRepo("codex-cold-restore-");
  const mcp = new Client({ name: "codex-cold-restore-playwright", version: "1.0.0" });
  const timelineWire: string[] = [];
  page.on("websocket", (socket) => {
    const recordFrame = (direction: string, message: string) => {
      if (/agent.*timeline|fetch_agents|agent_update/.test(message)) {
        timelineWire.push(JSON.stringify({ at: Date.now(), direction, message }));
      }
    };
    socket.on("framesent", ({ payload }) => recordFrame("sent", payload.toString()));
    socket.on("framereceived", ({ payload }) => recordFrame("received", payload.toString()));
  });
  let workspace: z.infer<typeof workspaceSchema> | undefined;
  let completed = false;
  try {
    await mcp.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${getE2EDaemonPort()}/mcp/agents`),
      ),
    );
    const created =
      await test.step("Create, finish, and archive Codex before this browser connects", async () => {
        workspace = workspaceSchema.parse(
          await callPaseoTool(mcp, "create_workspace", {
            isolation: "worktree",
            path: repo.path,
            baseBranch: "main",
            title: "Cold Codex restore",
          }),
        );
        const { agentId } = z.object({ agentId: z.string() }).parse(
          await callPaseoTool(mcp, "create_agent", {
            workspaceId: workspace.workspaceId,
            provider: `codex/${await defaultCodexModel(mcp)}`,
            settings: { modeId: "full-access", thinkingOptionId: "low" },
            title: "Cold Codex restore",
            initialPrompt: `Reply with exactly ${REPLY} and nothing else. Do not use tools.`,
            background: true,
          }),
        );
        await client.waitForFinish(agentId, 240_000);
        expect((await client.archiveWorkspace(workspace.workspaceId)).error).toBeNull();
        await expect.poll(() => existsSync(workspace!.cwd)).toBe(false);
        await expect
          .poll(() => client.fetchAgent({ agentId }))
          .toMatchObject({ agent: { archivedAt: expect.any(String) } });
        return { ...workspace, agentId };
      });
    await test.step("Connect the fresh browser, open History, and restore the workspace", async () => {
      await page.goto("/");
      await openArchivedWorkspaceFromHistory(page, created.agentId);
      await restoreWorkspace(page);
      await expect(page.getByTestId(`workspace-tab-agent_${created.agentId}`)).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await expect(page.getByText("This agent is archived", { exact: true })).toBeVisible();
      await expect(page.getByTestId("assistant-message")).toContainText(REPLY);
    });
    await test.step("Reload without cached agent data and keep the selected archived agent", async () => {
      await reloadWithoutAgentCache(page);
      await waitForSidebarHydration(page);
      await expect(page.getByTestId(`workspace-tab-agent_${created.agentId}`)).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await expect(page.getByText("This agent is archived", { exact: true })).toBeVisible();
      await expect(page.getByTestId("assistant-message")).toContainText(REPLY);
    });
    await test.step("Unarchive the agent and keep its idle composer after another cache-empty reload", async () => {
      await unarchiveAgent(page);
      await reloadWithoutAgentCache(page);
      await expect
        .poll(() => client.fetchAgent({ agentId: created.agentId }))
        .toMatchObject({ agent: { status: "idle", archivedAt: null } });
      await expect(page.getByTestId(`workspace-tab-agent_${created.agentId}`)).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await assertComposerIdle({ page });
      await expect(page.getByRole("textbox", { name: "Message agent..." })).toBeVisible();
    });
    completed = true;
  } finally {
    await testInfo.attach("cold-client-screen", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    await testInfo.attach("cold-client-timeline-wire", {
      body: timelineWire.join("\n"),
      contentType: "text/plain",
    });
    await testInfo.attach("cold-client-daemon-log", {
      body: await readFile(path.join(process.env.E2E_PASEO_HOME!, "daemon.log")),
      contentType: "text/plain",
    });
    await mcp.close();
    if (completed || process.env.E2E_KEEP_PASEO_HOME !== "1") {
      if (workspace) await client.removeProject(workspace.projectId);
      await repo.cleanup();
    }
  }
});

test("restore an archived worktree, then unarchive its completed Codex agent", async ({
  page,
  e2eWorkerClient: client,
}, testInfo) => {
  test.setTimeout(600_000);
  const repo = await createTempGitRepo("codex-worktree-restore-");
  const mcp = new Client({ name: "worktree-codex-restore-playwright", version: "1.0.0" });
  let workspace: z.infer<typeof workspaceSchema> | undefined;
  let agentId: string | undefined;
  let completed = false;

  try {
    await mcp.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${getE2EDaemonPort()}/mcp/agents`),
      ),
    );
    const created =
      await test.step("1. Create a managed worktree with a real Codex agent through Paseo MCP", async () => {
        workspace = workspaceSchema.parse(
          await callPaseoTool(mcp, "create_workspace", {
            isolation: "worktree",
            path: repo.path,
            baseBranch: "main",
            title: "Codex worktree restore reproduction",
          }),
        );
        const agent = z.object({ agentId: z.string() }).parse(
          await callPaseoTool(mcp, "create_agent", {
            workspaceId: workspace.workspaceId,
            provider: `codex/${await defaultCodexModel(mcp)}`,
            settings: { modeId: "full-access", thinkingOptionId: "low" },
            title: "Codex worktree restore reproduction",
            initialPrompt: `Reply with exactly ${REPLY} and nothing else. Do not use tools.`,
            background: true,
          }),
        );
        agentId = agent.agentId;
        return { ...workspace, agentId };
      });

    await test.step("2. Wait for Codex to finish and show its reply", async () => {
      await page.goto(
        buildHostAgentDetailRoute(getServerId(), created.agentId, created.workspaceId),
      );
      await waitForSidebarHydration(page);
      await expect(page.getByTestId("assistant-message")).toContainText(REPLY, {
        timeout: 240_000,
      });
      await expect
        .poll(() => client.fetchAgent({ agentId: created.agentId }))
        .toMatchObject({
          agent: { status: "idle", archivedAt: null },
        });
      await assertComposerIdle({ page });
    });

    await test.step("3. Archive the workspace from its sidebar menu", async () => {
      await archiveWorkspaceFromSidebar(page, created.workspaceId);
    });

    await test.step("4. Assert workspace and agent are archived and the worktree is removed", async () => {
      await expectWorkspaceAbsentFromSidebar(page, created.workspaceId);
      await expect
        .poll(() => client.fetchAgent({ agentId: created.agentId }))
        .toMatchObject({
          agent: { archivedAt: expect.any(String) },
        });
      await expect.poll(() => existsSync(created.cwd), { timeout: 30_000 }).toBe(false);
      await expect
        .poll(() => client.fetchWorkspaces())
        .not.toMatchObject({
          entries: expect.arrayContaining([expect.objectContaining({ id: created.workspaceId })]),
        });
    });

    await test.step("5. Open the archived workspace from History", async () => {
      await openArchivedWorkspaceFromHistory(page, created.agentId);
    });

    await test.step("6. Restore the workspace", async () => {
      await restoreWorkspace(page);
      await expect.poll(() => existsSync(created.cwd), { timeout: 30_000 }).toBe(true);
      await expect(page.getByTestId(`workspace-tab-agent_${created.agentId}`)).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await expect(page.getByText("This agent is archived", { exact: true })).toBeVisible();
      await testInfo.attach("after-workspace-restore", {
        body: JSON.stringify(await client.fetchAgent({ agentId: created.agentId }), null, 2),
        contentType: "application/json",
      });
    });

    await test.step("7. Click Unarchive on the agent", async () => {
      await unarchiveAgent(page);
    });

    await test.step("8. Expect an idle agent with a visible editable composer", async () => {
      await expect
        .poll(() => client.fetchAgent({ agentId: created.agentId }), { timeout: 60_000 })
        .toMatchObject({ agent: { status: "idle", archivedAt: null } });
      await expect(page.getByTestId(`workspace-tab-agent_${created.agentId}`)).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await expect(page.getByRole("textbox", { name: "Message agent..." })).toBeVisible();
      await assertComposerIdle({ page });
      await testInfo.attach("restored-agent-screen", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
      await testInfo.attach("restored-agent-accessibility", {
        body: await page.locator("body").ariaSnapshot(),
        contentType: "text/plain",
      });
    });
    completed = true;
  } finally {
    await testInfo.attach("final-screen", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    await testInfo.attach("final-agent", {
      body: JSON.stringify(agentId ? await client.fetchAgent({ agentId }) : null, null, 2),
      contentType: "application/json",
    });
    await testInfo.attach("daemon-log", {
      body: await readFile(path.join(process.env.E2E_PASEO_HOME!, "daemon.log")),
      contentType: "text/plain",
    });
    await mcp.close();
    if (completed || process.env.E2E_KEEP_PASEO_HOME !== "1") {
      if (workspace) await client.removeProject(workspace.projectId);
      await repo.cleanup();
    }
  }
});
