import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "./fixtures";
import { gotoAppShell, openSettings } from "./helpers/app";
import { expectFileTabOpen, openFileExplorer, openFileFromExplorer } from "./helpers/file-explorer";
import { openAgentRoute, seedMockAgentWorkspace } from "./helpers/mock-agent";
import {
  BROKEN_PLUGIN_ID,
  HELLO_PLUGIN_ID,
  captureQaScreenshot,
  installExamplePlugin,
  installPluginWithMissingEntry,
  openPluginsSettings,
  pluginToggle,
  setPluginEnabled,
  uninstallTestPlugins,
} from "./helpers/plugins";

const HELLO_FILE = "notes.hello";
const HELLO_CONTENT = "alpha\nbeta\ngamma";
const BROKEN_FILE = "report.broken";
const PET_TAB = `explorer-tab-plugin:${HELLO_PLUGIN_ID}:pet`;

/**
 * Both plugins are installed by hand into the shared test daemon's
 * `$PASEO_HOME/plugins` before any test navigates, so the first `plugins.list`
 * the app issues already sees them. They are removed again in `afterAll` so
 * `.txt` stops being claimed for every other spec in the run.
 */
test.beforeAll(async () => {
  await installExamplePlugin();
  await installPluginWithMissingEntry();
});

test.afterAll(async () => {
  await uninstallTestPlugins();
});

async function seedWorkspaceWithPluginFiles(prefix: string) {
  const session = await seedMockAgentWorkspace({
    repoPrefix: prefix,
    title: "Plugin system e2e",
  });
  await writeFile(path.join(session.cwd, HELLO_FILE), HELLO_CONTENT, "utf8");
  await writeFile(path.join(session.cwd, BROKEN_FILE), "nothing renders this\n", "utf8");
  return session;
}

/**
 * The explorer stays open across navigations inside a test, and the "Open
 * explorer" button only exists while it is closed — so opening it twice in one
 * test hangs on a button that is gone.
 */
async function ensureExplorerOpen(page: Page): Promise<void> {
  if (await page.getByTestId("explorer-header").isVisible()) {
    return;
  }
  await openFileExplorer(page);
}

async function openWorkspaceFile(page: Page, filename: string): Promise<void> {
  const tree = page.getByTestId("file-explorer-tree-scroll");
  if (!(await tree.isVisible())) {
    await ensureExplorerOpen(page);
    await page.getByTestId("explorer-tab-files").click();
    await expect(tree).toBeVisible({ timeout: 30_000 });
  }
  await openFileFromExplorer(page, filename);
  await expectFileTabOpen(page, filename);
}

/** The plugin's own DOM, inside the sandboxed iframe. */
function pluginFrame(page: Page, testId: string) {
  return page.getByTestId(testId).frameLocator("iframe");
}

