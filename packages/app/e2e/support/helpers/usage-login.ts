import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { UsageReport } from "@getpaseo/protocol/messages";
import { expect, type Page } from "@playwright/test";
import { expectPinnedUsage, pinRow, usageItem } from "./usage-sidebar-item";
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
    .getByTestId(/usage-pin-glyph-/)
    .hover();
}

/** Exercises the built-in Codex adapter through the real plugin loader and daemon transport. */
export async function installCodexWindowUsage(payload: unknown) {
  const directory = await mkdtemp(path.join(tmpdir(), "usage-codex-windows-"));
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previous = await client.getDaemonConfig();
  const cleanup = async () => {
    try {
      await client.removePlugin("codex-window-qa");
      await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled ?? false });
    } finally {
      await client.close();
      await rm(directory, { recursive: true, force: true });
    }
  };
  try {
    const source = path.resolve(__dirname, "../../../../../plugins/codex-usage-source");
    await cp(path.join(source, "server"), path.join(directory, "server"), { recursive: true });
    await cp(path.join(source, "shared"), path.join(directory, "shared"), { recursive: true });
    await writeFile(
      path.join(directory, "auth.json"),
      JSON.stringify({ tokens: { access_token: "fixture-codex" } }),
    );
    await writeFile(path.join(directory, "payload.json"), JSON.stringify(payload));
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id: "codex-window-qa", requirements: pluginRequirements }),
    );
    await writeFile(
      path.join(directory, "index.server.ts"),
      `
import {readFile} from "node:fs/promises";
import {fetchUsage, discover} from "./server/usage.js";
import {inputSchema} from "./shared/input.js";
export default function contribute(server) {
  server.registerUsageSource({id: "codex-window-qa", label: "Codex", input: inputSchema,
    discover: () => discover({home: ${JSON.stringify(directory)}, env: {CODEX_HOME: ${JSON.stringify(directory)}}}),
    fetch: (input) => fetchUsage(input, async () => Response.json(JSON.parse(await readFile(${JSON.stringify(path.join(directory, "payload.json"))}, "utf8")))),
  });
  return () => {};
}`,
    );
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installPluginSource({ source: directory });
    return { cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export async function expectCodexReportedWindows(page: Page, shape: "seven-day-only" | "Spark") {
  await expectPinnedUsage(page, ["11% wk"]);
  await expect(pinRow(page.locator("body"), "Codex", "Weekly")).toBeChecked();
  await expect(page.getByText("Session", { exact: true })).toHaveCount(0);
  if (shape === "Spark") {
    const fiveHour = pinRow(page.locator("body"), "Codex", "GPT-5.3-Codex-Spark · 5-hour");
    const weekly = pinRow(page.locator("body"), "Codex", "GPT-5.3-Codex-Spark · Weekly");
    await expect(fiveHour).not.toBeChecked();
    await expect(weekly).not.toBeChecked();
    await fiveHour.click();
    await expect(fiveHour).toBeChecked();
    await expect(usageItem(page)).toHaveAccessibleName(
      /Codex Weekly 11% used, Codex GPT-5.3-Codex-Spark · 5-hour 0% used/,
    );
  }
}
