import { existsSync } from "node:fs";
import overviewCorpus from "../../../protocol/tests/fixtures/plugin-overview.json";
import { pluginRequirements } from "../support/helpers/plugin-fixture";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { TestInfo } from "@playwright/test";
import { buildOpenProjectRoute } from "@/utils/host-routes";
import { expect, test as base, type Page } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
import { getServerId } from "../support/helpers/server-id";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { waitForSettledPosition } from "../support/helpers/sheet-layout";
import {
  backToPlugins,
  clearSearch,
  closePluginLogs,
  expectGalleryMenuWithoutSourceInstall,
  expectPluginActionPending,
  expectPluginFailed,
  expectPluginHealthy,
  expectPluginOff,
  expectPluginOn,
  expectPluginRemoved,
  expectPluginsOff,
  expectPluginsOn,
  expectPluginsRoute,
  expectSourceInstallFailed,
  expectSourceInstallTurnsPluginsOn,
  expectSourceInstalled,
  expectToast,
  expectUpdateAvailable,
  installFromSource,
  openPluginLogs,
  openPluginPage,
  openPluginPageActions,
  openSourceInstall,
  pluginRow,
  reloadPluginFromPage,
  removePluginFromPage,
  searchInstalled,
  selectInstalledTab,
  selectPluginPageAction,
  submitSourceInstall,
  turnOffPluginsFromMenu,
  turnOnPluginsFromAlert,
  turnOnPluginsFromMenu,
  turnPluginOff,
  turnPluginOn,
  updatePlugin,
} from "../support/helpers/plugin-gallery";
import {
  expectSettingsHeader,
  openCompactSettings,
  openHostSection,
  openSettingsHost,
} from "../support/helpers/settings";

import {
  startNpmRegistry,
  npmPluginPackages,
} from "../../../../scripts/test-support/npm-registry.mjs";

interface PluginEnvironment {
  client: Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>;
  directory: string;
}

const test = base.extend<
  { pluginEnvironment: PluginEnvironment },
  { npmRegistry: Awaited<ReturnType<typeof startNpmRegistry>> }
>({
  pluginEnvironment: async ({ e2eWorker: _e2eWorker }, provide) => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugins-e2e-"));
    const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
    const previous = await client.getDaemonConfig();
    try {
      await provide({ client, directory });
    } finally {
      try {
        const current = await client.getDaemonConfig();
        const existingIds = new Set(Object.keys(previous.config.plugins ?? {}));
        for (const id of Object.keys(current.config.plugins ?? {})) {
          if (!existingIds.has(id)) await client.removePlugin(id);
        }
      } finally {
        try {
          await client.patchDaemonConfig({
            pluginsEnabled: previous.config.pluginsEnabled ?? false,
          });
        } finally {
          try {
            await client.close();
          } finally {
            await rm(directory, { recursive: true, force: true });
          }
        }
      }
    }
  },
  npmRegistry: [
    async ({ browserName: _browserName }, provide) => {
      const registry = await startNpmRegistry(npmPluginPackages());
      try {
        await provide(registry);
      } finally {
        await registry.close();
      }
    },
    { scope: "worker" },
  ],
  e2eDaemonEnvironment: [
    async ({ npmRegistry }, provide) => {
      await provide(npmRegistry.env);
    },
    { scope: "worker" },
  ],
});

async function advertisePluginCapabilities(
  page: Page,
  features: Record<string, boolean | undefined>,
): Promise<void> {
  await page.routeWebSocket(daemonWsRoutePattern(), (browser) => {
    const server = browser.connectToServer();
    browser.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      if (typeof message !== "string") {
        browser.send(message);
        return;
      }
      const envelope = JSON.parse(message);
      if (
        envelope.message?.type === "status" &&
        envelope.message.payload?.status === "server_info"
      ) {
        Object.assign(envelope.message.payload.features, features);
      }
      browser.send(JSON.stringify(envelope));
    });
  });
}

function observePluginCatalog(page: Page) {
  let responses = 0;
  page.on("websocket", (socket) => {
    socket.on("framereceived", ({ payload }) => {
      if (typeof payload !== "string") return;
      try {
        const envelope = JSON.parse(payload) as {
          type?: unknown;
          message?: { type?: unknown };
        };
        const message = envelope.type === "session" ? envelope.message : envelope;
        if (message?.type === "plugin.catalog.get.response") responses += 1;
      } catch {
        return;
      }
    });
  });
  return {
    waitForInitialFetch: async () => {
      await expect.poll(() => responses).toBeGreaterThan(0);
    },
  };
}

