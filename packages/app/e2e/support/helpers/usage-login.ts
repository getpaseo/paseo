import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { UsageReport } from "@getpaseo/protocol/messages";
import type { Page } from "@playwright/test";
import { connectNewWorkspaceDaemonClient } from "./new-workspace";
import { pluginRequirements } from "./plugin-fixture";

/** A real store-backed plugin on the worker's isolated daemon. */
export async function installLoginUsage(initialReport: UsageReport) {
  const directory = await mkdtemp(path.join(tmpdir(), "usage-login-journey-"));
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previous = await client.getDaemonConfig();
  const store = path.join(directory, "report.json");
  const setReport = (report: UsageReport) => writeFile(store, JSON.stringify(report));
  const cleanup = async () => {
    try {
      await client.removePlugin("login-journey");
      await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled ?? false });
    } finally {
      await client.close();
      await rm(directory, { recursive: true, force: true });
    }
  };
  try {
    await setReport(initialReport);
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id: "login-journey", requirements: pluginRequirements }),
    );
    await writeFile(
      path.join(directory, "index.server.ts"),
      `
import {readFile} from "node:fs/promises";
import {z} from "zod";
export default function contribute(server) {
  server.registerUsageSource({id: "login-journey", label: "Claude", input: z.object({}),
    discover: async () => [{key: "account", input: {}}],
    fetch: async () => JSON.parse(await readFile(${JSON.stringify(store)}, "utf8")),
  });
  return () => {};
}`,
    );
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installPluginSource({ source: directory });
    return { setReport, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export async function openUsage(page: Page) {
  await page.goto("/usage");
}

export async function refreshLoginUsage(page: Page) {
  await page.getByRole("button", { name: "Refresh Claude", exact: true }).click();
}

export async function hoverUsageWindow(page: Page, window: string) {
  await page
    .getByRole("checkbox", { name: new RegExp(`^Pin Claude ${window}, `) })
    .getByTestId("usage-pin-glyph-unpinned")
    .hover();
}
