import { randomUUID } from "node:crypto";
import path from "node:path";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { test, expect, type Page } from "../support/fixtures";
import { seedWorkspace, type SeedDaemonClient } from "../support/helpers/seed-client";
import { createIdleAgent, expectWorkspaceTabVisible } from "../support/helpers/archive-tab";
import { waitForWorkspaceTabsVisible } from "../support/helpers/workspace-tabs";
import { buildHostAgentDetailRoute } from "@/utils/host-routes";
import { renameModalInput, renameModalSubmit } from "../support/helpers/rename";
import { getServerId } from "../support/helpers/server-id";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";

async function openAgentInWorkspace(page: Page, agent: { id: string; workspaceId: string }) {
  await page.goto(buildHostAgentDetailRoute(getServerId(), agent.id, agent.workspaceId));
  await page.waitForURL(
    (url) => url.pathname.includes("/workspace/") && !url.searchParams.has("open"),
    { timeout: 60_000 },
  );
  await waitForWorkspaceTabsVisible(page);
  await expectWorkspaceTabVisible(page, agent.id);
}

async function fetchAgentTitle(client: SeedDaemonClient, agentId: string): Promise<string | null> {
  const result = await client.fetchAgents({ scope: "active" });
  return result.entries.find((entry) => entry.agent.id === agentId)?.agent.title ?? null;
}

test.describe("Workspace agent tab rename", () => {
  test("right-click rename persists the agent title and updates the tab label", async ({
    page,
  }) => {
    test.setTimeout(120_000);

    const workspace = await seedWorkspace({ repoPrefix: "workspace-agent-rename-" });

    try {
      const initialTitle = `agent-rename-${randomUUID().slice(0, 8)}`;
      const agent = await createIdleAgent(workspace.client, {
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: initialTitle,
      });

      await openAgentInWorkspace(page, agent);

      const tab = page.getByTestId(`workspace-tab-agent_${agent.id}`).first();
      await expect(tab).toContainText(initialTitle, { timeout: 15_000 });

      await tab.click({ button: "right" });
      await expect(page.getByTestId(`workspace-tab-context-agent_${agent.id}`)).toBeVisible({
        timeout: 10_000,
      });
      const renameItem = page.getByTestId(`workspace-tab-context-agent_${agent.id}-rename`);
      await expect(renameItem).toBeVisible({ timeout: 10_000 });
      await renameItem.click();

      const modalPrefix = `workspace-tab-rename-modal-agent-${agent.id}`;
      const input = renameModalInput(page, modalPrefix);
      await expect(input).toBeVisible({ timeout: 10_000 });
      await expect(input).toHaveValue(initialTitle);

      const renamed = "My Renamed Agent";
      await input.fill(renamed);
      await renameModalSubmit(page, modalPrefix).click();

      await expect(input).toHaveCount(0, { timeout: 15_000 });
      await expect(tab).toContainText(renamed, { timeout: 15_000 });
      await expect.poll(() => fetchAgentTitle(workspace.client, agent.id)).toBe(renamed);
    } finally {
      await workspace.cleanup();
    }
  });
});

const RESUME_PROVIDER = "resume-copy-profile";
const RESUME_ENV_VALUE = "O'Brien $HOME; echo should-not-run";
const RESUME_SCRIPT = path.resolve("e2e/fixtures/fake-pi-rpc.mjs");
const RESUME_PROVIDER_CONFIG = {
  extends: "pi",
  label: "Resume copy profile",
  command: [process.execPath, RESUME_SCRIPT],
  env: { PASEO_RESUME_TEST_VALUE: RESUME_ENV_VALUE },
  models: [{ id: "pi-profile-model", label: "Pi profile model" }],
};

async function clickCopyResumeCommand(page: Page, agentId: string): Promise<void> {
  await page
    .getByTestId("workspace-tab-agent_" + agentId)
    .first()
    .click({ button: "right" });
  await page.getByTestId("workspace-tab-context-agent_" + agentId + "-copy-resume-command").click();
}