function pluginSource(title: string, renderError?: string): string {
  return `import React from "react";
import { Text } from "react-native";
export default function contribute(plugin) {
  function Surface() {
    ${renderError ? `throw new Error(${JSON.stringify(renderError)});` : ""}
    const cleanups = Number(globalThis.sessionStorage?.getItem("paseo-plugin-cleanups") || "0");
    return <Text>${title} cleanup {cleanups}</Text>;
  }
  plugin.addSurface("main", Surface);
  plugin.addSidebarItem({ id: "main", title: ${JSON.stringify(title)}, icon: "Blocks", surface: "main" });
  ${
    renderError
      ? `function HealthySurface() { return <Text>Healthy contribution</Text>; }
  plugin.addSurface("healthy", HealthySurface);
  plugin.addSidebarItem({ id: "healthy", title: "Healthy surface", icon: "Blocks", surface: "healthy" });`
      : ""
  }
  return () => {
    const storage = globalThis.sessionStorage;
    if (storage) {
      const cleanups = Number(storage.getItem("paseo-plugin-cleanups") || "0");
      storage.setItem("paseo-plugin-cleanups", String(cleanups + 1));
    }
  };
}`;
}

async function openPluginSettings(page: Page): Promise<void> {
  const serverId = getServerId();
  await openSettings(page);
  await openSettingsHost(page, serverId);
  await openHostSection(page, serverId, "plugins");
  await expectSettingsHeader(page, "Plugins");
}

async function openCompactPluginSettings(page: Page): Promise<void> {
  const serverId = getServerId();
  await openCompactSettings(page, buildOpenProjectRoute());
  await openHostSection(page, serverId, "plugins");
  await expect(page.getByRole("button", { name: /^Installed/ })).toBeVisible();
}

async function openPluginPageFromSettings(page: Page, name: string): Promise<void> {
  await openPluginSettings(page);
  await openPluginPage(page, name);
}

async function expectContributionBody(page: Page, expectedBody: string): Promise<void> {
  const body = page.getByText(expectedBody, { exact: true }).filter({ visible: true });
  await expect(body).toHaveCount(1);
  await expect(body).toBeVisible();
}

async function openContribution(page: Page, title: string, expectedBody: string): Promise<void> {
  await page.getByRole("button", { name: title, exact: true }).click();
  await expectContributionBody(page, expectedBody);
}

async function leavePluginSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page).not.toHaveURL(/\/settings\//);
}

async function openContributionFromSettings(
  page: Page,
  title: string,
  expectedBody: string,
): Promise<void> {
  await leavePluginSettings(page);
  await openContribution(page, title, expectedBody);
}

async function reloadActiveContribution(
  page: Page,
  client: Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>,
  expectedBody: string,
): Promise<void> {
  await client.reloadPlugin("e2e-plugin");
  await expectContributionBody(page, expectedBody);
}

async function expectContributionRemoved(page: Page, title: string): Promise<void> {
  await expect(page.getByRole("button", { name: title, exact: true })).not.toBeVisible();
}

async function capturePluginInstallForm(
  page: Page,
  testInfo: TestInfo,
  name: "wide" | "wide-menu" | "compact-error" | "compact-success" | "compact-menu",
): Promise<void> {
  await page.screenshot({
    path: testInfo.outputPath(`plugin-source-install-${name}.png`),
    fullPage: true,
    animations: "disabled",
  });
}

async function expectPluginSourceDocsOpen(page: Page): Promise<void> {
  const requestedPage = page
    .context()
    .waitForEvent(
      "request",
      (request) => request.isNavigationRequest() && request.url().startsWith("https://paseo.sh/"),
    );
  const docsPagePromise = page.context().waitForEvent("page");
  await page.getByRole("link", { name: "Docs", exact: true }).click();
  const request = await requestedPage;
  const docsPage = await docsPagePromise;
  try {
    expect(new URL(request.url()).pathname).toBe("/docs/plugins/reference");
    // The deployed site can redirect while the matching website change is still in this PR.
    await docsPage.waitForURL(
      (url) => url.origin === "https://paseo.sh" && url.hash === "#plugin-sources",
      { waitUntil: "commit" },
    );
  } finally {
    await docsPage.close();
  }
}

