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
  expectSettingsHeader,
  openCompactSettings,
  openHostSection,
  openSettingsHost,
} from "../support/helpers/settings";

import {
  startNpmRegistry,
  npmPluginPackages,
} from "../../../../scripts/test-support/npm-registry.mjs";

const test = base.extend<{}, { npmRegistry: Awaited<ReturnType<typeof startNpmRegistry>> }>({
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
  await expect(page.getByRole("textbox", { name: "Plugin source", exact: true })).toBeVisible();
}

async function reloadPlugin(page: Page): Promise<void> {
  await selectPluginAction(page, "e2e-plugin", "Reload");
  await expect(page.getByText("Reloaded e2e-plugin", { exact: true })).toBeVisible();
}

async function openPluginActions(page: Page, pluginId: string): Promise<void> {
  await page.getByRole("button", { name: `Actions for ${pluginId}`, exact: true }).click();
  await expect(page.getByRole("menuitem").first()).toBeVisible();
}

async function selectPluginAction(page: Page, pluginId: string, action: string): Promise<void> {
  await openPluginActions(page, pluginId);
  await page.getByRole("menuitem", { name: action, exact: true }).click();
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

async function installPlugin(page: Page, source: string): Promise<void> {
  await page.getByLabel("Plugin source").fill(source);
  await page.getByRole("button", { name: "Install plugin" }).click();
}

async function expectPluginSourceDocsOpen(page: Page): Promise<void> {
  const docsPagePromise = page.context().waitForEvent("page");
  await page.getByRole("link", { name: "Docs", exact: true }).click();
  const docsPage = await docsPagePromise;
  try {
    await docsPage.waitForURL("https://paseo.sh/docs/plugins/reference#plugin-sources", {
      waitUntil: "commit",
    });
  } finally {
    await docsPage.close();
  }
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
  id: string,
  description: string | undefined,
  title: string,
): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-row-e2e-"));
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

async function installFailedPlugin(
  page: Page,
  client: Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>,
  directory: string,
): Promise<void> {
  await client.installPluginSource({ source: directory });
  await writeFile(path.join(directory, "index.client.tsx"), "export default broken !!!");
  await client.reloadPlugin("failed-preview-plugin");
  await expect(page.getByLabel("failed-preview-plugin failed")).toBeVisible();
}

test("installs, reloads, recovers, disables, and removes a trusted local plugin", async ({
  page,
}, testInfo) => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-e2e-"));
  const disabledDirectory = await createDirectoryPlugin(
    "disabled-preview-plugin-with-a-long-name",
    "Keeps optional previews off until this plugin is enabled",
    "Preview plugin",
  );
  const failedDirectory = await createDirectoryPlugin(
    "failed-preview-plugin",
    "Demonstrates a plugin that needs attention",
    "Failed preview plugin",
  );
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previous = await client.getDaemonConfig();
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({
      id: "e2e-plugin",
      description: "Exercises the complete local plugin lifecycle",
      requirements: pluginRequirements,
    }),
  );
  await writeFile(path.join(directory, "index.client.tsx"), pluginSource("Plugin v1"));

  try {
    const catalog = observePluginCatalog(page);
    await gotoAppShell(page);
    await openPluginSettings(page);
    await catalog.waitForInitialFetch();
    await expect(page.getByRole("textbox", { name: "Plugin installation ID" })).toHaveCount(0);
    await expectPluginSourceDocsOpen(page);
    await client.patchDaemonConfig({ pluginsEnabled: false });
    await page.getByRole("switch", { name: "Enable plugins" }).click();
    await expect(page.getByText("Plugins enabled", { exact: true })).toBeVisible();
    await client.installPluginSource({ source: disabledDirectory });
    await client.disablePlugin("disabled-preview-plugin-with-a-long-name");
    await installFailedPlugin(page, client, failedDirectory);
    await page.getByLabel("Plugin source").fill(directory);
    await page.getByRole("button", { name: "Install plugin" }).click();
    await expect(page.getByText("Installed e2e-plugin", { exact: true })).toBeVisible();
    await expect(page.getByLabel("e2e-plugin running")).toBeVisible();
    await expect(page.getByText("Exercises the complete local plugin lifecycle")).toBeVisible();
    await expect(
      page.getByText("Keeps optional previews off until this plugin is enabled"),
    ).toBeVisible();
    await expect(page.getByText("Demonstrates a plugin that needs attention")).toBeVisible();
    await expect(
      page.getByLabel("disabled-preview-plugin-with-a-long-name disabled"),
    ).toBeVisible();
    await expect(page.getByLabel("failed-preview-plugin failed")).toBeVisible();
    await capturePluginInstallForm(page, testInfo, "wide");
    await openPluginActions(page, "e2e-plugin");
    await capturePluginInstallForm(page, testInfo, "wide-menu");
    await page.getByRole("menuitem", { name: "Logs", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("Logs: e2e-plugin");
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await openContributionFromSettings(page, "Plugin v1", "Plugin v1 cleanup 0");

    await openPluginSettings(page);
    await reloadPlugin(page);
    await openContributionFromSettings(page, "Plugin v1", "Plugin v1 cleanup 1");

    await writeFile(path.join(directory, "index.client.tsx"), pluginSource("Plugin v2"));
    await openPluginSettings(page);
    await reloadPlugin(page);
    await openContributionFromSettings(page, "Plugin v2", "Plugin v2 cleanup 2");
    await expect(page.getByRole("button", { name: "Plugin v1", exact: true })).not.toBeVisible();

    await writeFile(
      path.join(directory, "index.client.tsx"),
      pluginSource("Broken surface", "render exploded"),
    );
    await openPluginSettings(page);
    await reloadPlugin(page);
    await openContributionFromSettings(page, "Broken surface", "Plugin failed: render exploded");
    await openContribution(page, "Healthy surface", "Healthy contribution");
    await openContribution(page, "Broken surface", "Plugin failed: render exploded");

    await writeFile(path.join(directory, "index.client.tsx"), pluginSource("Recovered surface"));
    await reloadActiveContribution(page, client, "Recovered surface cleanup 4");
    await expect(
      page.getByRole("button", { name: "Broken surface", exact: true }),
    ).not.toBeVisible();

    await writeFile(path.join(directory, "index.client.tsx"), "export default broken syntax !!!");
    await openPluginSettings(page);
    await selectPluginAction(page, "e2e-plugin", "Reload");
    await expect(page.getByTestId("plugin-management-feedback")).toContainText("Request failed");
    await expect(page.getByLabel("e2e-plugin failed")).toBeVisible();
    await leavePluginSettings(page);
    await expectContributionRemoved(page, "Recovered surface");

    await writeFile(path.join(directory, "index.client.tsx"), pluginSource("Plugin v3"));
    await openPluginSettings(page);
    await selectPluginAction(page, "e2e-plugin", "Reload");
    await expect(page.getByLabel("e2e-plugin running")).toBeVisible();
    await openContributionFromSettings(page, "Plugin v3", "Plugin v3 cleanup 5");

    await openPluginSettings(page);
    await page.getByRole("switch", { name: "e2e-plugin: Disable", exact: true }).click();
    await expect(page.getByLabel("e2e-plugin disabled")).toBeVisible();
    await leavePluginSettings(page);
    await expectContributionRemoved(page, "Plugin v3");

    await openPluginSettings(page);
    await page.getByRole("switch", { name: "e2e-plugin: Enable", exact: true }).click();
    await expect(page.getByLabel("e2e-plugin running")).toBeVisible();
    await openContributionFromSettings(page, "Plugin v3", "Plugin v3 cleanup 6");

    await openPluginSettings(page);
    page.once("dialog", (dialog) => dialog.accept());
    await selectPluginAction(page, "e2e-plugin", "Remove");
    await expect(page.getByTestId("plugin-row-e2e-plugin")).toHaveCount(0);

    await installPlugin(page, directory);
    await expect(page.getByLabel("e2e-plugin running")).toBeVisible();
    await gotoAppShell(page);
    await openContribution(page, "Plugin v3", "Plugin v3 cleanup 7");
  } finally {
    await client.removePlugin("e2e-plugin").catch(() => undefined);
    await client.removePlugin("disabled-preview-plugin-with-a-long-name").catch(() => undefined);
    await client.removePlugin("failed-preview-plugin").catch(() => undefined);
    await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled ?? false });
    await client.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
    await rm(disabledDirectory, { recursive: true, force: true });
    await rm(failedDirectory, { recursive: true, force: true });
  }
});

