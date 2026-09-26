import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import contribute from "./test-fixtures/usage-source/index.server.js";

const directory = fileURLToPath(new URL("./test-fixtures/usage-source/", import.meta.url));
const subprocessDirectory = fileURLToPath(
  new URL("./test-fixtures/usage-source-directory/", import.meta.url),
);

test("lists internal and subprocess usage; validates input and isolates fetch errors", async () => {
  const daemon = await createTestPaseoDaemon({
    daemonVersion: "0.9.2",
    pluginsEnabled: false,
    internalPlugins: [{ id: "fixture-internal", directory, contribute }],
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.9.2" });
  try {
    await client.connect();
    const first = await client.listUsageReports();
    expect(first.reports).toHaveLength(3);
    expect(first.reports[0]?.icon).toContain("<svg");
    expect(
      first.reports.find((entry) => entry.report.account.key === "one")?.report.windows[0]?.usedPct,
    ).toBe(1);
    expect(first.reports.filter((entry) => entry.report.status === "error")).toHaveLength(2);
    expect(
      (await client.listUsageReports()).reports.find((entry) => entry.report.account.key === "one")
        ?.report.windows[0]?.usedPct,
    ).toBe(1);
    expect(
      (await client.listUsageReports({ forceRefresh: true })).reports.find(
        (entry) => entry.report.account.key === "one",
      )?.report.windows[0]?.usedPct,
    ).toBe(2);
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