async function readClipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

test.describe("Workspace agent tab resume command", () => {
  test("copies a custom profile's command and environment and recovers after removing it", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const workspace = await seedWorkspace({ repoPrefix: "workspace-resume-copy-" });
    const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "resume-copy" });
    await client.patchDaemonConfig({ providers: { [RESUME_PROVIDER]: RESUME_PROVIDER_CONFIG } });
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);

    try {
      const agent = await workspace.client.createAgent({
        provider: RESUME_PROVIDER,
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: "Custom resume command",
      });
      await workspace.client.waitForAgentUpsert(
        agent.id,
        (entry) => entry.status === "idle",
        30_000,
      );
      await expect
        .poll(
          async () =>
            (await client.fetchAgent({ agentId: agent.id }))?.agent.runtimeInfo?.sessionId,
        )
        .toBe("e2e-pi-session");
      await openAgentInWorkspace(page, { ...agent, workspaceId: workspace.workspaceId });

      await clickCopyResumeCommand(page, agent.id);
      await page.getByText(/^(Copied resume command|Resume command not available)$/).waitFor();
      await page.screenshot({ path: test.info().outputPath("resume-command-outcome.png") });
      await expect(page.getByText("Copied resume command", { exact: true })).toBeVisible();
      const expected =
        "env -- 'PASEO_RESUME_TEST_VALUE=O'\"'\"'Brien $HOME; echo should-not-run' " +
        process.execPath +
        " " +
        RESUME_SCRIPT +
        " --session e2e-pi-session";
      await expect.poll(() => readClipboard(page)).toBe(expected);
      await page.screenshot({ path: test.info().outputPath("resume-command-copied.png") });

      await page.evaluate(() => navigator.clipboard.writeText("unchanged"));
      await client.patchDaemonConfig({ removeProviders: [RESUME_PROVIDER] });
      await clickCopyResumeCommand(page, agent.id);
      await expect(page.getByText("Resume command not available", { exact: true })).toBeVisible();
      expect(await readClipboard(page)).toBe("unchanged");
      await page.screenshot({ path: test.info().outputPath("resume-command-unavailable.png") });

      await page.getByTestId("resume-command-dismiss").click();
      await expect(page.getByText("Resume command not available", { exact: true })).toBeHidden();
      await clickCopyResumeCommand(page, agent.id);
      await expect(page.getByTestId("resume-command-retry")).toBeVisible();
      await client.patchDaemonConfig({ providers: { [RESUME_PROVIDER]: RESUME_PROVIDER_CONFIG } });
      await page.getByTestId("resume-command-retry").click();
      await expect(page.getByText("Copied resume command", { exact: true })).toBeVisible();
      await expect.poll(() => readClipboard(page)).toBe(expected);

      await client.patchDaemonConfig({
        providers: {
          pi: {
            command: [process.execPath, RESUME_SCRIPT],
            models: [{ id: "pi-profile-model", label: "Pi profile model" }],
          },
        },
      });
      const nativeAgent = await workspace.client.createAgent({
        provider: "pi",
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: "Built-in resume command",
      });
      await workspace.client.waitForAgentUpsert(
        nativeAgent.id,
        (entry) => entry.status === "idle",
        30_000,
      );
      await openAgentInWorkspace(page, { ...nativeAgent, workspaceId: workspace.workspaceId });
      await page.evaluate(() => navigator.clipboard.writeText("before-native-copy"));
      await page.context().setOffline(true);
      await clickCopyResumeCommand(page, nativeAgent.id);
      await expect(page.getByText("Copied resume command", { exact: true })).toBeVisible();
      await expect.poll(() => readClipboard(page)).toBe("pi --session e2e-pi-session");
      await page.screenshot({ path: test.info().outputPath("native-resume-command-offline.png") });
    } finally {
      await page.context().setOffline(false);
      await client.patchDaemonConfig({ removeProviders: [RESUME_PROVIDER, "pi"] });
      await client.close();
      await workspace.cleanup();
    }
  });
});
