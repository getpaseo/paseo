import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import { seedWorkspace } from "../support/helpers/seed-client";
import { openAgentRoute } from "../support/helpers/mock-agent";
import { submitMessage, submitMessageWithButton } from "../support/helpers/composer";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";

// With `--daybreak` the fixture catalog plays an account enrolled in Daybreak Blue: Sol offers
// Blue and 6.1 Sol does not. Each reply names the access program its turn asked for, so the test
// reads what reached Codex from the timeline.
test.use({
  e2eDaemonConfig: {
    version: 1,
    agents: {
      providers: {
        codex: {
          enabled: true,
          command: [process.execPath, path.resolve("e2e/fixtures/catalog-codex.mjs"), "--daybreak"],
        },
        claude: { enabled: false },
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
        omp: { enabled: false },
      },
    },
  },
});

function daybreakToggle(page: Page) {
  return page.getByRole("button", { name: "Toggle Daybreak", exact: true });
}

function reply(page: Page, program: string) {
  return page.getByText(`Access program: ${program}.`, { exact: true });
}

async function switchAgentModel(agentId: string, modelId: string): Promise<void> {
  const client = await connectDaemonClient<
    Pick<DaemonClient, "setAgentModel" | "close" | "connect">
  >({
    clientIdPrefix: "codex-daybreak-model",
  });
  try {
    await client.setAgentModel(agentId, modelId);
  } finally {
    await client.close();
  }
}

test("Daybreak follows the model's catalog and reaches the Codex turn", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 850 });
  const workspace = await seedWorkspace({ repoPrefix: "codex-daybreak-" });
  try {
    const agent = await workspace.client.createAgent({
      provider: "codex",
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: "Daybreak",
      model: "gpt-6-sol",
      modeId: "full-access",
      initialPrompt: "Get ready to work on this project.",
    });
    await openAgentRoute(page, { workspaceId: workspace.workspaceId, agentId: agent.id });

    await test.step("an agent that never set Daybreak asks for no program", async () => {
      await expect(reply(page, "none")).toHaveCount(1, { timeout: 30_000 });
      await expect(daybreakToggle(page)).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("desktop-daybreak-off.png") });
    });

    await test.step("turning Daybreak on asks for Blue", async () => {
      await daybreakToggle(page).click();
      await page.screenshot({ path: testInfo.outputPath("desktop-daybreak-on.png") });
      await submitMessage(page, "Check the access program.");
      await expect(reply(page, "daybreakBlue")).toHaveCount(1, { timeout: 30_000 });
    });

    await test.step("a model without Daybreak hides the toggle and asks for nothing", async () => {
      await switchAgentModel(agent.id, "gpt-6.1-sol");
      await expect(daybreakToggle(page)).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath("desktop-model-without-daybreak.png") });
      await submitMessage(page, "Check it again.");
      await expect(reply(page, "none")).toHaveCount(2, { timeout: 30_000 });
    });

    await test.step("back on Sol, turning Daybreak off asks for standard", async () => {
      await switchAgentModel(agent.id, "gpt-6-sol");
      await expect(daybreakToggle(page)).toBeVisible();
      await daybreakToggle(page).click();
      await submitMessage(page, "And once more.");
      await expect(reply(page, "standard")).toHaveCount(1, { timeout: 30_000 });
    });

    await test.step("a compact screen turns Daybreak on from the model settings", async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      const features = page.getByRole("button", { name: "Open agent features", exact: true });
      const modelSettings = page.getByRole("button", { name: /^Select model \(/ });
      const backdrops = page.getByRole("button", { name: "Bottom sheet backdrop", exact: true });
      async function openSettings() {
        await expect(features.or(modelSettings).filter({ visible: true }).first()).toBeVisible();
        if (await features.isVisible()) await features.click();
        else await modelSettings.click();
        await expect(daybreakToggle(page)).toBeInViewport();
      }
      // Choosing On keeps the On/Off list and the model settings sheet open; Escape closes each.
      async function closeSheets() {
        await expect(async () => {
          await page.keyboard.press("Escape");
          await expect(backdrops).toHaveCount(0, { timeout: 1_000 });
        }).toPass({ timeout: 15_000 });
      }

      await openSettings();
      await expect(daybreakToggle(page)).toContainText("Off");
      await page.screenshot({ path: testInfo.outputPath("compact-model-settings.png") });
      await daybreakToggle(page).click();
      await page.getByRole("button", { name: "On", exact: true }).last().click();
      await closeSheets();
      await submitMessageWithButton(page, "From the phone.");
      await expect(reply(page, "daybreakBlue")).toHaveCount(2, { timeout: 30_000 });

      await openSettings();
      await expect(daybreakToggle(page)).toContainText("On");
      await page.screenshot({ path: testInfo.outputPath("compact-daybreak-on.png") });
      await closeSheets();
    });
  } finally {
    await workspace.cleanup();
  }
});