test("installs a Git source after a failed source remains editable", async ({ page }, testInfo) => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-plugin-git-e2e-"));
  const repository = await createGitPluginRepository(root);
  const longDirectory = await createDirectoryPlugin(
    "compact-plugin-with-a-realistically-long-name",
    "Shows how a realistically long plugin description wraps on a compact screen",
    "Compact long plugin",
  );
  const disabledDirectory = await createDirectoryPlugin(
    "compact-disabled-plugin",
    "Remains installed and ready to enable later",
    "Compact disabled plugin",
  );
  const missingSource = path.join(root, "missing-plugin");
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previous = await client.getDaemonConfig();

  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await client.installPluginSource({ source: longDirectory });
    await client.installPluginSource({ source: disabledDirectory });
    await client.disablePlugin("compact-disabled-plugin");
    await gotoAppShell(page);
    await openCompactPluginSettings(page);
    await expect(page.getByRole("textbox", { name: "Plugin installation ID" })).toHaveCount(0);
    await client.patchDaemonConfig({ pluginsEnabled: false });
    await page.getByRole("switch", { name: "Enable plugins" }).click();
    await expect(page.getByText("Plugins enabled", { exact: true })).toBeVisible();

    await installPlugin(page, missingSource);
    await expect(page.getByTestId("plugin-management-feedback")).toContainText(
      "Plugin source is neither an existing directory nor a Git URL",
    );
    await expect(page.getByLabel("Plugin source")).toHaveValue(missingSource);
    await capturePluginInstallForm(page, testInfo, "compact-error");

    await installPlugin(page, pathToFileURL(repository).href);
    await expect(page.getByText("Installed git-e2e-plugin", { exact: true })).toBeVisible();
    await expect(page.getByLabel("git-e2e-plugin running")).toBeVisible();
    await expect(
      page.getByText("Shows how a realistically long plugin description wraps on a compact screen"),
    ).toBeVisible();
    await expect(page.getByLabel("compact-disabled-plugin disabled")).toBeVisible();
    await expect(page.getByLabel("Plugin source")).toHaveValue("");
    await capturePluginInstallForm(page, testInfo, "compact-success");
    await openPluginActions(page, "git-e2e-plugin");
    const removeAction = page.getByRole("menuitem", { name: "Remove", exact: true });
    await expect(removeAction).toBeInViewport({ ratio: 1 });
    await waitForSettledPosition(removeAction);
    await capturePluginInstallForm(page, testInfo, "compact-menu");
    await page.keyboard.press("Escape");
  } finally {
    await client.removePlugin("git-e2e-plugin").catch(() => undefined);
    await client
      .removePlugin("compact-plugin-with-a-realistically-long-name")
      .catch(() => undefined);
    await client.removePlugin("compact-disabled-plugin").catch(() => undefined);
    await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled ?? false });
    await client.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await rm(longDirectory, { recursive: true, force: true });
    await rm(disabledDirectory, { recursive: true, force: true });
  }
});

