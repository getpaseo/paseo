import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, TestInfo } from "@playwright/test";
import { expect, test as base, type Page } from "../fixtures";
import { gotoAppShell, openSettings } from "./app";
import { openModelPicker } from "./agent-profiles";
import { openAgentRoute } from "./mock-agent";
import { connectNewWorkspaceDaemonClient, openGlobalNewWorkspaceComposer } from "./new-workspace";
import { copyPluginExample } from "./plugin-fixture";
import { seedWorkspace, type SeededWorkspace } from "./seed-client";
import { waitForSettledPosition } from "./sheet-layout";
import { getServerId } from "./server-id";
import { openSettingsHostSection } from "./settings";

const MODEL_LABEL = "Select model (Example 1)";
const WIDE = { width: 1400, height: 950 };
const COMPACT = { width: 390, height: 844 };

async function readIconPaths(page: Page, pluginDirectory: string): Promise<string[]> {
  const svg = await readFile(path.join(pluginDirectory, "icon.svg"), "utf8");
  return page.evaluate(
    (source) =>
      Array.from(
        new DOMParser().parseFromString(source, "image/svg+xml").querySelectorAll("path"),
        (element) => element.getAttribute("d") ?? "",
      ),
    svg,
  );
}

function readIconDrawings(icons: SVGElement[]): string[][] {
  return icons.map((icon) =>
    Array.from(icon.querySelectorAll("path"), (element) => element.getAttribute("d") ?? ""),
  );
}

async function expectProviderIcon(surface: Locator, paths: string[]): Promise<void> {
  await expect(surface).toBeVisible();
  // Provider icons are decorative SVGs without accessible names. Compare the
  // plugin asset's drawing, allowing surface-specific size and theme colours.
  await expect
    .poll(() => surface.locator("svg").evaluateAll(readIconDrawings))
    .toContainEqual(paths);
}

async function selectPluginModel(page: Page): Promise<void> {
  await page.getByTestId("combined-model-selector").filter({ visible: true }).first().click();
  await expect(page.getByRole("textbox", { name: /search (?:all )?model/i })).toBeVisible();
  const compactSheet = page.getByTestId("agent-controls-model-sheet").filter({ visible: true });
  if (await compactSheet.isVisible()) {
    const modelControl = page.getByTestId("agent-controls-model").filter({ visible: true });
    await waitForSettledPosition(modelControl);
    await modelControl.click();
    const browserSheet = page
      .getByTestId("agent-controls-model-browser-sheet")
      .filter({ visible: true });
    await expect(browserSheet).toBeVisible();
    const browserViewport = page
      .getByTestId("agent-controls-model-browser-viewport")
      .filter({ visible: true });
    await waitForSettledPosition(
      browserViewport.getByText("Direct provider example", { exact: true }),
    );
    await browserViewport.getByText("Direct provider example", { exact: true }).click();
    await browserViewport.getByTestId("model-row-direct-example-example-1").click();
    await expect(browserSheet).toHaveCount(0);
    await waitForSettledPosition(compactSheet.getByRole("button", { name: "Close", exact: true }));
    await compactSheet.getByRole("button", { name: "Close", exact: true }).click();
    await expect(compactSheet).toHaveCount(0);
  } else {
    const back = page.getByRole("button", { name: "Back", exact: true }).filter({ visible: true });
    if (await back.isVisible()) await back.click();
    await page.getByText("Direct provider example", { exact: true }).click();
    await page.getByText("Example 1", { exact: true }).click();
  }
  await expect(page.getByRole("button", { name: MODEL_LABEL, exact: true })).toBeVisible();
}

async function capture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const screenshot = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: screenshot });
  await testInfo.attach(name, { path: screenshot, contentType: "image/png" });
}

interface ProviderIconJourney {
  page: Page;
  testInfo: TestInfo;
  iconPaths: string[];
  workspace: SeededWorkspace;
}

