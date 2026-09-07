import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { spawnTsx, killProcessTree } from "./spawn-node";
import { expect, test as base, type Page } from "../fixtures";
import { connectDaemonClient } from "./daemon-client-loader";
import { addConnectedHostAndReload } from "./hosts";
import { gotoAppShell, openSettings } from "./app";
import { openHostSection, selectSettingsHost } from "./settings";
import { pluginRequirements } from "./plugin-fixture";

export const test = base.extend<{
  requirementHost: { serverId: string; port: number; directory: string; client: DaemonClient };
}>({
  requirementHost: async ({ e2eWorker }, provide) => {
    void e2eWorker;
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-requirement-ui-"));
    await writeRequirements(directory, "^99.0.0");
    await writeFile(
      path.join(directory, "index.client.ts"),
      `export default function(client) {
      return () => {};
    }`,
    );
    const daemon = spawnTsx(
      path.resolve(__dirname, "../../../../server/src/server/test-utils/versioned-daemon.ts"),
      ["99.0.0"],
      { stdio: ["ignore", "pipe", "pipe", "ipc"] },
    );
    const ready = Promise.withResolvers<{ port: number; serverId: string }>();
    const timeout = setTimeout(
      () => ready.reject(new Error("Versioned daemon startup timed out")),
      30_000,
    );
    let output = "";
    daemon.stdout?.on("data", (data) => {
      output += data;
    });
    daemon.stderr?.on("data", (data) => {
      output += data;
    });
    daemon.once("error", ready.reject);
    daemon.once("exit", () => ready.reject(new Error(`Versioned daemon exited: ${output}`)));
    daemon.once("message", (message) => {
      if (
        typeof message !== "object" ||
        message === null ||
        !("port" in message) ||
        typeof message.port !== "number" ||
        !("serverId" in message) ||
        typeof message.serverId !== "string"
      ) {
        ready.reject(new Error("Invalid versioned daemon startup message"));
        return;
      }
      ready.resolve({ port: message.port, serverId: message.serverId });
    });
    try {
      const host = await ready.promise;
      clearTimeout(timeout);
      const client = await connectDaemonClient<DaemonClient>({
        port: host.port,
        clientIdPrefix: "requirements",
      });
      try {
        await client.installDirectoryPlugin(directory);
        await provide({ ...host, directory, client });
      } finally {
        await client.close();
      }
    } finally {
      clearTimeout(timeout);
      await killProcessTree(daemon);
      await rm(directory, { recursive: true, force: true });
    }
  },
});

async function writeRequirements(directory: string, paseo: string) {
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({ id: "requirements-example", requirements: { paseo } }),
  );
}

export async function openRequirementHost(page: Page, host: { serverId: string; port: number }) {
  await gotoAppShell(page);
  await addConnectedHostAndReload(page, { ...host, label: "Plugin requirements" });
  await openSettings(page);
  await selectSettingsHost(page, host.serverId);
  await openHostSection(page, host.serverId, "plugins");
}

export async function expectAppMismatch(page: Page) {
  await expect(page.getByLabel("requirements-example failed", { exact: true })).toBeVisible();
  await expect(
    page.getByText(/Plugin "requirements-example" requires Paseo \^99.0.0. Your app is/),
  ).toBeVisible();
}

export async function correctRequirementAndReload(page: Page, directory: string) {
  await writeRequirements(directory, pluginRequirements.paseo);
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(page.getByLabel("requirements-example running", { exact: true })).toBeVisible();
  await expect(page.getByText(/Your app is/)).toHaveCount(0);
}

export async function rejectDaemonMismatch(page: Page, directory: string) {
  await writeRequirements(directory, ">=100.0.0");
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(page.getByLabel("requirements-example failed", { exact: true })).toBeVisible();
  await expect(page.getByText(/Your daemon is 99.0.0/).first()).toBeVisible();
}
