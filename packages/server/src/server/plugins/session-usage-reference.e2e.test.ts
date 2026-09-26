import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { ACPAgentSession } from "../agent/providers/acp-agent.js";
import type { UsageReference } from "../agent/agent-sdk-types.js";
import { ClaudeAgentClient } from "../agent/providers/claude/agent.js";
import { CodexAppServerAgentSession } from "../agent/providers/codex-app-server-agent.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
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
  const providers = ["claude", "codex", "copilot", "cursor", "kimi", "generic-acp"] as const;
  const logger = createTestLogger();
  const references = new Map<string, UsageReference | null>();
  const claude = await new ClaudeAgentClient({
    logger,
    resolveBinary: async () => "/test/claude/bin",
  }).createSession(
    { provider: "claude", cwd: directory },
    {
      env: {
        HOME: directory,
        CLAUDE_CONFIG_DIR: "",
        ANTHROPIC_BASE_URL: "",
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "",
      },
    },
  );
  references.set("claude", (await claude.getUsageReference?.()) ?? null);
  await claude.close();
  const codex = new CodexAppServerAgentSession(
    { provider: "codex", cwd: directory },
    null,
    logger,
    () => {
      throw new Error("Codex runtime should not start");
    },
    {},
    false,
    false,
    false,
    undefined,
    "interactive",
    { HOME: directory, OPENAI_BASE_URL: "" },
  );
  references.set("codex", await codex.getUsageReference());
  for (const provider of providers.slice(2)) {
    const session = new ACPAgentSession(
      { provider, cwd: directory },
      {
        provider,
        logger,
        defaultCommand: ["unused"],
        defaultModes: [],
        capabilities: {
          supportsStreaming: true,
          supportsSessionPersistence: true,
          supportsDynamicModes: true,
          supportsMcpServers: true,
          supportsReasoningStream: true,
          supportsToolInvocations: true,
        },
      },
    );
    references.set(provider, await session.getUsageReference());
  }
  const agentClients = Object.fromEntries(
    providers.map((provider) => {
      const client = createTestAgentClient(provider);
      const createSession = client.createSession.bind(client);
      client.createSession = async (...args) => {
        const session = await createSession(...args);
        session.getUsageReference = async () => references.get(provider) ?? null;
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
    for (const provider of providers) {
      const agent = await client.createAgent({ provider, cwd: directory });
      const result = await client.getAgentUsageReport({ agentId: agent.id });
      expect(result.entry?.sourceId, provider).toBe(provider);
    }
  } finally {
    await client.close();
    await daemon.close();
  }
}, 60_000);