function commitAll(repository: string, message: string): void {
  execFileSync("git", ["add", "-A"], { cwd: repository, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", message], { cwd: repository, stdio: "ignore" });
}

/** A new commit on the remote is an update for a plugin installed from that Git repository. */
async function publishGitPluginChange(repository: string, title: string): Promise<void> {
  await writeFile(path.join(repository, "index.client.tsx"), pluginSource(title));
  commitAll(repository, title);
}

async function createGitPluginRepository(root: string): Promise<string> {
  const repository = path.join(root, "repository");
  await mkdir(repository);
  await writeFile(
    path.join(repository, "paseo-plugin.json"),
    JSON.stringify({
      id: "git-e2e-plugin",
      description: "Adds review tools from a Git repository",
      requirements: pluginRequirements,
    }),
  );
  await writeFile(path.join(repository, "index.client.tsx"), pluginSource("Git plugin"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repository, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Paseo Tests"], {
    cwd: repository,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.email", "paseo@example.test"], {
    cwd: repository,
    stdio: "ignore",
  });
  execFileSync("git", ["add", "-A"], { cwd: repository, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repository, stdio: "ignore" });
  return repository;
}

async function createDirectoryPlugin(
  root: string,
  id: string,
  description: string | undefined,
  title: string,
): Promise<string> {
  const directory = await mkdtemp(path.join(root, "plugin-row-"));
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({ id, description, requirements: pluginRequirements }),
  );
  await writeFile(
    path.join(directory, "index.client.tsx"),
    `import React from "react";
import { Text } from "react-native";
export default function contribute(plugin) {
  function Surface() { return <Text>${title}</Text>; }
  plugin.addSurface("main", Surface);
  plugin.addSidebarItem({ id: "main", title: ${JSON.stringify(title)}, icon: "Blocks", surface: "main" });
  return () => undefined;
}`,
  );
  return directory;
}

/** Build command that holds the plugin lifecycle queue until the test writes the release file. */
const gatedBuildCommand = [
  'const fs = require("node:fs");',
  'fs.writeFileSync(process.argv[1], "started");',
  "const wait = () => {",
  "  if (fs.existsSync(process.argv[2])) return;",
  "  setTimeout(wait, 50);",
  "};",
  "wait();",
].join("\n");

async function createGatedBuildRepository(
  root: string,
  gate: { started: string; release: string },
): Promise<string> {
  const repository = path.join(root, "gated-repository");
  await mkdir(repository);
  await writeFile(
    path.join(repository, "paseo-plugin.json"),
    JSON.stringify({
      id: "gated-build-plugin",
      description: "Holds the plugin lifecycle queue while its build waits",
      requirements: pluginRequirements,
      build: [[process.execPath, "-e", gatedBuildCommand, gate.started, gate.release]],
    }),
  );
  await writeFile(path.join(repository, "index.client.tsx"), pluginSource("Gated build plugin"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repository, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Paseo Tests"], {
    cwd: repository,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.email", "paseo@example.test"], {
    cwd: repository,
    stdio: "ignore",
  });
  execFileSync("git", ["add", "-A"], { cwd: repository, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repository, stdio: "ignore" });
  return repository;
}

async function installFailedPlugin(
  client: Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>,
  directory: string,
): Promise<void> {
  await client.installPluginSource({ source: directory });
  await writeFile(path.join(directory, "index.client.tsx"), "export default broken !!!");
  await client.reloadPlugin("failed-preview-plugin");
}

test("installs, reloads, recovers, disables, and removes a trusted local plugin", async ({
  page,
  pluginEnvironment,
}, testInfo) => {
  const directory = await installLocalPluginWithStatusExamples(page, pluginEnvironment, testInfo);
  await reloadAndRecoverLocalPlugin(page, pluginEnvironment.client, directory);
  await toggleRemoveAndReinstallLocalPlugin(page, directory);
});

test("installs a Git source after a failed source remains editable, then updates it", async ({
  page,
  pluginEnvironment,
}, testInfo) => {
  const source = await prepareCompactGitInstall(page, pluginEnvironment);
  await retryGitInstallAndInspectRows(page, source, testInfo);
  await updateGitPlugin(page, source.repository);
  await expectCompactPluginMenuFits(page, testInfo);
  await failUpdateFromPluginPage(page, source.repository);
});

for (const sourceSupport of [undefined, false]) {
  test(`keeps installed plugins manageable without source capability (${sourceSupport})`, async ({
    page,
    pluginEnvironment,
  }) => {
    const directory = await prepareLegacyPluginHost(page, pluginEnvironment, sourceSupport);
    await verifyLegacyPluginManagement(page, directory);
  });
}

for (const viewport of [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`installs an npm source and manages it at ${viewport.width}px`, async ({
    page,
    pluginEnvironment,
  }, testInfo) => {
    await prepareNpmPluginHost(page, pluginEnvironment, viewport);
    await retryNpmInstallAndInspectRow(page, viewport.width, testInfo);
    await reloadAndRemoveNpmPlugin(page);
  });
}

async function openNpmPluginSettings(page: Page, width: number) {
  if (width < 600) await openCompactPluginSettings(page);
  else await openPluginSettings(page);
}

/** The row's description reads before where the plugin was installed from. */
async function expectSourceHierarchy(
  page: Page,
  pluginId: string,
  description: string,
  source: string,
) {
  const row = pluginRow(page, pluginId);
  await expect(row.getByText(description, { exact: true })).toHaveCSS(
    "color",
    "rgb(113, 113, 122)",
  );
  await expect(row.getByText(source, { exact: true })).toHaveCSS("color", "rgb(161, 161, 170)");
}

async function installLocalPluginWithStatusExamples(
  page: Page,
  pluginEnvironment: PluginEnvironment,
  testInfo: TestInfo,
) {
  const directory = await mkdtemp(path.join(pluginEnvironment.directory, "local-"));
  const disabledDirectory = await createDirectoryPlugin(
    pluginEnvironment.directory,
    "disabled-preview-plugin-with-a-long-name",
    "Keeps optional previews off until this plugin is enabled",
    "Preview plugin",
  );
  const failedDirectory = await createDirectoryPlugin(
    pluginEnvironment.directory,
    "failed-preview-plugin",
    "Demonstrates a plugin that needs attention",
    "Failed preview plugin",
  );
  const { client } = pluginEnvironment;
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({
      id: "e2e-plugin",
      description: "Exercises the complete local plugin lifecycle",
      requirements: pluginRequirements,
    }),
  );
  await writeFile(path.join(directory, "index.client.tsx"), pluginSource("Plugin v1"));
  await client.patchDaemonConfig({ pluginsEnabled: true });
  await client.installPluginSource({ source: disabledDirectory });
  await client.disablePlugin("disabled-preview-plugin-with-a-long-name");
  await installFailedPlugin(client, failedDirectory);

  const catalog = observePluginCatalog(page);
  await gotoAppShell(page);
  await openPluginSettings(page);
  await catalog.waitForInitialFetch();
  await expectPluginFailed(page, "failed-preview-plugin");

  // Plugins off on the host: the Installed tab says so and turns them back on.
  await client.patchDaemonConfig({ pluginsEnabled: false });
  await expectPluginsOff(page);
  await turnOnPluginsFromAlert(page);
  await turnOffPluginsFromMenu(page);
  await turnOnPluginsFromMenu(page);

  await openSourceInstall(page);
  await expectPluginSourceDocsOpen(page);
  await submitSourceInstall(page, directory);
  await expectSourceInstalled(page, "e2e-plugin");
  await expectPluginOn(page, "e2e-plugin");
  await expectPluginHealthy(page, "e2e-plugin");
  await expect(page.getByText("Exercises the complete local plugin lifecycle")).toBeVisible();
  await expect(
    page.getByText("Keeps optional previews off until this plugin is enabled"),
  ).toBeVisible();
  await expect(page.getByText("Demonstrates a plugin that needs attention")).toBeVisible();
  await expectPluginOff(page, "disabled-preview-plugin-with-a-long-name");
  await expectPluginFailed(page, "failed-preview-plugin");

  await searchInstalled(page, "needs attention");
  await expect(pluginRow(page, "failed-preview-plugin")).toBeVisible();
  await expect(pluginRow(page, "e2e-plugin")).toHaveCount(0);
  await clearSearch(page);
  await expect(pluginRow(page, "e2e-plugin")).toBeVisible();
  await capturePluginInstallForm(page, testInfo, "wide");

  await openPluginPage(page, "e2e-plugin");
  await openPluginPageActions(page, "e2e-plugin");
  await capturePluginInstallForm(page, testInfo, "wide-menu");
  await page.keyboard.press("Escape");
  await openPluginLogs(page, "e2e-plugin");
  await closePluginLogs(page);
  await openContributionFromSettings(page, "Plugin v1", "Plugin v1 cleanup 0");

  return directory;
}

