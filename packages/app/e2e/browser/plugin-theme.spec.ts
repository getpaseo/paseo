import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { openSettingsSection } from "../support/helpers/settings";

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
      accent: "#45475a",
      highlight: "#cba6f7",
      mutedForeground: "#a6adc8",
      ring: "#6c7086",
    },
  });
  return () => {};
}`;

// settingsStyles.sectionHeaderTitle paints from foregroundMuted, so the section heading proves the
// contributed palette reached the semantic tokens rather than just the swatch.
const MOCHA_MUTED_FOREGROUND = "rgb(166, 173, 200)";

test("applies a contributed theme and falls back when its plugin is gone", async ({
  page,
}, testInfo) => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-theme-e2e-"));
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previousConfig = await client.getDaemonConfig();
  await writeFile(path.join(directory, "paseo-plugin.json"), JSON.stringify({ id: PLUGIN_ID }));
  await writeFile(path.join(directory, "index.ts"), PLUGIN_SOURCE);

  try {
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    await page.goto("/settings");
    await expect(page.getByTestId("settings-sidebar")).toBeVisible();
    await openSettingsSection(page, "appearance");

    const sectionTitle = page.getByText("Theme", { exact: true }).first();
    await page.getByLabel("Theme: System", { exact: true }).click();
    const mochaItem = page.getByText("Catppuccin Mocha", { exact: true });
    await expect(mochaItem).toBeVisible({ timeout: 30_000 });
    await page.screenshot({
      path: testInfo.outputPath("plugin-theme-picker.png"),
      animations: "disabled",
      fullPage: true,
    });

    await mochaItem.click();
    await expect(page.getByLabel("Theme: Catppuccin Mocha", { exact: true })).toBeVisible();
    await expect(sectionTitle).toHaveCSS("color", MOCHA_MUTED_FOREGROUND);
    await page.screenshot({
      path: testInfo.outputPath("plugin-theme-applied.png"),
      fullPage: true,
    });

    await test.step("the selection survives a reload", async () => {
      await page.reload();
      await expect(page.getByLabel("Theme: Catppuccin Mocha", { exact: true })).toBeVisible({
        timeout: 30_000,
      });
      await expect(sectionTitle).toHaveCSS("color", MOCHA_MUTED_FOREGROUND);
    });

    await test.step("removing the plugin falls back to the default theme", async () => {
      await client.removePlugin(PLUGIN_ID);
      await expect(page.getByLabel("Theme: System", { exact: true })).toBeVisible({
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
