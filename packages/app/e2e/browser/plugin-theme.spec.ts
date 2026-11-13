import { pluginRequirements } from "../support/helpers/plugin-fixture";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { openSettingsSection } from "../support/helpers/settings";
import { seedMockAgentWorkspace, openAgentRoute } from "../support/helpers/mock-agent";
import { getServerId } from "../support/helpers/server-id";
import { contrastRatio } from "../../src/utils/color";
import type { Locator, Page } from "@playwright/test";

const PLUGIN_ID = "plugin-theme-e2e";

// Catppuccin Mocha: base, text, surface0, surface1, mauve, subtext0, overlay0.
const PLUGIN_SOURCE = `export default function contribute(plugin) {
  plugin.addTheme({
    id: "mocha",
    name: "Catppuccin Mocha",
    appearance: "dark",
    colors: {
      background: "#1e1e2e",
      foreground: "#cdd6f4",
      raised: "#313244",
      control: "#45475a",
      border: "#45475a",
      accent: "#cba6f7",
      mutedForeground: "#a6adc8",
      ring: "#6c7086",
    },
  });
  plugin.addTheme({
    id: "latte",
    name: "Catppuccin Latte",
    appearance: "light",
    colors: {
      background: "#eff1f5",
      foreground: "#4c4f69",
      raised: "#e6e9ef",
      control: "#dce0e8",
      border: "#ccd0da",
      accent: "#8839ef",
      mutedForeground: "#6c6f85",
      ring: "#9ca0b0",
    },
  });
  for (const [id, name, overrides] of [
    ["solarized-dark", "Solarized Dark", {}],
    ["solarized-dark-custom", "Solarized Dark Custom", { sidebarSelected: "#334455", foregroundExtraMuted: "#ddeeff" }],
  ]) {
    plugin.addTheme({ id, name, appearance: "dark", colors: {
      background: "#002b36", foreground: "#839496", raised: "#073642",
      control: "#073642", border: "#073642", accent: "#268bd2",
      mutedForeground: "#586e75", ring: "#93a1a1", ...overrides,
    }});
  }
  return () => {};
}`;

// settingsStyles.sectionHeaderTitle paints from foregroundMuted, so the section heading proves the
// contributed palette reached the semantic tokens rather than just the swatch.
const MOCHA_MUTED_FOREGROUND = "rgb(166, 173, 200)";
const LATTE_MUTED_FOREGROUND = "rgb(108, 111, 133)";
const LATTE_RING = "rgb(156, 160, 176)";

async function selectTheme(page: Page, name: string) {
  await page.goto("/settings");
  await openSettingsSection(page, "appearance");
  const theme = page.getByRole("radio", { name, exact: true });
  await expect(theme).toBeVisible({ timeout: 30_000 });
  await theme.click();
  await expect(theme).toBeChecked();
}

async function expectTimestampContrast(row: Locator) {
  const timestamp = row.getByTestId("sidebar-workspace-timestamp");
  await expect(timestamp).toBeVisible();
  const hex = (rgb: string) =>
    `#${rgb
      .match(/\d+/g)!
      .slice(0, 3)
      .map((value) => Number(value).toString(16).padStart(2, "0"))
      .join("")}`;
  const background = await row.evaluate((element) => getComputedStyle(element).backgroundColor);
  const foreground = await timestamp.evaluate((element) => getComputedStyle(element).color);
  expect(contrastRatio(hex(background), hex(foreground))).toBeGreaterThanOrEqual(2.5);
}

test("keeps plugin workspace timestamps readable on state surfaces and honors overrides", async ({
  page,
}) => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-theme-state-"));
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previousConfig = await client.getDaemonConfig();
  const selected = await seedMockAgentWorkspace({
    repoPrefix: "theme-selected-",
    title: "Selected theme workspace",
  });
  const hovered = await seedMockAgentWorkspace({
    repoPrefix: "theme-hovered-",
    title: "Hovered theme workspace",
  });
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({ id: PLUGIN_ID, requirements: pluginRequirements }),
  );
  await writeFile(path.join(directory, "index.client.ts"), PLUGIN_SOURCE);
  try {
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    await selectTheme(page, "Solarized Dark");
    await openAgentRoute(page, selected);
    const selectedRow = page.getByTestId(
      `sidebar-workspace-row-${getServerId()}:${selected.workspaceId}`,
    );
    const hoveredRow = page.getByTestId(
      `sidebar-workspace-row-${getServerId()}:${hovered.workspaceId}`,
    );
    await expect(selectedRow).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });
    await page.mouse.move(0, 0);
    await expect(selectedRow).toHaveCSS("background-color", "rgb(33, 58, 66)");
    await expectTimestampContrast(selectedRow);
    await hoveredRow.hover();
    await expect(hoveredRow).toHaveCSS("background-color", "rgb(19, 50, 60)");
    await expectTimestampContrast(hoveredRow);

    await selectTheme(page, "Solarized Dark Custom");
    await openAgentRoute(page, selected);
    await page.mouse.move(0, 0);
    await expect(selectedRow).toHaveCSS("background-color", "rgb(51, 68, 85)");
    await expect(selectedRow.getByTestId("sidebar-workspace-timestamp")).toHaveCSS(
      "color",
      "rgb(221, 238, 255)",
    );
  } finally {
    await client.removePlugin(PLUGIN_ID).catch(() => undefined);
    await client
      .patchDaemonConfig({ pluginsEnabled: previousConfig.config.pluginsEnabled ?? false })
      .catch(() => undefined);
    await client.close();
    await selected.cleanup();
    await hovered.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
});

