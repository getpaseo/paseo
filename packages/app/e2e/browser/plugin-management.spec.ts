import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { getServerId } from "../support/helpers/server-id";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import {
  expectSettingsHeader,
  openHostSection,
  openSettingsHost,
} from "../support/helpers/settings";

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

async function reloadPlugin(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(page.getByText("Reloaded e2e-plugin", { exact: true })).toBeVisible();
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

test("installs, reloads, recovers, disables, and removes a trusted local plugin", async ({
  page,
}) => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-e2e-"));
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previous = await client.getDaemonConfig();
  await writeFile(path.join(directory, "paseo-plugin.json"), JSON.stringify({ id: "e2e-plugin" }));
  await writeFile(path.join(directory, "index.client.tsx"), pluginSource("Plugin v1"));

  try {
    const catalog = observePluginCatalog(page);
    await gotoAppShell(page);
    await openPluginSettings(page);
    await catalog.waitForInitialFetch();
    await client.patchDaemonConfig({ pluginsEnabled: false });
    await page.getByRole("switch", { name: "Enable plugins" }).click();
    await expect(page.getByText("Plugins enabled", { exact: true })).toBeVisible();
    await page.getByLabel("Plugin directory").fill(directory);
    await page.getByLabel("Plugin installation ID").focus();
    await expect(page.getByLabel("Plugin installation ID")).toHaveValue("e2e-plugin");
    await page.getByRole("button", { name: "Install directory" }).click();
    await expect(page.getByText("Installed e2e-plugin", { exact: true })).toBeVisible();
    await expect(page.getByLabel("e2e-plugin running")).toBeVisible();
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
    await page.getByRole("button", { name: "Reload", exact: true }).click();
    await expect(page.getByTestId("plugin-management-feedback")).toContainText("Request failed");
    await expect(page.getByLabel("e2e-plugin failed")).toBeVisible();
    await leavePluginSettings(page);
    await expectContributionRemoved(page, "Recovered surface");

    await writeFile(path.join(directory, "index.client.tsx"), pluginSource("Plugin v3"));
    await openPluginSettings(page);
    await page.getByRole("button", { name: "Reload", exact: true }).click();
    await expect(page.getByLabel("e2e-plugin running")).toBeVisible();
    await openContributionFromSettings(page, "Plugin v3", "Plugin v3 cleanup 5");

    await openPluginSettings(page);
    await page.getByRole("button", { name: "Disable", exact: true }).click();
    await expect(page.getByLabel("e2e-plugin disabled")).toBeVisible();
    await leavePluginSettings(page);
    await expectContributionRemoved(page, "Plugin v3");

    await openPluginSettings(page);
    await page.getByRole("button", { name: "Enable", exact: true }).click();
    await expect(page.getByLabel("e2e-plugin running")).toBeVisible();
    await openContributionFromSettings(page, "Plugin v3", "Plugin v3 cleanup 6");

    await openPluginSettings(page);
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(page.getByText("No plugins configured", { exact: true })).toBeVisible();

    await page.getByLabel("Plugin directory").fill(directory);
    await page.getByRole("button", { name: "Install directory" }).click();
    await expect(page.getByLabel("e2e-plugin running")).toBeVisible();
    await gotoAppShell(page);
    await openContribution(page, "Plugin v3", "Plugin v3 cleanup 7");
  } finally {
    await client.removePlugin("e2e-plugin").catch(() => undefined);
    await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled ?? false });
    await client.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});
