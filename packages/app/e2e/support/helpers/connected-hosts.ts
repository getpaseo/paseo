import { expect, type Page } from "@playwright/test";
import { gotoAppShell, openSettings } from "./app";
import { openCompactSettings, openHostSection } from "./settings";
import { getServerId } from "./server-id";

export async function openConnectedHosts(page: Page) {
  await gotoAppShell(page);
  await openSettings(page);
  await openHostSection(page, getServerId(), "host");
  await expect(page.getByText("No hosts connected to this daemon", { exact: true })).toBeVisible();
}
export async function addConnectedHost(page: Page, connection: string, label: string) {
  await page.getByRole("button", { name: "Add host", exact: true }).click();
  await page.getByRole("textbox", { name: "Connection string", exact: true }).fill(connection);
  await page.getByRole("textbox", { name: "Host name", exact: true }).fill(label);
  await page.getByRole("textbox", { name: "Metadata", exact: true }).fill('{"team":"infra"}');
  await saveConnectedHost(page);
}
export async function saveConnectedHost(page: Page) {
  await page.getByRole("button", { name: "Save host", exact: true }).click();
}
export async function expectConnectionError(page: Page) {
  await expect(page.getByText("Invalid host connection.", { exact: false })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Connection string", exact: true })).toBeVisible();
}
export async function correctConnection(page: Page, value: string) {
  await page.getByRole("textbox", { name: "Connection string", exact: true }).fill(value);
  await saveConnectedHost(page);
}
export async function inspectConnectedHost(page: Page, label: string) {
  await page.getByRole("button", { name: `Details for ${label}`, exact: true }).click();
  await expect(page.getByText("Connected host details", { exact: true })).toBeVisible();
}
export async function expectSavedHostDetails(page: Page) {
  await expect(page.getByText('{"team":"infra"}', { exact: true })).toBeVisible();
  await expect(page.getByText("Never", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Replacement connection", exact: true }),
  ).toHaveValue("");
}
export async function disableConnectedHost(page: Page) {
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Disable", exact: true }).click();
  await expect(page.getByText(/disabled · Disabled/)).toBeVisible();
}
export async function enableConnectedHost(page: Page) {
  await page.getByRole("button", { name: "Enable", exact: true }).click();
  await expect(page.getByRole("button", { name: "Disable", exact: true })).toBeVisible();
}
export async function removeConnectedHost(page: Page, label: string) {
  await inspectConnectedHost(page, label);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Remove host", exact: true }).click();
  await expect(page.getByText("No hosts connected to this daemon", { exact: true })).toBeVisible();
}

export async function openCompactConnectedHosts(page: Page) {
  await gotoAppShell(page);
  await openCompactSettings(page, new URL(page.url()).pathname);
  await openHostSection(page, getServerId(), "host");
  await expect(page.getByText("No hosts connected to this daemon", { exact: true })).toBeVisible();
}

import { startIsolatedHostDaemon, type IsolatedHostDaemon } from "./isolated-host-daemon";
import { addDirectHostFromSettings, selectSettingsHost } from "./settings";

export async function openRestartableConnectedHosts(page: Page): Promise<IsolatedHostDaemon> {
  const host = await startIsolatedHostDaemon("srv_connected_host_draft");
  await gotoAppShell(page);
  await openSettings(page);
  await addDirectHostFromSettings(page, { host: "127.0.0.1", port: host.port });
  await selectSettingsHost(page, host.serverId);
  await openHostSection(page, host.serverId, "host");
  await expect(page.getByText("No hosts connected to this daemon", { exact: true })).toBeVisible();
  return host;
}
export async function beginConnectedHostDraft(page: Page) {
  await page.getByRole("button", { name: "Add host", exact: true }).click();
  await page.getByRole("textbox", { name: "Host name", exact: true }).fill("Retained draft");
  await page
    .getByRole("textbox", { name: "Connection string", exact: true })
    .fill("tcp://127.0.0.1:1?password=draft-secret");
}
export async function reconnectManagingHost(host: IsolatedHostDaemon) {
  await host.restart();
}
export async function expectConnectedHostDraftRetained(page: Page) {
  await expect(page.getByRole("textbox", { name: "Host name", exact: true })).toHaveValue(
    "Retained draft",
    { timeout: 30000 },
  );
  await expect(page.getByRole("textbox", { name: "Connection string", exact: true })).toHaveValue(
    "tcp://127.0.0.1:1?password=draft-secret",
  );
}

export async function editConnectedHost(page: Page) {
  await page.getByRole("switch", { name: "Replace destination identity", exact: true }).click();
  await saveConnectedHost(page);
  await expect(
    page.getByText("Identity replacement requires a replacement connection", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Replacement connection", exact: true })
    .fill("tcp://127.0.0.1:1?password=replacement-secret");
  await page.getByRole("textbox", { name: "Host name", exact: true }).fill("Renamed box");
  await page.getByRole("textbox", { name: "Metadata", exact: true }).fill('{"team":"tools"}');
  await saveConnectedHost(page);
  await inspectConnectedHost(page, "Renamed box");
  await expect(page.getByText('{"team":"tools"}', { exact: true })).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Replacement connection", exact: true }),
  ).toHaveValue("");
}
