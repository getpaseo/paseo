import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import type { TestInfo } from "@playwright/test";
import { test as base, expect, type Page } from "../fixtures";
import { buildHostAgentDetailRoute } from "@/utils/host-routes";
import { openSessions } from "./archive-tab";
import { getE2EDaemonPort } from "./daemon-port";
import { assertComposerIdle } from "./rewind-flow";
import { getServerId } from "./server-id";
import { archiveWorkspaceFromSidebar, expectWorkspaceAbsentFromSidebar } from "./sidebar";
import { createTempGitRepo } from "./workspace";
import { waitForSidebarHydration } from "./workspace-ui";
import type { SeedDaemonClient } from "./seed-client";

const REPLY = "CODEX_WORKTREE_RESTORE_READY";
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
  expect(result).not.toMatchObject({ isError: true });
  return result.structuredContent;
}

async function defaultCodexModel(mcp: Client): Promise<string> {
  const result = z
    .object({ models: z.array(z.object({ id: z.string(), isDefault: z.boolean() })) })
    .parse(await callPaseoTool(mcp, "list_models", { provider: "codex" }));
  const model = result.models.find((entry) => entry.isDefault);
  if (!model) throw new Error("Codex did not advertise a default model");
  return model.id;
}

function recordTimelineWire(page: Page): string[] {
  const wire: string[] = [];
  page.on("websocket", (socket) => {
    const recordFrame = (direction: string, message: string) => {
      if (/agent.*timeline|fetch_agents|agent_update/.test(message)) {
        wire.push(JSON.stringify({ at: Date.now(), direction, message }));
      }
    };
    socket.on("framesent", ({ payload }) => recordFrame("sent", payload.toString()));
    socket.on("framereceived", ({ payload }) => recordFrame("received", payload.toString()));
  });
  return wire;
}

