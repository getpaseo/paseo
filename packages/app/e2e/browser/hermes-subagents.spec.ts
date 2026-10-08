import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { expect, test } from "../support/fixtures";
import { seedWorkspace } from "../support/helpers/seed-client";
import { openAgentRoute } from "../support/helpers/mock-agent";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";

// Default: self-contained ACP contract fixture. Optional: run the companion
// Hermes PR's executable fixture through the real Python ACP server and relay.
const python = process.env.PASEO_HERMES_ACP_FIXTURE_PYTHON;
const script = process.env.PASEO_HERMES_ACP_FIXTURE_SCRIPT;
if (Boolean(python) !== Boolean(script)) throw new Error("Set both Hermes fixture overrides");
const fixtureHome = mkdtempSync(path.join(tmpdir(), "paseo-hermes-no-model-"));
const command =
  python && script
    ? [python, script]
    : [process.execPath, path.resolve("e2e/fixtures/hermes-subagents.cjs")];
test.use({
  e2eDaemonEnvironment: { HERMES_HOME: fixtureHome },
  e2eDaemonConfig: {
    version: 1,
    agents: {
      providers: {
        hermes: { extends: "acp", label: "Hermes fixture", enabled: true, command },
        claude: { enabled: false },
        codex: { enabled: false },
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
        omp: { enabled: false },
      },
    },
  },
});
test.afterAll(() => rmSync(fixtureHome, { recursive: true, force: true }));

for (const scenario of [
  { name: "desktop-light", theme: "light", width: 1400, height: 950 },
  { name: "desktop-dark", theme: "dark", width: 1400, height: 950 },
  { name: "compact-light", theme: "light", width: 390, height: 844 },
] as const) {
  test(`NO-MODEL FIXTURE reuses Hermes child panels ${scenario.name}`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: scenario.width, height: scenario.height });
    await page.addInitScript(
      (theme) => localStorage.setItem("@paseo:app-settings", JSON.stringify({ theme })),
      scenario.theme,
    );
    const workspace = await seedWorkspace({ repoPrefix: "hermes-subagent-fixture-" });
    const observer = await connectDaemonClient<
      Pick<
        DaemonClient,
        "connect" | "close" | "listProviderSubagents" | "fetchProviderSubagentTimeline"
      >
    >({ clientIdPrefix: "hermes-fixture" });
    try {
      const agent = await workspace.client.createAgent({
        provider: "hermes",
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: "NO-MODEL FIXTURE: Hermes progress",
      });
      await workspace.client.sendAgentMessage(agent.id, "fixture first turn");
      await workspace.client.waitForFinish(agent.id, 30_000);
      await expect
        .poll(async () => (await observer.listProviderSubagents(agent.id)).subagents.length)
        .toBe(3);
      const children = (await observer.listProviderSubagents(agent.id)).subagents;
      const alpha = children.find((child) => child.description === "Subagent alpha")!;
      const nested = children.find((child) => child.description === "Subagent nested")!;
      expect(nested.parentSubagentId).toBe(alpha.id);
      expect(children.every((child) => child.status === "running")).toBe(true);
      await openAgentRoute(page, { workspaceId: workspace.workspaceId, agentId: agent.id });
      await page.getByTestId("subagents-track-header").click();
      const rootRows = page.locator('[data-testid^="subagents-track-row-"]');
      await expect(rootRows).toHaveCount(2);
      // Let the existing popover/sheet enter animation settle for readable QA captures.
      await page.waitForTimeout(350);
      await page.screenshot({ path: testInfo.outputPath(`${scenario.name}-running.png`) });
      await page.getByTestId(`subagents-track-row-${alpha.id}`).click();
      const panel = page.getByTestId("provider-subagent-panel");
      await expect(panel).toBeVisible();
      await expect(panel).toContainText("[NO-MODEL FIXTURE] alpha public output");
      await expect(panel).toContainText("Started tool: terminal");
      await expect(panel.getByRole("button", { name: /^Stop/ })).toHaveCount(0);
      await panel.getByTestId("subagents-track-header").click();
      await page.getByTestId(`subagents-track-row-${nested.id}`).click();
      await expect(page.getByTestId("provider-subagent-panel").last()).toContainText(
        "[NO-MODEL FIXTURE] nested public output",
      );
      await page.screenshot({ path: testInfo.outputPath(`${scenario.name}-nested.png`) });
      await workspace.client.sendAgentMessage(agent.id, "fixture second turn");
      await workspace.client.waitForFinish(agent.id, 30_000);
      await expect
        .poll(async () =>
          (await observer.listProviderSubagents(agent.id)).subagents
            .map((child) => child.status)
            .sort(),
        )
        .toEqual(["canceled", "completed", "failed"]);
      await page.reload();
      await expect(page.getByTestId("provider-subagent-panel").last()).toContainText(
        "[NO-MODEL FIXTURE] nested public output",
      );
      const retained = await observer.fetchProviderSubagentTimeline(agent.id, nested.id);
      expect(JSON.stringify(retained)).toContain("nested public output");
      await page.screenshot({ path: testInfo.outputPath(`${scenario.name}-reconnected.png`) });
    } catch (error) {
      await page.screenshot({ path: testInfo.outputPath(`${scenario.name}-failure.png`) });
      throw error;
    } finally {
      await observer.close();
      await workspace.cleanup();
    }
  });
}