test("applies a contributed theme and falls back when its plugin is gone", async ({
  page,
}, testInfo) => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-theme-e2e-"));
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previousConfig = await client.getDaemonConfig();
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({ id: PLUGIN_ID, requirements: pluginRequirements }),
  );
  await writeFile(path.join(directory, "index.client.ts"), PLUGIN_SOURCE);

  try {
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    await page.goto("/settings");
    await expect(page.getByTestId("settings-sidebar")).toBeVisible();
    await openSettingsSection(page, "appearance");

    const sectionTitle = page.getByText("Theme", { exact: true }).first();
    const mochaItem = page.getByRole("radio", { name: "Catppuccin Mocha", exact: true });
    await expect(mochaItem).toBeVisible({ timeout: 30_000 });
    await page.screenshot({
      path: testInfo.outputPath("plugin-theme-picker.png"),
      animations: "disabled",
      fullPage: true,
    });

    await test.step("a contributed light theme uses the light palette", async () => {
      const latteItem = page.getByRole("radio", { name: "Catppuccin Latte", exact: true });
      await latteItem.click();
      await expect(latteItem).toBeChecked();
      await expect(sectionTitle).toHaveCSS("color", LATTE_MUTED_FOREGROUND);
    });

    await test.step("keyboard focus draws the outline in the theme's ring color", async () => {
      await page.getByRole("radio", { name: "Catppuccin Latte", exact: true }).click();
      await page.mouse.move(0, 0);
      await page.keyboard.press("Tab");
      await expect(page.locator(":focus-visible").first()).toHaveCSS("outline-color", LATTE_RING);
    });

    await mochaItem.click();
    await expect(mochaItem).toBeChecked();
    await expect(sectionTitle).toHaveCSS("color", MOCHA_MUTED_FOREGROUND);
    await page.screenshot({
      path: testInfo.outputPath("plugin-theme-applied.png"),
      fullPage: true,
    });

    await test.step("the selection survives a reload", async () => {
      await page.reload();
      await expect(mochaItem).toBeChecked({ timeout: 30_000 });
      await expect(sectionTitle).toHaveCSS("color", MOCHA_MUTED_FOREGROUND);
    });

    await test.step("removing the plugin falls back to the default theme", async () => {
      await client.removePlugin(PLUGIN_ID);
      await expect(page.getByRole("radio", { name: "System", exact: true })).toBeChecked({
        timeout: 30_000,
      });
      await expect(sectionTitle).not.toHaveCSS("color", MOCHA_MUTED_FOREGROUND);
      await page.screenshot({
        path: testInfo.outputPath("plugin-theme-fallback.png"),
        fullPage: true,
      });
    });
  } finally {
    await client.removePlugin(PLUGIN_ID).catch(() => undefined);
    await client
      .patchDaemonConfig({ pluginsEnabled: previousConfig.config.pluginsEnabled ?? false })
      .catch(() => undefined);
    await client.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

const MANY_THEMES_PLUGIN_ID = "plugin-theme-many-e2e";
const MANY_THEMES_COUNT = 40;
const LAST_THEME_NAME = `Pack theme ${MANY_THEMES_COUNT}`;

const MANY_THEMES_SOURCE = `export default function contribute(plugin) {
  for (let index = 1; index <= ${MANY_THEMES_COUNT}; index += 1) {
    plugin.addTheme({
      id: "pack-" + index,
      name: "Pack theme " + index,
      appearance: "dark",
      colors: {
        background: "#1e1e2e",
        foreground: "#cdd6f4",
        raised: "#313244",
        control: "#45475a",
        border: "#45475a",
        accent: "#cba6f7",
        mutedForeground: "#a6adc8",
        ring: "#6c7086",
      },
    });
  }
  return () => {};
}`;

test("reaches the last theme when a plugin contributes more themes than fit", async ({
  page,
}, testInfo) => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-theme-many-e2e-"));
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previousConfig = await client.getDaemonConfig();
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({ id: MANY_THEMES_PLUGIN_ID, requirements: pluginRequirements }),
  );
  await writeFile(path.join(directory, "index.client.ts"), MANY_THEMES_SOURCE);

  try {
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/settings");
    await expect(page.getByTestId("settings-sidebar")).toBeVisible();
    await openSettingsSection(page, "appearance");

    const lastTheme = page.getByRole("radio", { name: LAST_THEME_NAME, exact: true });
    await expect(lastTheme).toBeAttached({ timeout: 30_000 });
    await lastTheme.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath("plugin-theme-picker-scrolled.png"),
      animations: "disabled",
    });

    await lastTheme.click();
    await expect(lastTheme).toBeChecked();
  } finally {
    await client.removePlugin(MANY_THEMES_PLUGIN_ID).catch(() => undefined);
    await client
      .patchDaemonConfig({ pluginsEnabled: previousConfig.config.pluginsEnabled ?? false })
      .catch(() => undefined);
    await client.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});
