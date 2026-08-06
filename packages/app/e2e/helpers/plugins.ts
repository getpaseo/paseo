import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { buildSettingsSectionRoute } from "@/utils/host-routes";
import { expectAppRoute } from "./route-assertions";

/**
 * The "by hand" install path from docs/plugins.md: a directory dropped into
 * `$PASEO_HOME/plugins/`. The daemon rescans on every `plugins.list`, so no
 * daemon restart is needed — which is what makes this usable from a spec that
 * shares one daemon with every other spec.
 */
const EXAMPLE_PLUGIN_DIR = path.resolve(__dirname, "../../../../examples/plugins/hello-paseo");

export const HELLO_PLUGIN_ID = "hello-paseo";
export const BROKEN_PLUGIN_ID = "broken-entry";

/** Directory the QA screenshots land in, for the PR body. */
export const QA_SCREENSHOT_DIR = path.resolve(__dirname, "../../../../.qa/plugins");

function pluginsDir(): string {
  const home = process.env.E2E_PASEO_HOME;
  if (!home) {
    throw new Error("E2E_PASEO_HOME is not set (expected from Playwright globalSetup).");
  }
  return path.join(home, "plugins");
}

/** Copies `examples/plugins/hello-paseo` into the test daemon's plugin directory. */
export async function installExamplePlugin(): Promise<void> {
  const target = path.join(pluginsDir(), HELLO_PLUGIN_ID);
  await rm(target, { recursive: true, force: true });
  await mkdir(pluginsDir(), { recursive: true });
  await cp(EXAMPLE_PLUGIN_DIR, target, { recursive: true });
}

/**
 * A plugin whose manifest parses but whose entry file was never written. The
 * daemon must keep listing it with an `unavailableReason` rather than dropping
 * it, and it must not claim `.broken` away from the built-in code view.
 */
export async function installPluginWithMissingEntry(): Promise<void> {
  const target = path.join(pluginsDir(), BROKEN_PLUGIN_ID);
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await writeFile(
    path.join(target, "paseo-plugin.json"),
    JSON.stringify(
      {
        id: BROKEN_PLUGIN_ID,
        name: "Broken Entry",
        version: "0.0.1",
        description: "Declares a preview whose HTML file does not exist.",
        author: "Paseo QA",
        contributes: {
          filePreviews: [
            { id: "gone", title: "Gone", extensions: [".broken"], entry: "missing.html" },
          ],
        },
      },
      null,
      2,
    ),
    "utf8",
  );
}

export async function uninstallTestPlugins(): Promise<void> {
  for (const id of [HELLO_PLUGIN_ID, BROKEN_PLUGIN_ID]) {
    await rm(path.join(pluginsDir(), id), { recursive: true, force: true });
  }
}

export async function openPluginsSettings(page: Page): Promise<void> {
  const sidebar = page.getByTestId("settings-sidebar");
  await expect(sidebar).toBeVisible();
  await sidebar.getByRole("button", { name: "Plugins", exact: true }).click();
  await expectAppRoute(page, buildSettingsSectionRoute("plugins"));
  await expect(page.getByTestId("settings-plugins")).toBeVisible();
}

export function pluginToggle(page: Page, pluginId: string) {
  return page.getByTestId(`plugin-toggle-${pluginId}`);
}

/** Flips the enable switch and waits for the daemon round-trip to settle. */
export async function setPluginEnabled(
  page: Page,
  pluginId: string,
  enabled: boolean,
): Promise<void> {
  const toggle = pluginToggle(page, pluginId);
  await expect(toggle).toHaveAttribute("aria-checked", String(!enabled));
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", String(enabled));
}

export async function captureQaScreenshot(page: Page, name: string): Promise<string> {
  await mkdir(QA_SCREENSHOT_DIR, { recursive: true });
  const file = path.join(QA_SCREENSHOT_DIR, `${name}.png`);
  await page.screenshot({ path: file });
  return file;
}