async function reloadAndRecoverLocalPlugin(
  page: Page,
  client: PluginEnvironment["client"],
  directory: string,
) {
  await openPluginPageFromSettings(page, "e2e-plugin");
  await reloadPluginFromPage(page, "e2e-plugin");
  await openContributionFromSettings(page, "Plugin v1", "Plugin v1 cleanup 1");

  await writeFile(path.join(directory, "index.client.tsx"), pluginSource("Plugin v2"));
  await openPluginPageFromSettings(page, "e2e-plugin");
  await reloadPluginFromPage(page, "e2e-plugin");
  await openContributionFromSettings(page, "Plugin v2", "Plugin v2 cleanup 2");
  await expect(page.getByRole("button", { name: "Plugin v1", exact: true })).not.toBeVisible();

  await writeFile(
    path.join(directory, "index.client.tsx"),
    pluginSource("Broken surface", "render exploded"),
  );
  await openPluginPageFromSettings(page, "e2e-plugin");
  await reloadPluginFromPage(page, "e2e-plugin");
  await openContributionFromSettings(page, "Broken surface", "Plugin failed: render exploded");
  await openContribution(page, "Healthy surface", "Healthy contribution");
  await openContribution(page, "Broken surface", "Plugin failed: render exploded");

  await writeFile(path.join(directory, "index.client.tsx"), pluginSource("Recovered surface"));
  await reloadActiveContribution(page, client, "Recovered surface cleanup 4");
  await expect(page.getByRole("button", { name: "Broken surface", exact: true })).not.toBeVisible();

  await writeFile(path.join(directory, "index.client.tsx"), "export default broken syntax !!!");
  await openPluginPageFromSettings(page, "e2e-plugin");
  await selectPluginPageAction(page, "e2e-plugin", "Reload");
  await expectToast(page, "Request failed");
  await backToPlugins(page, "e2e-plugin");
  await expectPluginFailed(page, "e2e-plugin");
  await leavePluginSettings(page);
  await expectContributionRemoved(page, "Recovered surface");

  await writeFile(path.join(directory, "index.client.tsx"), pluginSource("Plugin v3"));
  await openPluginPageFromSettings(page, "e2e-plugin");
  await reloadPluginFromPage(page, "e2e-plugin");
  await backToPlugins(page, "e2e-plugin");
  await expectPluginHealthy(page, "e2e-plugin");
  await openContributionFromSettings(page, "Plugin v3", "Plugin v3 cleanup 5");
}