test.describe("Plugin system", () => {
  test("Settings lists a hand-installed plugin and a broken one as unavailable", async ({
    page,
  }) => {
    await gotoAppShell(page);
    await openSettings(page);
    await openPluginsSettings(page);

    const helloRow = page.getByTestId(`plugin-row-${HELLO_PLUGIN_ID}`);
    await expect(helloRow).toBeVisible();
    await expect(helloRow).toContainText("Hello Paseo");
    await expect(helloRow).toContainText("1.0.0");
    await expect(pluginToggle(page, HELLO_PLUGIN_ID)).toHaveAttribute("aria-checked", "true");
    await expect(helloRow.getByTestId(`plugin-unavailable-${HELLO_PLUGIN_ID}`)).toBeHidden();

    // A plugin missing its entry file stays listed with a visible reason rather
    // than silently disappearing (docs/plugins.md "Installing").
    const brokenRow = page.getByTestId(`plugin-row-${BROKEN_PLUGIN_ID}`);
    await expect(brokenRow).toBeVisible();
    await expect(brokenRow).toContainText("Broken Entry");
    await expect(brokenRow.getByTestId(`plugin-unavailable-${BROKEN_PLUGIN_ID}`)).toContainText(
      'Missing entry file "missing.html"',
    );

    await captureQaScreenshot(page, "settings-plugins");
  });

  test("the enable toggle round-trips through the daemon and survives a reload", async ({
    page,
  }) => {
    await gotoAppShell(page);
    await openSettings(page);
    await openPluginsSettings(page);

    await setPluginEnabled(page, HELLO_PLUGIN_ID, false);
    await page.reload();
    await openPluginsSettings(page);
    await expect(pluginToggle(page, HELLO_PLUGIN_ID)).toHaveAttribute("aria-checked", "false");

    await setPluginEnabled(page, HELLO_PLUGIN_ID, true);
    await page.reload();
    await openPluginsSettings(page);
    await expect(pluginToggle(page, HELLO_PLUGIN_ID)).toHaveAttribute("aria-checked", "true");
  });

  test("a claimed extension renders the plugin preview, and the toolbar switches back to source", async ({
    page,
  }) => {
    const session = await seedWorkspaceWithPluginFiles("plugin-preview-");
    try {
      await openAgentRoute(page, session);
      await openWorkspaceFile(page, HELLO_FILE);

      // The plugin wins the extension: its sandbox renders and CodeMirror does not.
      const preview = page.getByTestId("plugin-file-preview");
      await expect(preview).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("file-source-editor")).toBeHidden();

      // Assert on what the plugin actually drew from the bridge context, not on
      // the mere presence of a frame: the path and the real line count.
      const frame = pluginFrame(page, "plugin-file-preview");
      await expect(frame.locator("#path")).toHaveText(`${HELLO_FILE} — 3 lines`);
      await expect(frame.locator("#lines li")).toHaveCount(3);
      await expect(frame.locator("#lines li").nth(1)).toContainText("beta");

      await captureQaScreenshot(page, "file-preview");

      // The user can always get back to the built-in view, and back again.
      await page.getByTestId("file-mode-source").click();
      await expect(page.getByTestId("file-source-editor")).toBeVisible();
      await expect(page.getByTestId("plugin-file-preview")).toBeHidden();
      await expect(page.getByTestId("file-source-editor")).toContainText("gamma");

      await page.getByTestId("file-mode-preview").click();
      await expect(page.getByTestId("plugin-file-preview")).toBeVisible();

      // An unavailable plugin must not take an extension hostage: `.broken` is
      // claimed by the plugin with the missing entry and still opens in code.
      await openWorkspaceFile(page, BROKEN_FILE);
      await expect(page.getByTestId("file-source-editor")).toBeVisible();
      await expect(page.getByTestId("file-source-editor")).toContainText("nothing renders this");
      await expect(page.getByTestId("plugin-file-preview")).toBeHidden();
    } finally {
      await session.cleanup();
    }
  });

  test("the plugin's sidebar panel gets a tab and renders with the workspace context", async ({
    page,
  }) => {
    const session = await seedWorkspaceWithPluginFiles("plugin-sidebar-");
    try {
      await openAgentRoute(page, session);
      await ensureExplorerOpen(page);

      const petTab = page.getByTestId(PET_TAB);
      await expect(petTab).toBeVisible();
      await expect(petTab).toContainText("Pet");
      await petTab.click();

      const panel = page.getByTestId(`plugin-sidebar-${HELLO_PLUGIN_ID}`);
      await expect(panel).toBeVisible({ timeout: 30_000 });
      // The panel context carries the workspace cwd; the plugin prints it.
      await expect(
        pluginFrame(page, `plugin-sidebar-${HELLO_PLUGIN_ID}`).locator("#cwd"),
      ).toHaveText(session.cwd);

      await captureQaScreenshot(page, "sidebar-panel");
    } finally {
      await session.cleanup();
    }
  });

  test("disabling the plugin removes its preview and its sidebar tab; re-enabling restores them", async ({
    page,
  }) => {
    const session = await seedWorkspaceWithPluginFiles("plugin-disable-");
    try {
      await gotoAppShell(page);
      await openSettings(page);
      await openPluginsSettings(page);
      await setPluginEnabled(page, HELLO_PLUGIN_ID, false);

      await openAgentRoute(page, session);
      await ensureExplorerOpen(page);
      await expect(page.getByTestId(PET_TAB)).toBeHidden();

      await openWorkspaceFile(page, HELLO_FILE);
      await expect(page.getByTestId("file-source-editor")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("file-source-editor")).toContainText("alpha");
      await expect(page.getByTestId("plugin-file-preview")).toBeHidden();

      await gotoAppShell(page);
      await openSettings(page);
      await openPluginsSettings(page);
      await setPluginEnabled(page, HELLO_PLUGIN_ID, true);

      await openAgentRoute(page, session);
      await ensureExplorerOpen(page);
      await expect(page.getByTestId(PET_TAB)).toBeVisible();

      await openWorkspaceFile(page, HELLO_FILE);
      await expect(page.getByTestId("plugin-file-preview")).toBeVisible({ timeout: 30_000 });
    } finally {
      await session.cleanup();
    }
  });
});