export const test = base.extend<{ providerIcons: ProviderIconJourney }>({
  providerIcons: async ({ page }, provide, testInfo) => {
    const client = await connectNewWorkspaceDaemonClient();
    try {
      const previous = await client.getDaemonConfig();
      const plugin = await copyPluginExample("provider-direct");
      try {
        try {
          await client.patchDaemonConfig({ pluginsEnabled: true });
          await client.installDirectoryPlugin(plugin.directory);
          const workspace = await seedWorkspace({ repoPrefix: "plugin-provider-icons-" });
          try {
            await page.setViewportSize(WIDE);
            await gotoAppShell(page);
            const iconPaths = await readIconPaths(page, plugin.directory);
            await provide({ page, testInfo, iconPaths, workspace });
          } finally {
            await workspace.cleanup();
          }
        } finally {
          try {
            await client.removePlugin("provider-direct-example");
          } finally {
            await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled });
          }
        }
      } finally {
        await plugin.cleanup();
      }
    } finally {
      await client.close();
    }
  },
});

export async function verifyProviderSettings({
  page,
  iconPaths,
  testInfo,
}: ProviderIconJourney): Promise<void> {
  await test.step("provider settings render the registered icon", async () => {
    await openSettings(page);
    await openSettingsHostSection(page, getServerId(), "providers");
    await expectProviderIcon(
      page.getByRole("button", { name: "Direct provider example provider details", exact: true }),
      iconPaths,
    );
    await capture(page, testInfo, "provider-settings");
    await page.getByTestId("settings-back-to-workspace").click();
  });
}

export async function verifyNewWorkspaceModelIcon({
  page,
  iconPaths,
  testInfo,
}: ProviderIconJourney): Promise<void> {
  await test.step("new workspace shows the provider icon in the picker and a text-only selection", async () => {
    await openGlobalNewWorkspaceComposer(page);
    await selectPluginModel(page);
    await openModelPicker(page);
    await expectProviderIcon(page.getByTestId("model-row-direct-example-example-1"), iconPaths);
    await capture(page, testInfo, "new-workspace-picker");
    await page.keyboard.press("Escape");
    const selectedModel = page.getByRole("button", { name: MODEL_LABEL, exact: true });
    await expect(selectedModel).toBeVisible();
    await expect
      .poll(() => selectedModel.locator("svg").evaluateAll(readIconDrawings))
      .not.toContainEqual(iconPaths);
    await capture(page, testInfo, "new-workspace-selected-model");
  });
}

export async function verifyCompactModelIcon({
  page,
  iconPaths,
  testInfo,
}: ProviderIconJourney): Promise<void> {
  await test.step("compact composer shows the selected provider icon", async () => {
    await page.setViewportSize(COMPACT);
    await selectPluginModel(page);
    const selectedModel = page.getByRole("button", { name: MODEL_LABEL, exact: true });
    await expect(selectedModel).toBeVisible();
    await expectProviderIcon(selectedModel, iconPaths);
    await capture(page, testInfo, "compact-selected-model");
  });
}

export async function verifyExistingAgentModelIcon({
  page,
  iconPaths,
  testInfo,
  workspace,
}: ProviderIconJourney): Promise<void> {
  await test.step("existing agent composer preserves the text-only model selection", async () => {
    const agent = await workspace.client.createAgent({
      provider: "direct-example",
      model: "example-1",
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: "Plugin icon agent",
    });
    await page.setViewportSize(WIDE);
    await openAgentRoute(page, { workspaceId: workspace.workspaceId, agentId: agent.id });
    const selectedModel = page.getByRole("button", { name: MODEL_LABEL, exact: true });
    await expect(selectedModel).toBeVisible();
    await expect
      .poll(() => selectedModel.locator("svg").evaluateAll(readIconDrawings))
      .not.toContainEqual(iconPaths);
    await capture(page, testInfo, "agent-selected-model");
  });
}
