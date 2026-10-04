import { expect, type Page } from "@playwright/test";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { connectDaemonClient } from "./daemon-client-loader";
import { openSettings } from "./app";
import { openHostSection, openSettingsHost, seedSavedSettingsHosts } from "./settings";
import type { IsolatedHostDaemon } from "./isolated-host-daemon";

export async function openDaemonOverview(page: Page, daemon: IsolatedHostDaemon) {
  await seedSavedSettingsHosts(page, [
    { serverId: daemon.serverId, label: "Lifecycle host", endpoint: `127.0.0.1:${daemon.port}` },
  ]);
  await page.reload();
  await openSettings(page);
  await openSettingsHost(page, daemon.serverId);
  await openHostSection(page, daemon.serverId, "host");
}

export async function restartDaemonInSettings(page: Page) {
  const button = page.getByRole("button", { name: "Restart", exact: true });
  await expect(button).toBeEnabled();
  page.once("dialog", (dialog) => dialog.accept());
  await button.click();
  await expect(page.getByRole("button", { name: "Restarting...", exact: true })).toBeDisabled();
}

export async function expectDaemonRestartComplete(page: Page) {
  await expect(page.getByRole("button", { name: "Restart", exact: true })).toBeEnabled({
    timeout: 30_000,
  });
}

export async function readWorkerPid(daemon: IsolatedHostDaemon): Promise<number> {
  const client = await connectDaemonClient<DaemonClient>({
    port: daemon.port,
    clientIdPrefix: "lifecycle-observer",
  });
  try {
    return (await client.getDaemonStatus()).pid;
  } finally {
    await client.close();
  }
}
