import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import contribute from "./test-fixtures/session-usage-reference/index.server.js";

test("resolves a provider plugin session reference through its usage source", async () => {
  const directory = fileURLToPath(
    new URL("./test-fixtures/session-usage-reference/", import.meta.url),
  );
  const daemon = await createTestPaseoDaemon({
    pluginsEnabled: false,
    internalPlugins: [{ id: "fixture-session-usage-reference", directory, contribute }],
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await client.connect();
    const agent = await client.createAgent({
      provider: "fixture-session-provider",
      cwd: directory,
    });
    const result = await client.getAgentUsageReport({ agentId: agent.id });
    expect(result.entry).toMatchObject({
      sourceId: "fixture-session-usage",
      report: { account: { key: "from-session" }, windows: [{ usedPct: 31 }] },
    });
    const reports = await client.listUsageReports();
    expect(reports.reports.map((entry) => entry.report.account.key)).toContain("from-session");
  } finally {
    await client.close();
    await daemon.close();
  }
}, 60_000);