async function createCodexRestoreJourney(page: Page, client: SeedDaemonClient, info: TestInfo) {
  const repo = await createTempGitRepo("codex-worktree-restore-");
  const mcp = new Client({ name: "worktree-codex-restore-playwright", version: "1.0.0" });
  const wire = recordTimelineWire(page);
  let workspace: z.infer<typeof workspaceSchema> | undefined;
  let agentId: string | undefined;

  function created() {
    if (!workspace || !agentId) throw new Error("Create the Codex worktree before using it");
    return { ...workspace, agentId };
  }

  async function expectSelected() {
    await expect(page.getByTestId(`workspace-tab-agent_${created().agentId}`)).toHaveAttribute(
      "aria-selected",
      "true",
    );
  }

  return {
    async createWorktreeWithCodex() {
      await mcp.connect(
        new StreamableHTTPClientTransport(
          new URL(`http://127.0.0.1:${getE2EDaemonPort()}/mcp/agents`),
        ),
      );
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
    },
    async waitForCompletedReply() {
      const target = created();
      await page.goto(buildHostAgentDetailRoute(getServerId(), target.agentId, target.workspaceId));
      await waitForSidebarHydration(page);
      await expect(page.getByTestId("assistant-message")).toContainText(REPLY, {
        timeout: 240_000,
      });
      await expect
        .poll(() => client.fetchAgent({ agentId: target.agentId }))
        .toMatchObject({
          agent: { status: "idle", archivedAt: null },
        });
      await assertComposerIdle({ page });
    },
    async archiveBeforeBrowserConnects() {
      const target = created();
      await client.waitForFinish(target.agentId, 240_000);
      expect((await client.archiveWorkspace(target.workspaceId)).error).toBeNull();
      await expect.poll(() => existsSync(target.cwd)).toBe(false);
      await expect
        .poll(() => client.fetchAgent({ agentId: target.agentId }))
        .toMatchObject({
          agent: { archivedAt: expect.any(String) },
        });
    },
    async connectFreshBrowser() {
      await page.goto("/");
    },
    async archiveWorkspaceFromSidebar() {
      await archiveWorkspaceFromSidebar(page, created().workspaceId);
    },
    async expectWorkspaceAndAgentArchived() {
      const target = created();
      await expectWorkspaceAbsentFromSidebar(page, target.workspaceId);
      await expect
        .poll(() => client.fetchAgent({ agentId: target.agentId }))
        .toMatchObject({
          agent: { archivedAt: expect.any(String) },
        });
      await expect.poll(() => existsSync(target.cwd), { timeout: 30_000 }).toBe(false);
      await expect
        .poll(() => client.fetchWorkspaces())
        .not.toMatchObject({
          entries: expect.arrayContaining([expect.objectContaining({ id: target.workspaceId })]),
        });
    },
    async openArchivedWorkspaceFromHistory() {
      await openSessions(page);
      const row = page.getByTestId(`agent-row-${getServerId()}-${created().agentId}`);
      await expect(row).toContainText("Archived");
      await row.click();
      await expect(page.getByText("Workspace archived", { exact: true })).toBeVisible();
    },
    async restoreWorkspace() {
      await page.getByRole("button", { name: "Restore", exact: true }).click();
      await expect(page.getByText("Workspace archived", { exact: true })).toHaveCount(0, {
        timeout: 60_000,
      });
    },
    async expectWorktreeRestoredWithArchivedAgentSelected() {
      await expect.poll(() => existsSync(created().cwd), { timeout: 30_000 }).toBe(true);
      await expectSelected();
      await expect(page.getByText("This agent is archived", { exact: true })).toBeVisible();
      await info.attach("after-workspace-restore", {
        body: JSON.stringify(await client.fetchAgent({ agentId: created().agentId }), null, 2),
        contentType: "application/json",
      });
    },
    async expectArchivedAgentSelectedWithHistory() {
      await expectSelected();
      await expect(page.getByText("This agent is archived", { exact: true })).toBeVisible();
      await expect(page.getByTestId("assistant-message")).toContainText(REPLY);
    },
    async reloadWithoutAgentCache() {
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
    },
    async waitForWorkspaceHydration() {
      await waitForSidebarHydration(page);
    },
    async unarchiveAgent() {
      await page.getByRole("button", { name: "Unarchive", exact: true }).click({ timeout: 30_000 });
      await expect(page.getByText("This agent is archived", { exact: true })).toHaveCount(0, {
        timeout: 60_000,
      });
    },
    async expectIdleAgentWithVisibleComposer(statusTimeout?: number) {
      await expect
        .poll(() => client.fetchAgent({ agentId: created().agentId }), { timeout: statusTimeout })
        .toMatchObject({ agent: { status: "idle", archivedAt: null } });
      await expectSelected();
      await expect(page.getByRole("textbox", { name: "Message agent..." })).toBeVisible();
      await assertComposerIdle({ page });
      await info.attach("restored-agent-screen", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
      await info.attach("restored-agent-accessibility", {
        body: await page.locator("body").ariaSnapshot(),
        contentType: "text/plain",
      });
    },
    async dispose() {
      const testFailed = info.status !== info.expectedStatus;
      const errors: unknown[] = [];
      try {
        await info.attach("final-screen", {
          body: await page.screenshot(),
          contentType: "image/png",
        });
        await info.attach("timeline-wire", { body: wire.join("\n"), contentType: "text/plain" });
        await info.attach("final-agent", {
          body: JSON.stringify(agentId ? await client.fetchAgent({ agentId }) : null, null, 2),
          contentType: "application/json",
        });
        await info.attach("daemon-log", {
          body: await readFile(path.join(process.env.E2E_PASEO_HOME!, "daemon.log")),
          contentType: "text/plain",
        });
      } catch (error) {
        errors.push(error);
      }
      const cleanup: Array<() => Promise<unknown>> = [() => mcp.close()];
      if (!testFailed || process.env.E2E_KEEP_PASEO_HOME !== "1") {
        const projectId = workspace?.projectId;
        if (projectId) cleanup.push(() => client.removeProject(projectId));
        cleanup.push(() => repo.cleanup());
      }
      for (const release of cleanup) {
        try {
          await release();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) {
        const error = new AggregateError(errors, "Codex restore fixture teardown failed");
        if (!testFailed) throw error;
        // Keep the journey failure primary while reporting teardown failures in the test log.
        console.error(error);
      }
    },
  };
}

export const test = base.extend<{
  codexRestore: Awaited<ReturnType<typeof createCodexRestoreJourney>>;
}>({
  // This fixture owns cleanup so a failed reproduction can retain its daemon state.
  projectOwnership: async ({ e2eWorkerClient }, provide) => {
    void e2eWorkerClient;
    await provide();
  },
  codexRestore: async ({ page, e2eWorkerClient }, provide, info) => {
    const journey = await createCodexRestoreJourney(page, e2eWorkerClient, info);
    try {
      await provide(journey);
    } finally {
      await journey.dispose();
    }
  },
});
