import fs from "node:fs";
import path from "node:path";
import { expect } from "@playwright/test";

export function seedPluginLinks(paseoHome, workspaceId, url, remoteWorkspaceId) {
  const directory = path.join(paseoHome, "link-plugin");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({ id: "link-check", requirements: { paseo: ">=0.8.0" } }),
  );
  fs.writeFileSync(
    path.join(directory, "index.client.tsx"),
    `
import { useState } from "react";
import { View, Text, Pressable } from "react-native";
import { openExternalUrl } from "@getpaseo/plugin/client";
import { ExternalLink } from "@getpaseo/plugin/client/ui";
function Links({ navigation }) {
  const [result, setResult] = useState("Ready");
  return <View>
    <Text>{result}</Text>
    <Pressable accessibilityRole="button" onPress={() => { window.open(${JSON.stringify(url)}, "_blank", "noopener,noreferrer"); }}><Text>Old documentation workaround</Text></Pressable>
    <Pressable accessibilityRole="button" onPress={async () => { try { await openExternalUrl(${JSON.stringify(url)}); setResult("Opened externally"); } catch (error) { setResult(String(error)); } }}><Text>Open externally</Text></Pressable>
    {ExternalLink ? <ExternalLink href={${JSON.stringify(url)}}>Documentation link</ExternalLink> : null}
    <Pressable accessibilityRole="button" onPress={() => navigation.openBrowser({ url: ${JSON.stringify(url)}, workspaceId: ${JSON.stringify(remoteWorkspaceId)}, serverId: "plugin-links-remote" })}><Text>Open remote workspace browser</Text></Pressable>
    <Text>{navigation.openBrowser ? "Browser available" : "Browser unavailable"}</Text>
    <Pressable accessibilityRole="button" onPress={() => navigation.openBrowser({ url: ${JSON.stringify(url)}, workspaceId: ${JSON.stringify(workspaceId)} })}><Text>Open workspace browser</Text></Pressable>
  </View>;
}
export default function(client) { client.addSurface("main", Links); client.addSidebarItem({ id: "links", title: "Plugin links QA", icon: "Link", surface: "main" }); return () => {}; }
`,
  );
  const configPath = path.join(paseoHome, "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.pluginsEnabled = true;
  config.plugins = { "link-check": { source: "directory", path: directory, enabled: true } };
  fs.writeFileSync(configPath, JSON.stringify(config));
}

export async function runPluginLinksRegression({
  page,
  remotePort,
  workspaceId,
  remoteWorkspaceId,
  url,
  artifactDir,
  externalOpenLog,
}) {
  const pluginEntry = page.getByRole("button", { name: "Plugin links QA", exact: true });
  await expect(pluginEntry).toBeVisible({ timeout: 90_000 });
  await page.evaluate((port) => {
    const key = "@paseo:daemon-registry";
    const registry = JSON.parse(localStorage.getItem(key));
    const endpoint = `127.0.0.1:${port}`;
    const connection = { id: `direct:${endpoint}`, type: "directTcp", endpoint };
    const now = new Date().toISOString();
    registry.push({
      serverId: "plugin-links-remote",
      label: "Remote browser host",
      connections: [connection],
      preferredConnectionId: connection.id,
      createdAt: now,
      updatedAt: now,
    });
    localStorage.setItem(key, JSON.stringify(registry));
  }, remotePort);
  await page.reload();
  await pluginEntry.click();
  await expect(
    page.getByRole("button", { name: "Old documentation workaround", exact: true }),
  ).toBeVisible({ timeout: 60_000 });
  const oldPopup = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Old documentation workaround", exact: true }).click();
  const popup = await oldPopup;
  await popup.waitForLoadState();
  await popup.screenshot({ path: path.join(artifactDir, "plugin-old-popup.png") });
  await popup.close();

  const popups = [];
  page.on("popup", (openedPopup) => popups.push(openedPopup));
  await page.getByRole("button", { name: "Open externally", exact: true }).click();
  await expect(page.getByText("Opened externally", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Documentation link", exact: true }).click();
  if (externalOpenLog) {
    await expect
      .poll(() => fs.readFileSync(externalOpenLog, "utf8").trim().split("\n"))
      .toEqual([url, url]);
  }
  await expect(page.getByText("Browser available", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open workspace browser", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/workspace/${workspaceId}`));
  await expectPresentedBrowser(page, url, workspaceId);
  expect(popups).toHaveLength(0);
  await page.screenshot({ path: path.join(artifactDir, "plugin-workspace-browser.png") });
  await pluginEntry.click();
  await page.getByRole("button", { name: "Open remote workspace browser", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/h/plugin-links-remote/workspace/${remoteWorkspaceId}`));
  await expectPresentedBrowser(page, url, remoteWorkspaceId);
  await page.screenshot({ path: path.join(artifactDir, "plugin-remote-workspace-browser.png") });
  return {
    remoteWorkspaceId,
    oldWorkaroundOpenedPopup: true,
    newExternalPopups: popups.length,
    workspaceId,
    url,
  };
}

async function expectPresentedBrowser(page, url, workspaceId) {
  const deck = page
    .locator(`[data-testid^="workspace-deck-entry-"][data-testid$=":${workspaceId}"]`)
    .filter({ visible: true });
  const address = deck
    .getByRole("textbox", { name: "Browser URL", exact: true })
    .filter({ visible: true });
  await expect
    .poll(() =>
      address.evaluateAll(
        (inputs, expectedUrl) => inputs.some((input) => input.value === expectedUrl),
        url,
      ),
    )
    .toBe(true);

  let browserId;
  await expect
    .poll(
      async () => {
        const paneBrowserIds = await deck
          .locator('[data-testid^="browser-webview-clip-"]')
          .filter({ visible: true })
          .evaluateAll((clips) =>
            clips.map((clip) =>
              clip.getAttribute("data-testid").slice("browser-webview-clip-".length),
            ),
          );
        browserId = await page.locator("webview").evaluateAll(async (views, ids) => {
          for (const view of views) {
            const id = view.getAttribute("data-paseo-browser-id");
            const bounds = view.getBoundingClientRect();
            if (
              !ids.includes(id) ||
              view.parentElement?.getAttribute("aria-hidden") !== "false" ||
              bounds.width <= 0 ||
              bounds.height <= 0
            )
              continue;
            const ready = await view.executeJavaScript(
              "document.readyState === 'complete' && document.title === 'Desktop browser target' && Boolean(document.getElementById('bridge-target')) && Boolean(document.getElementById('typing-target'))",
            );
            if (ready) return id;
          }
          return null;
        }, paneBrowserIds);
        return typeof browserId === "string";
      },
      { timeout: 90_000 },
    )
    .toBe(true);
  const screenshot = await page.evaluate(
    ({ id, workspace }) =>
      window.paseoDesktop.browser.executeAutomationCommand({
        type: "browser.automation.execute.request",
        requestId: crypto.randomUUID(),
        workspaceId: workspace,
        command: { command: "screenshot", args: { browserId: id } },
      }),
    { id: browserId, workspace: workspaceId },
  );
  expect(screenshot.ok).toBe(true);
  expect(screenshot.result.command).toBe("screenshot");
  expect(screenshot.result.browserId).toBe(browserId);
  expect(screenshot.result.dataBase64).toMatch(/^iVBORw0KGgo/);
  expect(screenshot.result.width).toBeGreaterThan(0);
  expect(screenshot.result.height).toBeGreaterThan(0);
}