async function toggleRemoveAndReinstallLocalPlugin(page: Page, directory: string) {
  await openPluginSettings(page);
  await turnPluginOff(page, "e2e-plugin");
  await leavePluginSettings(page);
  await expectContributionRemoved(page, "Plugin v3");

  await openPluginSettings(page);
  await turnPluginOn(page, "e2e-plugin");
  await openContributionFromSettings(page, "Plugin v3", "Plugin v3 cleanup 6");

  await openPluginPageFromSettings(page, "e2e-plugin");
  await removePluginFromPage(page, "e2e-plugin");
  await expectPluginsRoute(page);
  await expectPluginRemoved(page, "e2e-plugin");

  await installFromSource(page, directory, "e2e-plugin");
  await expectPluginOn(page, "e2e-plugin");
  await gotoAppShell(page);
  await openContribution(page, "Plugin v3", "Plugin v3 cleanup 7");
}

async function prepareCompactGitInstall(page: Page, pluginEnvironment: PluginEnvironment) {
  const root = pluginEnvironment.directory;
  const repository = await createGitPluginRepository(root);
  const longDirectory = await createDirectoryPlugin(
    pluginEnvironment.directory,
    "compact-plugin-with-a-realistically-long-name",
    "Shows how a realistically long plugin description wraps on a compact screen",
    "Compact long plugin",
  );
  const disabledDirectory = await createDirectoryPlugin(
    pluginEnvironment.directory,
    "compact-disabled-plugin",
    "Remains installed and ready to enable later",
    "Compact disabled plugin",
  );
  const missingSource = path.join(root, "missing-plugin");
  const { client } = pluginEnvironment;

  await page.setViewportSize({ width: 390, height: 844 });
  await client.installPluginSource({ source: longDirectory });
  await client.installPluginSource({ source: disabledDirectory });
  await client.disablePlugin("compact-disabled-plugin");
  await gotoAppShell(page);
  await openCompactPluginSettings(page);
  await client.patchDaemonConfig({ pluginsEnabled: false });
  await expectPluginsOff(page);

  return { repository, missingSource };
}

