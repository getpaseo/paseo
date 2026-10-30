import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Locator, TestInfo } from "@playwright/test";
import { expect, test as base, type Page } from "../fixtures";
import { gotoAppShell, openSettings } from "./app";
import { openModelPicker } from "./agent-profiles";
import { openAgentRoute } from "./mock-agent";
import { connectNewWorkspaceDaemonClient, openGlobalNewWorkspaceComposer } from "./new-workspace";
import { copyPluginExample, pluginRequirements } from "./plugin-fixture";
import { seedWorkspace, type SeededWorkspace } from "./seed-client";
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
  await openModelPicker(page);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.getByText("Direct provider example", { exact: true }).click();
  await page.getByText("Example 1", { exact: true }).click();
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
  client: Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>;
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
            await provide({ page, testInfo, iconPaths, workspace, client });
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
  await test.step("new workspace keeps the picker icon on its selected model button", async () => {
    await openGlobalNewWorkspaceComposer(page);
    await selectPluginModel(page);
    await openModelPicker(page);
    await expectProviderIcon(page.getByTestId("model-row-direct-example-example-1"), iconPaths);
    await capture(page, testInfo, "new-workspace-picker");
    await page.keyboard.press("Escape");
    await expectProviderIcon(
      page.getByRole("button", { name: MODEL_LABEL, exact: true }),
      iconPaths,
    );
    await capture(page, testInfo, "new-workspace-selected-model");
  });
}

export async function verifyCompactModelIcon({
  page,
  iconPaths,
  testInfo,
}: ProviderIconJourney): Promise<void> {
  await test.step("compact composer preserves the same provider icon", async () => {
    await page.setViewportSize(COMPACT);
    await expectProviderIcon(
      page.getByRole("button", { name: MODEL_LABEL, exact: true }),
      iconPaths,
    );
    await capture(page, testInfo, "compact-selected-model");
  });
}

export async function verifyExistingAgentModelIcon({
  page,
  iconPaths,
  testInfo,
  workspace,
}: ProviderIconJourney): Promise<void> {
  await test.step("existing agent composer uses the same icon", async () => {
    const agent = await workspace.client.createAgent({
      provider: "direct-example",
      model: "example-1",
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: "Plugin icon agent",
    });
    await page.setViewportSize(WIDE);
    await openAgentRoute(page, { workspaceId: workspace.workspaceId, agentId: agent.id });
    await expectProviderIcon(
      page.getByRole("button", { name: MODEL_LABEL, exact: true }),
      iconPaths,
    );
    await capture(page, testInfo, "agent-selected-model");
  });
}

const OVERRIDE_PLUGIN_ID = "provider-icon-overrides-example";
const CUSTOM_OVERRIDE_PATH = "M3 12L12 3L21 12L12 21Z";
const BUILTIN_OVERRIDE_PATH = "M4 4H20V20H4ZM8 8V16H16V8Z";

function overrideSource(customSvg: string): string {
  return `import type { PluginClientContext } from "@getpaseo/plugin/client";
export default function contribute(client: PluginClientContext) {
  client.addProviderIconOverride({ id: "custom", provider: "direct-example", icon: { svg: ${JSON.stringify(customSvg)} } });
  client.addProviderIconOverride({ id: "builtin", provider: "codex", icon: { svg: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="${BUILTIN_OVERRIDE_PATH}" /></svg>' } });
  return () => {};
}`;
}

export async function verifyProviderIconOverrides(journey: ProviderIconJourney): Promise<void> {
  const { page, client, testInfo, iconPaths } = journey;
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-provider-icon-overrides-"));
  const clientPath = path.join(directory, "index.client.ts");
  const pageErrors: string[] = [];
  const onPageError = (error: Error) => pageErrors.push(error.message);
  page.on("pageerror", onPageError);
  let installed = false;
  try {
    await openSettings(page);
    await openSettingsHostSection(page, getServerId(), "providers");
    const builtin = page.getByRole("button", { name: "Codex provider details", exact: true });
    await expect(builtin).toBeVisible();
    // ProviderRow draws its navigation chevron first and provider mark second.
    // LoadingSpinner is a separate, transient SVG in the status label after them.
    const builtinMark = builtin.locator("svg").nth(1);
    await expect(builtinMark).toBeVisible();
    const originalBuiltin = await builtinMark.evaluateAll(readIconDrawings);

    await test.step("a client plugin overrides both built-in and plugin-provided icons", async () => {
      await writeFile(
        path.join(directory, "paseo-plugin.json"),
        JSON.stringify({ id: OVERRIDE_PLUGIN_ID, requirements: pluginRequirements }),
      );
      await writeFile(
        clientPath,
        overrideSource(
          `<svg viewBox="0 0 24 24"><path fill="currentColor" d="${CUSTOM_OVERRIDE_PATH}" /></svg>`,
        ),
      );
      await client.installDirectoryPlugin(directory);
      installed = true;
      await expectProviderIcon(builtin, [BUILTIN_OVERRIDE_PATH]);
      await expectProviderIcon(
        page.getByRole("button", { name: "Direct provider example provider details", exact: true }),
        [CUSTOM_OVERRIDE_PATH],
      );
      await capture(page, testInfo, "provider-icon-overrides");
      await page.getByTestId("settings-back-to-workspace").click();
      await verifyNewWorkspaceModelIcon({ ...journey, iconPaths: [CUSTOM_OVERRIDE_PATH] });
    });

    await test.step("malformed SVG falls back without breaking the selected model control", async () => {
      const selected = page.getByRole("button", { name: MODEL_LABEL, exact: true });
      const iconCount = await selected.locator("svg").count();
      await writeFile(clientPath, overrideSource('<svg viewBox="0 0 24 24"><path'));
      await client.reloadPlugin(OVERRIDE_PLUGIN_ID);
      await expect
        .poll(() => selected.locator("svg").evaluateAll(readIconDrawings))
        .not.toContainEqual([CUSTOM_OVERRIDE_PATH]);
      await expect(selected).toBeVisible();
      await expect(selected.locator("svg")).toHaveCount(iconCount);
      await openModelPicker(page);
      await expect(page.getByTestId("model-row-direct-example-example-1")).toBeVisible();
      await page.keyboard.press("Escape");
      expect(pageErrors).toEqual([]);
    });

    await test.step("removing the override restores the host SVG and built-in mark immediately", async () => {
      await client.removePlugin(OVERRIDE_PLUGIN_ID);
      installed = false;
      await expectProviderIcon(
        page.getByRole("button", { name: MODEL_LABEL, exact: true }),
        iconPaths,
      );
      await openSettings(page);
      await openSettingsHostSection(page, getServerId(), "providers");
      await expect.poll(() => builtinMark.evaluateAll(readIconDrawings)).toEqual(originalBuiltin);
      await expect
        .poll(() => builtin.locator("svg").evaluateAll(readIconDrawings))
        .not.toContainEqual([BUILTIN_OVERRIDE_PATH]);
      await expectProviderIcon(
        page.getByRole("button", { name: "Direct provider example provider details", exact: true }),
        iconPaths,
      );
      await capture(page, testInfo, "provider-icons-restored");
    });
  } finally {
    page.off("pageerror", onPageError);
    try {
      if (installed) await client.removePlugin(OVERRIDE_PLUGIN_ID);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