for (const sourceSupport of [undefined, false]) {
  test(`keeps installed plugins manageable without source capability (${sourceSupport})`, async ({
    page,
  }) => {
    const directory = await createDirectoryPlugin(
      "legacy-source-plugin",
      undefined,
      "Legacy plugin",
    );
    const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
    const previous = await client.getDaemonConfig();
    try {
      await client.patchDaemonConfig({ pluginsEnabled: true });
      await client.installPluginSource({ source: directory });
      await advertisePluginCapabilities(page, {
        pluginSourceInstallation: sourceSupport,
        pluginGitManagement: true,
      });
      await gotoAppShell(page);
      await openPluginSettings(page);
      await expect(
        page.getByText("Update this host to install plugins", { exact: true }),
      ).toBeVisible();
      await expect(page.getByRole("textbox", { name: "Plugin source", exact: true })).toHaveCount(
        0,
      );
      await expect(page.getByText(directory, { exact: true })).toBeVisible();
      await selectPluginAction(page, "legacy-source-plugin", "Reload");
      await expect(page.getByText("Reloaded legacy-source-plugin", { exact: true })).toBeVisible();
    } finally {
      await client.removePlugin("legacy-source-plugin").catch(() => undefined);
      await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled ?? false });
      await client.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

for (const viewport of [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`installs an npm source and manages its row at ${viewport.width}px`, async ({
    page,
  }, testInfo) => {
    const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
    const previous = await client.getDaemonConfig();
    try {
      await page.setViewportSize(viewport);
      await advertisePluginCapabilities(page, { pluginGitManagement: false });
      await client.patchDaemonConfig({ pluginsEnabled: true });
      await gotoAppShell(page);
      await openNpmPluginSettings(page, viewport.width);
      await installPlugin(page, "npm:missing-plugin");
      await expect(page.getByTestId("plugin-management-feedback")).toContainText("404");
      await expect(page.getByLabel("Plugin source")).toHaveValue("npm:missing-plugin");
      await installPlugin(page, "npm:@paseo-fixture/review@^2.0.0");
      await expect(page.getByText("Installed npm-review", { exact: true })).toBeVisible();
      await expect(page.getByLabel("npm-review running")).toBeVisible();
      await expectSourceHierarchy(
        page,
        "Installed from the npm fixture registry",
        "npm:@paseo-fixture/review · 2.0.0",
      );
      await expect(
        page.getByText("Installed from the npm fixture registry", { exact: true }),
      ).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath(`npm-plugin-${viewport.width}.png`),
        animations: "disabled",
      });
      await selectPluginAction(page, "npm-review", "Reload");
      await expect(page.getByText("Reloaded npm-review", { exact: true })).toBeVisible();
      page.once("dialog", (dialog) => dialog.accept());
      await selectPluginAction(page, "npm-review", "Remove");
      await expect(page.getByText("Removed npm-review", { exact: true })).toBeVisible();
      await expect(page.getByLabel("npm-review running")).toHaveCount(0);
    } finally {
      await client.removePlugin("npm-review").catch(() => undefined);
      await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled ?? false });
      await client.close();
    }
  });
}

async function openNpmPluginSettings(page: Page, width: number) {
  if (width < 600) await openCompactPluginSettings(page);
  else await openPluginSettings(page);
}

async function expectSourceHierarchy(page: Page, description: string, source: string) {
  const descriptionText = page.getByText(description, { exact: false });
  const sourceText = page.getByText(source, { exact: false });
  const descriptionSize = await descriptionText.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).fontSize),
  );
  const sourceSize = await sourceText.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).fontSize),
  );
  expect(sourceSize).toBeLessThan(descriptionSize);
  await expect(sourceText).toHaveCSS("color", "rgb(161, 161, 170)");
  await expect(descriptionText).toHaveCSS("color", "rgb(113, 113, 122)");
}