async function retryGitInstallAndInspectRows(
  page: Page,
  source: { repository: string; missingSource: string },
  testInfo: TestInfo,
) {
  const { repository, missingSource } = source;

  await openSourceInstall(page);
  // Plugins are off, so the confirmation says installing turns them on.
  await expectSourceInstallTurnsPluginsOn(page);
  await submitSourceInstall(page, missingSource);
  await expectSourceInstallFailed(
    page,
    missingSource,
    `Plugin directory does not exist: ${missingSource}`,
  );
  await capturePluginInstallForm(page, testInfo, "compact-error");

  await submitSourceInstall(page, pathToFileURL(repository).href);
  await expectSourceInstalled(page, "git-e2e-plugin");
  await expectPluginsOn(page);
  await expectPluginOn(page, "git-e2e-plugin");
  await expect(
    page.getByText("Shows how a realistically long plugin description wraps on a compact screen"),
  ).toBeVisible();
  await expectPluginOff(page, "compact-disabled-plugin");
  await capturePluginInstallForm(page, testInfo, "compact-success");
}

async function updateGitPlugin(page: Page, repository: string) {
  await publishGitPluginChange(repository, "Git plugin v2");
  // Updates are checked when Plugins opens.
  await page.reload();
  await expectUpdateAvailable(page, "git-e2e-plugin");
  await updatePlugin(page, "git-e2e-plugin");
  await expectPluginOn(page, "git-e2e-plugin");
}

/** An update that fails on the plugin's page says why there, and offers Retry. */
async function failUpdateFromPluginPage(page: Page, repository: string) {
  await publishGitPluginChange(repository, "Git plugin v3");
  await page.reload();
  const update = page.getByTestId("plugin-update").filter({ visible: true });
  await expect(update).toHaveText("Update");
  // Rewriting the commit the page checked leaves its update pointing at a commit the remote no
  // longer serves. The next check offers the rewritten commit.
  execFileSync("git", ["commit", "--amend", "-m", "Git plugin v3, amended"], {
    cwd: repository,
    stdio: "ignore",
  });
  await update.click();
  await expect(update).toHaveText("Retry");
  await expect(page.getByText(/Git command failed/)).toBeVisible();
}

async function expectCompactPluginMenuFits(page: Page, testInfo: TestInfo) {
  await openPluginPage(page, "git-e2e-plugin");
  await openPluginPageActions(page, "git-e2e-plugin");
  const removeAction = page.getByRole("menuitem", { name: "Uninstall", exact: true });
  await expect(removeAction).toBeInViewport({ ratio: 1 });
  await waitForSettledPosition(removeAction);
  await capturePluginInstallForm(page, testInfo, "compact-menu");
  await page.keyboard.press("Escape");
}

async function prepareLegacyPluginHost(
  page: Page,
  pluginEnvironment: PluginEnvironment,
  sourceSupport: boolean | undefined,
) {
  const directory = await createDirectoryPlugin(
    pluginEnvironment.directory,
    "legacy-source-plugin",
    undefined,
    "Legacy plugin",
  );
  const { client } = pluginEnvironment;
  await client.patchDaemonConfig({ pluginsEnabled: true });
  await client.installPluginSource({ source: directory });
  await advertisePluginCapabilities(page, {
    pluginSourceInstallation: sourceSupport,
    pluginGitManagement: true,
  });
  await gotoAppShell(page);
  await openPluginSettings(page);

  return directory;
}

