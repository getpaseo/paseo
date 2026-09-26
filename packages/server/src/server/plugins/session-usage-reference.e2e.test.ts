import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
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
    const missing = await client.createAgent({
      provider: "fixture-session-provider",
      cwd: directory,
      model: "missing",
    });
    expect((await client.getAgentUsageReport({ agentId: missing.id })).entry).toBeNull();
  } finally {
    await client.close();
    await daemon.close();
  }
}, 60_000);

test("agent.get_usage_report resolves source IDs from default built-in and ACP sessions", async () => {
  const directory = fileURLToPath(
    new URL("./test-fixtures/session-usage-reference/", import.meta.url),
  );
  const sources = [
    ["claude", "claude"],
    ["codex", "codex"],
    ["copilot", "copilot"],
    ["cursor", "cursor"],
    ["kimi", "kimi"],
    ["generic-acp", "generic-match"],
  ] as const;
  const agentClients = Object.fromEntries(
    sources.map(([provider, source]) => {
      const client = createTestAgentClient(provider);
      const createSession = client.createSession.bind(client);
      client.createSession = async (...args) => {
        const session = await createSession(...args);
        session.getUsageReference = async () => ({ source, input: {} });
        return session;
      };
      return [provider, client];
    }),
  );
  const daemon = await createTestPaseoDaemon({
    pluginsEnabled: false,
    internalPlugins: [{ id: "fixture-session-usage-reference", directory, contribute }],
    agentClients,
    providerOverrides: {
      cursor: { extends: "acp", label: "Cursor", command: ["cursor-agent", "acp"] },
      kimi: { extends: "acp", label: "Kimi", command: ["kimi", "acp"] },
      "generic-acp": { extends: "acp", label: "Generic ACP", command: ["generic-acp", "acp"] },
    },
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await client.connect();
    for (const [provider, source] of sources) {
      const agent = await client.createAgent({ provider, cwd: directory });
      const result = await client.getAgentUsageReport({ agentId: agent.id });
      expect(result.entry?.sourceId, provider).toBe(source);
    }
  } finally {
    await client.close();
    await daemon.close();
  }
}, 60_000);
