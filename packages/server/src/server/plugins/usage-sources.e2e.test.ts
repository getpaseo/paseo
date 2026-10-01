import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { BuiltinPluginLoader, resolveBuiltinPluginsRoot } from "./builtin/index.js";

const fixtureRoot = fileURLToPath(new URL("./test-fixtures/", import.meta.url));
const subprocessDirectory = fileURLToPath(
  new URL("./test-fixtures/usage-source-directory/", import.meta.url),
);

test("lists built-in and subprocess usage; validates input and isolates fetch errors", async () => {
  const daemon = await createTestPaseoDaemon({
    daemonVersion: "0.9.2",
    pluginsEnabled: false,
    builtinPlugins: new BuiltinPluginLoader(fixtureRoot, ["usage-source"]),
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.9.2" });
  try {
    await client.connect();
    const first = await client.listUsageReports();
    expect(first.reports).toHaveLength(3);
    expect(first.reports[0]?.icon).toContain("<svg");
    expect(first.reports[0]?.fetchedAt).toMatch(/^\d{4}-/);
    expect(
      first.reports.find((entry) => entry.id === "fixture:one")?.report.windows[0]?.usedPct,
    ).toBe(1);
    expect(first.reports.filter((entry) => entry.report.status === "error")).toHaveLength(2);
    expect(
      (await client.listUsageReports()).reports.find((entry) => entry.id === "fixture:one")?.report
        .windows[0]?.usedPct,
    ).toBe(1);
    expect(
      (
        await client.listUsageReports({ reportIds: ["fixture:one"], forceRefresh: true })
      ).reports.find((entry) => entry.id === "fixture:one")?.report.windows[0]?.usedPct,
    ).toBe(2);
    expect(
      (await client.listUsageReports({ reportIds: ["fixture:throws"] })).reports[0]?.report.status,
    ).toBe("error");
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(subprocessDirectory, "fixture-directory");
    const both = await client.listUsageReports({ forceRefresh: true });
    expect(both.reports).toHaveLength(6);
    await client.patchDaemonConfig({ pluginsEnabled: false });
    await expect.poll(async () => (await client.listUsageReports()).reports.length).toBe(3);
  } finally {
    await client.close();
    await daemon.close();
  }
}, 60_000);

test("a packaged daemon serves usage from external built-in resources", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-builtin-asar-"));
  const packagePath = path.join("node_modules", "@getpaseo", "server", "dist", "server");
  const resourceRoot = path.join(root, "builtin-plugins");
  // An archive is a file, so the external compiler cannot traverse paths beneath it.
  // Actual Electron archive packaging is covered by the packaged-app smoke check.
  await writeFile(path.join(root, "app.asar"), "opaque archive fixture");
  const directory = path.join(resourceRoot, "listed");
  await mkdir(path.join(directory, "server"), { recursive: true });
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({ id: "listed", requirements: { paseo: ">=0.9.2" } }),
  );
  await writeFile(
    path.join(directory, "server", "contract.d.ts"),
    "export interface Account { key: string; label: string; }",
  );
  await writeFile(
    path.join(directory, "server", "account.ts"),
    "import type { Account } from './contract.js'; export const account: Account = { key: 'one', label: 'Test account' };",
  );
  await writeFile(
    path.join(directory, "index.server.ts"),
    `import { z } from 'zod';
import { account } from './server/account.js';
export default function contribute(server) {
  server.registerUsageSource({
    id: 'fixture', label: 'Fixture', input: z.object({}),
    discover: async () => [{}],
    identify: async () => account,
    fetch: async () => ({ status: 'available', windows: [{ id: 'session', label: 'Session', usedPct: 37 }] }),
  });
  return () => {};
}`,
  );
  const moduleUrl = pathToFileURL(
    path.join(root, "app.asar", packagePath, "server", "plugins", "builtin", "index.js"),
  );
  const daemon = await createTestPaseoDaemon({
    daemonVersion: "0.9.2",
    pluginsEnabled: false,
    builtinPlugins: new BuiltinPluginLoader(resolveBuiltinPluginsRoot(moduleUrl), ["listed"]),
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.9.2" });
  try {
    await client.connect();
    const { reports } = await client.listUsageReports();
    expect(
      reports.map(({ id, sourceId, sourceLabel, account, report }) => ({
        id,
        sourceId,
        sourceLabel,
        account,
        report,
      })),
    ).toEqual([
      {
        id: "fixture:one",
        sourceId: "fixture",
        sourceLabel: "Fixture",
        account: { label: "Test account" },
        report: {
          status: "available",
          windows: [{ id: "session", label: "Session", usedPct: 37 }],
        },
      },
    ]);
  } finally {
    await client.close();
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