async function verifyLegacyPluginManagement(page: Page, directory: string) {
  await expect(
    pluginRow(page, "legacy-source-plugin").getByText(directory, { exact: true }),
  ).toBeVisible();
  await expectGalleryMenuWithoutSourceInstall(page);
  await openPluginPage(page, "legacy-source-plugin");
  await reloadPluginFromPage(page, "legacy-source-plugin");
}

async function prepareNpmPluginHost(
  page: Page,
  pluginEnvironment: PluginEnvironment,
  viewport: { width: number; height: number },
) {
  const { client } = pluginEnvironment;
  await page.setViewportSize(viewport);
  await advertisePluginCapabilities(page, { pluginGitManagement: false });
  await client.patchDaemonConfig({ pluginsEnabled: true });
  await gotoAppShell(page);
  await openNpmPluginSettings(page, viewport.width);
  await selectInstalledTab(page);
}

async function retryNpmInstallAndInspectRow(page: Page, width: number, testInfo: TestInfo) {
  await openSourceInstall(page);
  await submitSourceInstall(page, "npm:missing-plugin");
  await expectSourceInstallFailed(page, "npm:missing-plugin", "404");
  await submitSourceInstall(page, "npm:@paseo-fixture/review@^2.0.0");
  await expectSourceInstalled(page, "npm-review");
  await expectPluginOn(page, "npm-review");
  await expectSourceHierarchy(
    page,
    "npm-review",
    "Installed from the npm fixture registry",
    "npm:@paseo-fixture/review · 2.0.0",
  );
  await page.screenshot({
    path: testInfo.outputPath(`npm-plugin-${width}.png`),
    animations: "disabled",
  });
}

async function reloadAndRemoveNpmPlugin(page: Page) {
  await openPluginPage(page, "npm-review");
  await reloadPluginFromPage(page, "npm-review");
  await removePluginFromPage(page, "npm-review");
  await expectPluginsRoute(page);
  await expectPluginRemoved(page, "npm-review");
}

test("renders installed-plugin descriptions as plain text", async ({ page, pluginEnvironment }) => {
  const description = overviewCorpus.map(({ markdown }) => markdown).join("\n\n");
  await installPluginWithUntrustedDescription(pluginEnvironment, description);
  await gotoAppShell(page);
  await openPluginSettings(page);
  const text = page.getByText(description, { exact: true });
  await expect(text).toBeVisible();
  // This field must remain a text node, with no Markdown links, images, or HTML children.
  expect(await text.evaluate((element) => element.childElementCount)).toBe(0);
});

async function installPluginWithUntrustedDescription(
  environment: PluginEnvironment,
  description: string,
) {
  const directory = await createDirectoryPlugin(
    environment.directory,
    "plain-text-plugin",
    description,
    "Plain text plugin",
  );
  await environment.client.installPluginSource({ source: directory });
}

/** Waits for the reload request and the daemon's answer on the wire, so a scenario can measure it. */
function observePluginReload(page: Page) {
  const requests: number[] = [];
  const responses: number[] = [];
  const isSessionMessage = (payload: unknown, type: string): boolean => {
    if (typeof payload !== "string") return false;
    try {
      const envelope = JSON.parse(payload) as { type?: unknown; message?: { type?: unknown } };
      const message = envelope.type === "session" ? envelope.message : envelope;
      return message?.type === type;
    } catch {
      return false;
    }
  };
  page.on("websocket", (socket) => {
    // The reload request travels client -> daemon (outbound); the answer comes back inbound.
    socket.on("framesent", ({ payload }) => {
      if (isSessionMessage(payload, "plugin.reload.request")) requests.push(Date.now());
    });
    socket.on("framereceived", ({ payload }) => {
      if (isSessionMessage(payload, "plugin.reload.response")) responses.push(Date.now());
    });
  });
  return {
    waitForRequest: () => expect.poll(() => requests.length, { timeout: 30_000 }).toBe(1),
    waitForResponse: () => expect.poll(() => responses.length, { timeout: 120_000 }).toBe(1),
    requestedAt: () => requests[0]!,
    requestCount: () => requests.length,
  };
}

/** Starts a gated git install that holds the daemon's plugin lifecycle queue until it is released. */
async function holdPluginLifecycleQueue(
  client: PluginEnvironment["client"],
  root: string,
): Promise<{ release: () => Promise<void>; settle: () => Promise<void> }> {
  const gate = {
    started: path.join(root, "build-started"),
    release: path.join(root, "build-release"),
  };
  const repository = await createGatedBuildRepository(root, gate);
  const install = client.installPluginSource({ source: `git:${pathToFileURL(repository).href}` });
  // The marker wait below can outlive an early failure: a refused preparation, a dropped
  // connection, or a build command that exits before writing its marker. Handle that rejection now
  // so it never surfaces as an unhandled one, and drain the same promise in finish().
  const installDrained = install.catch(() => undefined);
  // Every path releases the gate and drains the install: a build still polling for its gate holds
  // the daemon's plugin lifecycle queue open, and the fixture's own plugin removal would stall.
  const finish = async () => {
    await writeFile(gate.release, "go").catch(() => undefined);
    await installDrained;
  };
  try {
    // Whichever comes first decides the scenario: the build reports that it started, or the setup
    // fails with the daemon's own error instead of a bare marker timeout.
    await Promise.race([
      expect.poll(() => existsSync(gate.started), { timeout: 30_000 }).toBe(true),
      install,
    ]);
  } catch (error) {
    // Setup that never reached the build must not hand the caller a queue it cannot settle.
    await finish();
    throw error;
  }
  return {
    release: () => writeFile(gate.release, "go"),
    settle: finish,
  };
}

async function capturePluginSurface(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: testInfo.outputPath(name),
    fullPage: true,
    animations: "disabled",
  });
}

/** The wait under test is the daemon's lifecycle queue, so the scenario has to spend real time. */
async function waitPastFormerReloadDeadline(page: Page, requestedAt: number): Promise<void> {
  const remaining = 66_000 - (Date.now() - requestedAt);
  if (remaining > 0) await page.waitForTimeout(remaining);
}

test("keeps Reload pending past a minute while the plugin queue is busy", async ({
  page,
  pluginEnvironment,
}, testInfo) => {
  test.setTimeout(180_000);
  const { client, directory } = pluginEnvironment;
  const pluginDirectory = await createDirectoryPlugin(
    directory,
    "e2e-plugin",
    "Exercises the complete local plugin lifecycle",
    "Plugin v1",
  );

  // Observe before the app loads: its daemon socket comes up with the page.
  const reload = observePluginReload(page);
  await gotoAppShell(page);
  // Plugins on is a precondition here, not the subject: set it through the daemon.
  await client.patchDaemonConfig({ pluginsEnabled: true });
  await client.installPluginSource({ source: pluginDirectory });
  // Installed before Plugins opens, so it opens on the Installed tab.
  await openPluginSettings(page);
  await expectPluginOn(page, "e2e-plugin");
  await openPluginPage(page, "e2e-plugin");

  const queue = await holdPluginLifecycleQueue(client, directory);
  try {
    await selectPluginPageAction(page, "e2e-plugin", "Reload");
    await reload.waitForRequest();
    // Pending: the plugin's controls stay disabled, so a second action cannot be submitted.
    await expectPluginActionPending(page, "e2e-plugin");
    await capturePluginSurface(page, testInfo, "plugin-reload-pending.png");

    await waitPastFormerReloadDeadline(page, reload.requestedAt());

    // Past the former deadline the reload is still pending; a request timeout would have settled
    // it and released the switch.
    await expectPluginActionPending(page, "e2e-plugin");
    await expect(page.getByTestId("app-toast-message")).toHaveCount(0);
    await capturePluginSurface(page, testInfo, "plugin-reload-past-deadline.png");

    await queue.release();
    // The daemon's answer only arrives once the plugin really started again.
    await reload.waitForResponse();
    expect(reload.requestCount()).toBe(1);
    await expectToast(page, "Reloaded e2e-plugin");
    await expectPluginOn(page, "e2e-plugin");
    await capturePluginSurface(page, testInfo, "plugin-reload-completed.png");
  } finally {
    await queue.settle();
  }
});
