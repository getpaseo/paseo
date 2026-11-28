import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, expect, test, vi } from "vitest";
import { UsageReportChangedStatusPayloadSchema } from "@getpaseo/protocol/messages";
import type {
  AgentClient,
  AgentSession,
  AgentStreamEvent,
  AgentStreamEventHandler,
} from "../agent/agent-sdk-types.js";
import type { ProviderOverride } from "../agent/provider-launch-config.js";
import {
  CLAUDE_USAGE_SOURCE_ID,
  readClaudeRateLimitUsage,
} from "../agent/providers/claude/rate-limit-usage.js";
import {
  CODEX_USAGE_SOURCE_ID,
  readCodexRateLimitUsage,
} from "../agent/providers/codex/rate-limit-usage.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { BuiltinPluginLoader, resolveBuiltinPluginsRoot } from "./builtin/index.js";
import { OpenCodeV2AgentClient } from "../agent/providers/opencode/v2/agent.js";
import { V2Harness } from "../agent/providers/opencode/test-utils/v2-harness.js";
import { createTestLogger } from "../../test-utils/test-logger.js";

const fixtureRoot = fileURLToPath(new URL("./test-fixtures/", import.meta.url));
const subprocessDirectory = fileURLToPath(
  new URL("./test-fixtures/usage-source-directory/", import.meta.url),
);

async function json(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value));
}

interface InjectedUsageSourcesOptions {
  root: string;
  lookup: { home: string; env: Record<string, string> };
  /** Source of an `async function fetchApi(url, init)` the readers call instead of the network. */
  fetchApi: string;
  /** Optional NDJSON file path where each source logs every scope passed to discover(). */
  scopeLogPath?: string;
}

const SOURCE_PROVIDERS = {
  claude: ["claude", "pi", "omp"],
  codex: ["codex", "opencode", "pi", "omp"],
} as const;

async function injectedUsageSources({
  root,
  lookup,
  fetchApi,
  scopeLogPath,
}: InjectedUsageSourcesOptions): Promise<BuiltinPluginLoader> {
  const plugins = path.join(root, "plugins");
  for (const source of ["codex", "claude"] as const) {
    const directory = path.join(plugins, `${source}-usage-source`);
    await cp(path.join(resolveBuiltinPluginsRoot(), `${source}-usage-source`), directory, {
      recursive: true,
    });
    const recordScope = scopeLogPath
      ? `await appendFile(${JSON.stringify(scopeLogPath)}, JSON.stringify({ source: ${JSON.stringify(source)}, scope }) + '\\n');`
      : "";
    await writeFile(
      path.join(directory, "index.server.ts"),
      `
import { appendFile } from 'node:fs/promises';
import { inputSchema } from './shared/input.js';
import { discover, fetchUsage } from './server/usage.js';
const lookup = { home: ${JSON.stringify(lookup.home)}, env: ${JSON.stringify(lookup.env)}, platform: 'linux' };
${fetchApi}
export default function contribute(server) {
  server.registerUsageSource({
    id: '${source}',
    label: '${source}',
    providers: ${JSON.stringify(SOURCE_PROVIDERS[source])},
    input: inputSchema,
    discover: async (scope) => {
      ${recordScope}
      return discover(scope, lookup${source === "claude" ? ", fetchApi" : ""});
    },
    fetch: (input) => fetchUsage(inputSchema.parse(input), fetchApi, lookup),
  });
  return () => {};
}
`,
    );
  }
  return new BuiltinPluginLoader(plugins, ["codex-usage-source", "claude-usage-source"]);
}

const API_HOST_ENV = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CODEX_API_KEY",
  "CODEX_ACCESS_TOKEN",
  "OPENAI_BASE_URL",
];

afterEach(() => {
  vi.unstubAllEnvs();
});

test("lists built-in and subprocess usage; validates input and isolates fetch errors", async () => {
  const daemon = await createTestPaseoDaemon({
    daemonVersion: "0.9.2",
    pluginsEnabled: false,
    builtinPlugins: new BuiltinPluginLoader(fixtureRoot, ["usage-source"]),
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.9.2" });
  try {
    await client.connect();
    const updates: string[] = [];
    const first = await client.listUsageReports({}, (report) => updates.push(report.id));
    expect(updates).toEqual(first.reports.map((report) => report.id));
    await expect(client.listUsageReports({ agentId: "missing-agent" })).rejects.toThrow(
      "Unknown agent",
    );
    expect(first.reports).toHaveLength(4);
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
    const expired = first.reports.find((entry) => entry.id === "fixture:expired");
    expect(expired?.report).toEqual({
      status: "unavailable",
      problem: { kind: "expired", expiresAt: expect.any(String), refreshedBy: "claude" },
    });
    const legacy = await client.listProviderUsage();
    expect(legacy.providers.find((provider) => provider.displayName === "Fixture")?.status).toBe(
      "available",
    );
    expect(legacy.providers.find((provider) => provider.status === "unavailable")?.error).toBe(
      "Login expired 1h ago. Run claude to refresh it.",
    );
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(subprocessDirectory, "fixture-directory");
    const both = await client.listUsageReports({ forceRefresh: true });
    expect(both.reports).toHaveLength(8);
    for (const id of ["fixture:one", "fixture-directory:one"]) {
      expect(both.reports.find((entry) => entry.id === id)?.report.windows[0]).toMatchObject({
        id: "weekly",
        label: "Weekly",
        shortLabel: "wk",
      });
    }
    await client.patchDaemonConfig({ pluginsEnabled: false });
    await expect.poll(async () => (await client.listUsageReports()).reports.length).toBe(4);
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
    discover: async () => [{...account, input: {}}],
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

test("built-in sources deduplicate cross-harness accounts and fall back without session wiring", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "usage-cross-harness-"));
  const home = path.join(root, "home");
  const plugins = path.join(root, "plugins");
  const codexHome = path.join(home, ".codex");
  const env = { CODEX_HOME: codexHome };
  async function codexToken(token: string) {
    await json(path.join(codexHome, "auth.json"), {
      tokens: { access_token: token, account_id: "chatgpt-one" },
    });
  }
  await codexToken("fixture-codex");
  const openCodePath = path.join(home, ".local", "share", "opencode", "auth.json");
  await json(openCodePath, {
    openai: { type: "oauth", access: "fixture-opencode", accountId: "chatgpt-one" },
  });
  const piPath = path.join(home, ".pi", "agent", "auth.json");
  await json(piPath, {
    "openai-codex": { type: "oauth", access: "fixture-pi-codex", accountId: "chatgpt-one" },
    anthropic: { type: "oauth", access: "fixture-pi-claude" },
  });
  await json(path.join(home, ".claude", ".credentials.json"), {
    claudeAiOauth: { accessToken: "fixture-claude" },
  });
  const dbPath = path.join(home, ".omp", "agent", "agent.db");
  await mkdir(path.dirname(dbPath), { recursive: true });
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(
    "CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY, provider TEXT, credential_type TEXT, data TEXT, disabled_cause TEXT)",
  );
  const insert = db.prepare("INSERT INTO auth_credentials VALUES (?, ?, 'oauth', ?, NULL)");
  insert.run(
    1,
    "openai-codex",
    JSON.stringify({
      access: "fixture-omp-codex",
      accountId: "chatgpt-one",
      expires: Date.now() + 60_000,
    }),
  );
  insert.run(
    2,
    "anthropic",
    JSON.stringify({ access: "fixture-omp-claude", expires: Date.now() + 60_000 }),
  );
  db.close();
  for (const source of ["codex", "claude"]) {
    const directory = path.join(plugins, `${source}-usage-source`);
    await cp(path.join(resolveBuiltinPluginsRoot(), `${source}-usage-source`), directory, {
      recursive: true,
    });
    // Inject home/env/HTTP at the source boundary; compile and register the real readers.
    await writeFile(
      path.join(directory, "index.server.ts"),
      `
import { inputSchema } from './shared/input.js';
import { discover, fetchUsage } from './server/usage.js';
const lookup = { home: ${JSON.stringify(home)}, env: ${JSON.stringify(env)}, platform: 'linux' };
async function fetchApi(url, init) {
  const token = new Headers(init.headers).get('Authorization');
  if (String(url).endsWith('/profile')) {
    const second = token === 'Bearer fixture-pi-claude';
    return new Response(JSON.stringify({ account: { uuid: second ? 'claude-two' : 'claude-one' }, organization: { uuid: second ? 'org-two' : 'org-one' } }));
  }
  if (token === 'Bearer fixture-revoked') return new Response(null, { status: 401 });
  const used = { 'Bearer fixture-codex': 11, 'Bearer fixture-opencode': 22, 'Bearer fixture-opencode-db': 23, 'Bearer fixture-pi-codex': 33, 'Bearer fixture-omp-codex': 44, 'Bearer fixture-omp-claude': 66, 'Bearer fixture-pi-claude': 77 }[token] || 55;
  return new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: used } }, five_hour: { utilization: used } }));
}
export default function contribute(server) {
  server.registerUsageSource({ id: '${source}', label: '${source}', input: inputSchema,
    discover: (scope) => discover(scope, lookup${source === "claude" ? ", fetchApi" : ""}),
    fetch: (input) => fetchUsage(inputSchema.parse(input), fetchApi, lookup),
  });
  return () => {};
}
`,
    );
  }
  const daemon = await createTestPaseoDaemon({
    pluginsEnabled: false,
    builtinPlugins: new BuiltinPluginLoader(plugins, ["codex-usage-source", "claude-usage-source"]),
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await client.connect();
    const first = (await client.listUsageReports()).reports;
    expect(first.map((entry) => entry.id).sort()).toEqual([
      "claude:claude-one.org-one",
      "claude:claude-two.org-two",
      "codex:chatgpt-one",
    ]);
    expect(first.find((entry) => entry.sourceId === "codex")?.report.windows[0]?.usedPct).toBe(11);
    expect(
      first.find((entry) => entry.id === "claude:claude-two.org-two")?.report.windows[0]?.usedPct,
    ).toBe(77);
    expect(JSON.stringify(first)).not.toContain("fixture-");
    await json(path.join(home, ".claude", ".credentials.json"), {
      claudeAiOauth: { accessToken: "fixture-revoked" },
    });
    const claudeFallback = (
      await client.listUsageReports({
        reportIds: ["claude:claude-one.org-one"],
        forceRefresh: true,
      })
    ).reports;
    expect(claudeFallback[0]?.report.windows[0]?.usedPct).toBe(66);
    await codexToken("fixture-revoked");
    const refresh = async () =>
      (await client.listUsageReports({ reportIds: ["codex:chatgpt-one"], forceRefresh: true }))
        .reports[0];
    expect((await refresh())?.report.windows[0]?.usedPct).toBe(22);
    const openCodeDatabase = path.join(path.dirname(openCodePath), "opencode.db");
    const openCodeDb = new DatabaseSync(openCodeDatabase);
    openCodeDb.exec(
      "CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT, value TEXT, active INTEGER, time_created INTEGER, time_updated INTEGER)",
    );
    // OpenCode's v1 migration leaves active NULL and does not update auth.json.
    openCodeDb.prepare("INSERT INTO credential VALUES (?, ?, ?, ?, NULL, 1, 1)").run(
      "migrated-login",
      "openai",
      "OpenAI",
      JSON.stringify({
        type: "oauth",
        access: "fixture-opencode-db",
        expires: Date.now() + 60_000,
        metadata: { accountID: "chatgpt-one" },
      }),
    );
    openCodeDb.close();
    const rediscover = async () =>
      (await client.listUsageReports({ forceRefresh: true })).reports.find(
        (entry) => entry.id === "codex:chatgpt-one",
      );
    expect((await rediscover())!.report.windows[0]!.usedPct).toBe(23);
    await rm(openCodeDatabase);
    expect((await rediscover())!.report.windows[0]!.usedPct).toBe(22);
    await rm(openCodePath);
    expect((await refresh())?.report.windows[0]?.usedPct).toBe(33);
    await json(piPath, {
      "openai-codex": {
        type: "oauth",
        access: "fixture-pi-codex",
        accountId: "chatgpt-one",
        expires: 1,
      },
      anthropic: { type: "oauth", access: "fixture-pi-claude" },
    });
    expect((await refresh())?.report.windows[0]?.usedPct).toBe(44);
    await codexToken("fixture-codex");
    expect((await refresh())?.report.windows[0]?.usedPct).toBe(11);
  } finally {
    await client.close();
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("a killed discovery subprocess logs kimi once and produces no provider card", async () => {
  const { default: pino } = await import("pino");
  const root = await mkdtemp(path.join(os.tmpdir(), "usage-crash-"));
  const log = path.join(root, "daemon.log");
  const destination = pino.destination({ dest: log, sync: true });
  const daemon = await createTestPaseoDaemon({
    daemonVersion: "0.9.2",
    pluginsEnabled: true,
    logger: pino({ level: "warn" }, destination),
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.9.2" });
  try {
    await writeFile(
      path.join(root, "paseo-plugin.json"),
      JSON.stringify({ id: "crashing-usage", requirements: { paseo: ">=0.9.2" } }),
    );
    await writeFile(
      path.join(root, "index.server.ts"),
      `
import {z} from "zod";
export default function contribute(server) {
  server.registerUsageSource({id: "kimi", label: "Kimi", input: z.object({}),
    discover: async () => {process.exit(1);},
    fetch: async () => {throw new Error("discovery must never produce an account");},
  });
  return () => {};
}`,
    );
    await client.connect();
    await client.installDirectoryPlugin(root, "crashing-usage");
    expect((await client.listUsageReports({ forceRefresh: true })).reports).toEqual([]);
    const warnings = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.msg === "Usage source discovery failed");
    expect(warnings.map(({ level, sourceId }) => ({ level, sourceId }))).toEqual([
      { level: 40, sourceId: "kimi" },
    ]);
    expect((await client.listUsageReports({ forceRefresh: true })).reports).toEqual([]);
  } finally {
    await client.close();
    await daemon.close();
    destination.end();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test.each(["builtin", "directory"])(
  "%s usage plugins reach the environment proxy",
  async (mode) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "usage-proxy-"));
    const tunnels: string[] = [];
    const proxy = createServer();
    proxy.on("connect", (request, socket) => {
      tunnels.push(request.url!);
      socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("Missing proxy address");
    const guard = path.join(root, "network-guard.cjs");
    // Prevent vendor DNS/network access even when proxy support is broken.
    await writeFile(
      guard,
      `const dns = require('node:dns');
const lookup = dns.lookup;
dns.lookup = function(host, ...args) {
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return lookup.call(this, host, ...args);
  args.at(-1)(Object.assign(new Error('External DNS forbidden in proxy test'), { code: 'ENOTFOUND' }));
};`,
    );
    await mkdir(path.join(root, ".claude"));
    await mkdir(path.join(root, ".codex"));
    await writeFile(
      path.join(root, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "fixture-claude" } }),
    );
    await writeFile(
      path.join(root, ".codex", "auth.json"),
      JSON.stringify({ tokens: { access_token: "fixture-codex", account_id: "fixture-account" } }),
    );
    try {
      await promisify(execFile)(
        process.execPath,
        [
          "--import",
          "tsx",
          fileURLToPath(new URL("./test-fixtures/usage-proxy-daemon.ts", import.meta.url)),
          mode,
        ],
        {
          timeout: 45_000,
          maxBuffer: 1024 * 1024,
          env: {
            ...process.env,
            HOME: root,
            USERPROFILE: root,
            CODEX_HOME: path.join(root, ".codex"),
            OPENROUTER_API_KEY: "fixture-openrouter",
            OPENROUTER_MANAGEMENT_KEY: "fixture-openrouter-management",
            CLAUDE_CONFIG_DIR: path.join(root, ".claude"),
            // Clear ambient auth overrides (e.g. CI secrets) so local fixture credentials on disk are discovered.
            CLAUDE_CODE_OAUTH_TOKEN: "",
            ANTHROPIC_API_KEY: "",
            ANTHROPIC_AUTH_TOKEN: "",
            ANTHROPIC_BASE_URL: "",
            CLAUDE_CODE_USE_BEDROCK: "",
            CLAUDE_CODE_USE_VERTEX: "",
            CLAUDE_CODE_USE_FOUNDRY: "",
            CODEX_API_KEY: "",
            CODEX_ACCESS_TOKEN: "",
            OPENAI_BASE_URL: "",
            NODE_OPTIONS: `--require=${JSON.stringify(guard.replaceAll("\\", "/"))}`,
            https_proxy: `http://127.0.0.1:${address.port}`,
            no_proxy: "",
            NO_PROXY: "",
          },
        },
      );
      expect(tunnels).toContain("api.anthropic.com:443");
      expect(tunnels).toContain("chatgpt.com:443");
      expect(tunnels.filter((target) => target === "openrouter.ai:443")).toHaveLength(2);
    } finally {
      proxy.closeAllConnections();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);

test("resolves a plugin provider launch for cold usage discovery", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-usage-launch-"));
  const directory = path.join(root, "launch-source");
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({ id: "launch-source", requirements: { paseo: ">=0.9.2" } }),
  );
  await writeFile(
    path.join(directory, "index.server.ts"),
    `
import { z } from 'zod';
export default function contribute(server) {
  server.registerProvider({ id: 'usage-launch-fixture', label: 'Launch fixture', command: [${JSON.stringify(process.execPath)}, 'fixture-arg'], connect: async () => { throw new Error('Must not connect'); } });
  server.registerUsageSource({ id: 'launch-fixture', label: 'Launch fixture', provider: 'usage-launch-fixture', input: z.object({}),
    discover: async scope => scope.kind === 'global' && scope.launch?.args[0] === 'fixture-arg' ? [{ key: 'default', input: {} }] : [],
    fetch: async () => ({ status: 'available', windows: [{ id: 'weekly', label: 'Weekly', usedPct: 12 }] }) });
  return () => {};
}`,
  );
  const daemon = await createTestPaseoDaemon({
    daemonVersion: "0.16.2",
    pluginsEnabled: false,
    builtinPlugins: new BuiltinPluginLoader(root, ["launch-source"]),
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.16.2",
  });
  try {
    await client.connect();
    const result = await client.listUsageReports();
    expect(result.reports).toContainEqual(
      expect.objectContaining({
        id: "launch-fixture:default",
        report: expect.objectContaining({
          status: "available",
          windows: [{ id: "weekly", label: "Weekly", usedPct: 12 }],
        }),
      }),
    );
    await client.patchDaemonConfig({
      providers: {
        "usage-launch-fixture": { command: [path.join(root, "missing-cli")] },
      },
    });
    expect((await client.listUsageReports()).reports).toEqual([]);
  } finally {
    await client.close();
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("OpenCode v2 agent resolves Codex opencode.db, OpenCode Go, and MiniMax usage across model switches", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "usage-opencode-v2-agent-"));
  const home = path.join(root, "home");
  const dataHome = path.join(home, ".local", "share");
  const openCodeDir = path.join(dataHome, "opencode");
  const plugins = path.join(root, "plugins");
  const projectDir = path.join(root, "project");
  await mkdir(openCodeDir, { recursive: true });
  await mkdir(path.join(home, ".mmx"), { recursive: true });
  await mkdir(projectDir, { recursive: true });

  // Stale v1 auth.json (expired OpenAI OAuth + valid OpenCode Go key)
  await writeFile(
    path.join(openCodeDir, "auth.json"),
    JSON.stringify({
      openai: { type: "oauth", access: "fixture-stale-v1", expires: 1 },
      "opencode-go": { type: "api", key: "fixture-go-key" },
    }),
  );
  // Real SQLite opencode.db with a fresh OpenAI OAuth login
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(openCodeDir, "opencode.db"));
  db.exec(
    "CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT, value TEXT, connector_id TEXT, method_id TEXT, active INTEGER, time_created INTEGER, time_updated INTEGER)",
  );
  db.prepare("INSERT INTO credential VALUES (?, ?, ?, ?, NULL, 'chatgpt-headless', 1, 1, 1)").run(
    "cred_openai_v2",
    "openai",
    "OpenAI",
    JSON.stringify({
      type: "oauth",
      access: "fixture-v2-openai",
      expires: Date.now() + 3_600_000,
      metadata: { accountID: "v2-chatgpt-account" },
    }),
  );
  db.close();
  // MiniMax CLI config in the session HOME
  await writeFile(
    path.join(home, ".mmx", "config.json"),
    JSON.stringify({ api_key: "fixture-minimax-key" }),
  );

  // Copy built-in codex, opencode-go, and minimax usage sources with deterministic HTTP injection
  for (const source of ["codex", "opencode-go", "minimax"] as const) {
    const directory = path.join(plugins, `${source}-usage-source`);
    await cp(path.join(resolveBuiltinPluginsRoot(), `${source}-usage-source`), directory, {
      recursive: true,
    });
    if (source === "codex") {
      await writeFile(
        path.join(directory, "index.server.ts"),
        `
import { inputSchema } from './shared/input.js';
import { discover, fetchUsage } from './server/usage.js';
const lookup = { home: ${JSON.stringify(home)}, env: { HOME: ${JSON.stringify(home)}, XDG_DATA_HOME: ${JSON.stringify(dataHome)} }, platform: 'linux' };
async function fetchApi(_url, init) {
  const token = new Headers(init?.headers).get('Authorization');
  if (token !== 'Bearer fixture-v2-openai') return new Response(null, { status: 401 });
  return Response.json({ plan_type: 'plus', rate_limit: { primary_window: { used_percent: 34, limit_window_seconds: 18000 } } });
}
export default function contribute(server) {
  server.registerUsageSource({ id: 'codex', label: 'Codex', providers: ['codex', 'opencode'], input: inputSchema,
    discover: (scope) => discover(scope, lookup),
    fetch: (input) => fetchUsage(inputSchema.parse(input), fetchApi, lookup),
  });
  return () => {};
}
`,
      );
    } else if (source === "opencode-go") {
      await writeFile(
        path.join(directory, "index.server.ts"),
        `
import { inputSchema } from './shared/input.js';
import { discover, discoverSession, fetchUsage } from './server/usage.js';
const install = { command: ${JSON.stringify(path.join(root, "absent-opencode"))}, args: [], env: { HOME: ${JSON.stringify(home)}, XDG_DATA_HOME: ${JSON.stringify(dataHome)} }, authFile: ${JSON.stringify(path.join(openCodeDir, "auth.json"))} };
async function fetchApi(url, init) {
  const token = new Headers(init?.headers).get('Authorization');
  if (String(url).includes('/console/api/go/status')) return new Response(null, { status: 500 });
  if (token !== 'Bearer fixture-go-key') return new Response(null, { status: 401 });
  return Response.json({ usage: {
    rolling: { status: 'ok', percent: 15, resetsAt: '2026-12-01T00:00:00.000Z' },
    weekly: { status: 'ok', percent: 45, resetsAt: '2026-12-07T00:00:00.000Z' },
    monthly: { status: 'ok', percent: 60, resetsAt: '2026-12-31T00:00:00.000Z' },
  } });
}
export default function contribute(server) {
  server.registerUsageSource({ id: 'opencode-go', label: 'OpenCode Go', providers: ['opencode'], input: inputSchema,
    discover: (scope) => scope.kind === 'global' ? discover(install) : discoverSession(scope, install),
    fetch: (input) => fetchUsage(inputSchema.parse(input), fetchApi, install),
  });
  return () => {};
}
`,
      );
    } else {
      await writeFile(
        path.join(directory, "index.server.ts"),
        `
import { inputSchema } from './shared/input.js';
import { discover, discoverSession, fetchUsage } from './server/usage.js';
async function fetchApi(_url, init) {
  const token = new Headers(init?.headers).get('Authorization');
  if (token !== 'Bearer fixture-minimax-key') return new Response(null, { status: 401 });
  return Response.json({ model_remains: [{ model_name: 'MiniMax-M2.7', current_interval_remaining_percent: 70, current_weekly_remaining_percent: 82 }] });
}
export default function contribute(server) {
  server.registerUsageSource({ id: 'minimax', label: 'MiniMax', input: inputSchema,
    discover: (scope) => scope.kind === 'global' ? discover() : discoverSession(scope),
    fetch: (input) => fetchUsage(inputSchema.parse(input), fetchApi),
  });
  return () => {};
}
`,
      );
    }
  }

  const harness = new V2Harness();
  harness.info.location = { directory: projectDir };
  harness.info.model = { providerID: "openai", id: "gpt-5.4" };
  harness.api.provider.list = async () => ({
    location: harness.info.location,
    data: [
      { id: "openai", name: "OpenAI", activation: "enabled", package: "openai" },
      { id: "opencode-go", name: "OpenCode Go", activation: "enabled", package: "opencode-go" },
      {
        id: "minimax-coding-plan",
        name: "MiniMax",
        activation: "enabled",
        package: "minimax",
      },
    ],
  });
  harness.api.model.list = async () => ({
    location: harness.info.location,
    data: [
      {
        id: "gpt-5.4",
        providerID: "openai",
        name: "GPT-5.4",
        enabled: true,
        limit: { context: 200_000, output: 16_000 },
        capabilities: { input: ["text"], tools: true },
        variants: [],
      },
      {
        id: "deepseek-v4.1-flash",
        providerID: "opencode-go",
        name: "DeepSeek V4.1 Flash",
        enabled: true,
        limit: { context: 128_000, output: 8_000 },
        capabilities: { input: ["text"], tools: true },
        variants: [],
      },
      {
        id: "MiniMax-M2.7",
        providerID: "minimax-coding-plan",
        name: "MiniMax M2.7",
        enabled: true,
        limit: { context: 200_000, output: 16_000 },
        capabilities: { input: ["text"], tools: true },
        variants: [],
      },
    ] as never,
  });
  harness.api.session.switchModel = async () => ({ ...harness.info });

  const openCodeClient = new OpenCodeV2AgentClient({
    logger: createTestLogger(),
    settings: { env: { HOME: home, XDG_DATA_HOME: dataHome } },
    runtime: harness.runtime,
  });

  const daemon = await createTestPaseoDaemon({
    mcpEnabled: false,
    pluginsEnabled: false,
    agentClients: { opencode: openCodeClient },
    builtinPlugins: new BuiltinPluginLoader(plugins, [
      "codex-usage-source",
      "opencode-go-usage-source",
      "minimax-usage-source",
    ]),
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await client.connect();
    const agent = await client.createAgent({
      provider: "opencode",
      cwd: projectDir,
      model: "openai/gpt-5.4",
    });

    // 1. OpenAI model -> resolves Codex usage from opencode.db (34%), not expired v1 auth.json
    expect(agent.usageScopeKey).toMatch(/:openai\/gpt-5\.4$/);
    const codexReports = (await client.listUsageReports({ agentId: agent.id })).reports;
    expect(codexReports.map((entry) => entry.id)).toEqual(["codex:v2-chatgpt-account"]);
    expect(codexReports[0]?.report.status).toBe("available");
    expect(codexReports[0]?.report.windows[0]?.usedPct).toBe(34);

    // Host Usage panel also reports Codex from opencode.db and OpenCode Go.
    const hostReports = (await client.listUsageReports()).reports;
    expect(hostReports.find((entry) => entry.id === "codex:v2-chatgpt-account")).toMatchObject({
      report: { status: "available", windows: [{ usedPct: 34 }] },
    });
    expect(hostReports.find((entry) => entry.sourceId === "opencode-go")?.report.status).toBe(
      "available",
    );

    // 2. Switch to OpenCode Go model -> resolves OpenCode Go usage (rolling 15%, weekly 45%)
    await client.setAgentModel(agent.id, "opencode-go/deepseek-v4.1-flash");
    const goReports = (await client.listUsageReports({ agentId: agent.id })).reports;
    expect(goReports).toHaveLength(1);
    expect(goReports[0]?.sourceId).toBe("opencode-go");
    expect(goReports[0]?.report.status).toBe("available");
    expect(goReports[0]?.report.windows[0]?.usedPct).toBe(15);

    // 3. Switch to MiniMax coding plan model -> resolves MiniMax usage (interval 30%, weekly 18%)
    await client.setAgentModel(agent.id, "minimax-coding-plan/MiniMax-M2.7");
    const miniMaxReports = (await client.listUsageReports({ agentId: agent.id })).reports;
    expect(miniMaxReports.map((entry) => entry.id)).toEqual(["minimax:default"]);
    expect(miniMaxReports[0]?.report.status).toBe("available");
    expect(miniMaxReports[0]?.report.windows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "interval_MiniMax-M2.7", usedPct: 30 }),
        expect.objectContaining({ id: "weekly_MiniMax-M2.7", usedPct: 18 }),
      ]),
    );
    // Once discovered via the agent session, MiniMax also appears in Host Usage.
    const hostWithMiniMax = (await client.listUsageReports()).reports;
    expect(hostWithMiniMax.find((entry) => entry.id === "minimax:default")?.report.status).toBe(
      "available",
    );
  } finally {
    await client.close();
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("#3589: host usage lists each enabled custom provider with strict source scoping and secret stripping", async () => {
  for (const name of API_HOST_ENV) vi.stubEnv(name, undefined);
  vi.stubEnv("GITHUB_TOKEN", "shell-github-secret");
  vi.stubEnv("OPENAI_API_KEY", "shell-openai-secret");
  const root = await mkdtemp(path.join(os.tmpdir(), "usage-provider-env-"));
  const home = path.join(root, "home");
  const scopeLogPath = path.join(root, "scopes.ndjson");
  const dir = (name: string) => path.join(root, name);
  await json(path.join(home, ".claude", ".credentials.json"), {
    claudeAiOauth: { accessToken: "fixture-default" },
  });
  await json(path.join(home, ".codex", "auth.json"), {
    tokens: { access_token: "fixture-codex", account_id: "chatgpt-default" },
  });
  for (const name of ["work", "personal", "same", "off", "oauth", "wrapper"]) {
    await json(path.join(dir(`claude-${name}`), ".credentials.json"), {
      claudeAiOauth: { accessToken: `fixture-${name}` },
    });
  }
  await json(path.join(dir("claude-stale"), ".credentials.json"), {
    claudeAiOauth: { accessToken: "fixture-stale", expiresAt: 1 },
  });
  await json(path.join(dir("codex-work"), "auth.json"), {
    tokens: { access_token: "fixture-codex-work", account_id: "chatgpt-work" },
  });
  await json(path.join(dir("codex-wrapper"), "auth.json"), {
    tokens: { access_token: "fixture-codex-wrapper", account_id: "chatgpt-wrapper" },
  });

  // Third-party spy plugin registering both an unscoped source and an unrelated-provider source.
  const spyPluginDir = path.join(root, "spy-plugin");
  await mkdir(spyPluginDir, { recursive: true });
  await writeFile(
    path.join(spyPluginDir, "paseo-plugin.json"),
    JSON.stringify({ id: "spy-usage", requirements: { paseo: ">=0.9.2" } }),
  );
  await writeFile(
    path.join(spyPluginDir, "index.server.ts"),
    `
import { appendFile } from 'node:fs/promises';
import { z } from 'zod';
export default function contribute(server) {
  server.registerUsageSource({
    id: 'spy-unscoped',
    label: 'Spy Unscoped',
    input: z.object({}),
    discover: async (scope) => {
      await appendFile(${JSON.stringify(scopeLogPath)}, JSON.stringify({ source: 'spy-unscoped', scope }) + '\\n');
      return [];
    },
    fetch: async () => ({ status: 'available', windows: [] }),
  });
  server.registerUsageSource({
    id: 'spy-other',
    label: 'Spy Other',
    providers: ['other'],
    input: z.object({}),
    discover: async (scope) => {
      await appendFile(${JSON.stringify(scopeLogPath)}, JSON.stringify({ source: 'spy-other', scope }) + '\\n');
      return [];
    },
    fetch: async () => ({ status: 'available', windows: [] }),
  });
  return () => {};
}
`,
  );

  const builtinPlugins = await injectedUsageSources({
    root,
    lookup: { home, env: {} },
    scopeLogPath,
    fetchApi: `async function fetchApi(url, init) {
  const token = new Headers(init.headers).get('Authorization');
  if (String(url).endsWith('/profile')) {
    const uuid = { 'Bearer fixture-work': 'work', 'Bearer fixture-personal': 'personal', 'Bearer fixture-off': 'off', 'Bearer fixture-oauth': 'oauth', 'Bearer fixture-wrapper': 'wrapper' }[token] || 'default';
    return new Response(JSON.stringify({ account: { uuid }, organization: { uuid: 'org' } }));
  }
  const pct = { 'Bearer fixture-work': 24, 'Bearer fixture-personal': 68, 'Bearer fixture-codex-work': 41 }[token] || 10;
  return new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: pct } }, five_hour: { utilization: pct } }));
}`,
  });
  const daemon = await createTestPaseoDaemon({
    pluginsEnabled: true,
    builtinPlugins,
    providerOverrides: {
      "claude-work": {
        extends: "claude",
        label: "Claude (work)",
        env: {
          CLAUDE_CONFIG_DIR: dir("claude-work"),
          OPENAI_API_KEY: "secret-openai-work",
          GITHUB_TOKEN: "secret-github-work",
          MY_SECRET: "secret-custom-work",
        },
      },
      "claude-oauth": {
        extends: "claude",
        label: "Claude (OAuth token)",
        env: {
          CLAUDE_CONFIG_DIR: dir("claude-oauth"),
          CLAUDE_CODE_OAUTH_TOKEN: "secret-oauth-work",
        },
      },
      "claude-wrapper": {
        extends: "claude",
        label: "Claude (wrapper)",
        command: ["/opt/homebrew/bin/teamclaude", "run", "--"],
        env: {
          CLAUDE_CONFIG_DIR: dir("claude-wrapper"),
        },
      },
      "claude-personal": {
        extends: "claude",
        label: "Claude (personal)",
        env: {
          CLAUDE_CONFIG_DIR: dir("claude-personal"),
          MY_SECRET: "secret-custom-personal",
        },
      },
      "claude-same": {
        extends: "claude",
        label: "Claude (same)",
        env: { CLAUDE_CONFIG_DIR: dir("claude-same") },
      },
      "claude-stale": {
        extends: "claude",
        label: "Claude (stale)",
        env: { CLAUDE_CONFIG_DIR: dir("claude-stale") },
      },
      "claude-off": {
        extends: "claude",
        label: "Claude (off)",
        enabled: false,
        env: { CLAUDE_CONFIG_DIR: dir("claude-off") },
      },
      "claude-secret-only": {
        extends: "claude",
        label: "Claude (API key)",
        env: {
          ANTHROPIC_API_KEY: "secret-only-key",
          MY_SECRET: "secret-only-val",
        },
      },
      "codex-work": {
        extends: "codex",
        label: "Codex (work)",
        env: {
          CODEX_HOME: dir("codex-work"),
          OPENAI_API_KEY: "secret-openai-work",
          MY_SECRET: "secret-codex-custom",
        },
      },
      "codex-wrapper": {
        extends: "codex",
        label: "Codex (wrapper)",
        command: ["/opt/homebrew/bin/teamcodex", "run", "--"],
        env: {
          CODEX_HOME: dir("codex-wrapper"),
        },
      },
    },
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  const listed = async (status: "available" | "unavailable") =>
    (await client.listUsageReports()).reports.filter((entry) => entry.report.status === status);
  const availableById = async () =>
    Object.fromEntries(
      (await listed("available")).map((entry) => [
        entry.id,
        entry.report.status === "available" ? entry.report.windows[0]?.usedPct : undefined,
      ]),
    );
  try {
    await client.connect();
    await client.installDirectoryPlugin(spyPluginDir, "spy-usage");

    expect(await availableById()).toEqual({
      "claude:default.org": 10,
      "claude:work.org": 24,
      "claude:personal.org": 68,
      "codex:chatgpt-default": 10,
      "codex:chatgpt-work": 41,
    });
    expect((await listed("unavailable")).map((entry) => entry.loginErrors)).toEqual([
      [
        {
          harness: "Claude (stale)",
          report: {
            status: "unavailable",
            problem: {
              kind: "expired",
              expiresAt: "1970-01-01T00:00:00.001Z",
              refreshedBy: "claude",
            },
          },
        },
      ],
    ]);

    // Verify strict source scoping and zero secret leakage across all recorded discovery calls.
    const recorded = (await readFile(scopeLogPath, "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            source: string;
            scope: { kind: string; provider?: string; env?: Record<string, string> };
          },
      );
    const spyScopes = recorded.filter(
      (entry) => entry.source === "spy-unscoped" || entry.source === "spy-other",
    );
    expect(spyScopes.length).toBeGreaterThan(0);
    expect(spyScopes.every((entry) => entry.scope.kind === "global")).toBe(true);

    const claudeSessions = recorded.filter(
      (entry) => entry.source === "claude" && entry.scope.kind === "session",
    );
    expect(claudeSessions.length).toBeGreaterThan(0);
    expect(claudeSessions.every((entry) => entry.scope.provider === "claude")).toBe(true);

    const codexSessions = recorded.filter(
      (entry) => entry.source === "codex" && entry.scope.kind === "session",
    );
    expect(codexSessions.length).toBeGreaterThan(0);
    expect(codexSessions.every((entry) => entry.scope.provider === "codex")).toBe(true);

    const allSessionEnvs = recorded.flatMap((entry) =>
      entry.scope.kind === "session" && entry.scope.env ? [entry.scope.env] : [],
    );
    for (const env of allSessionEnvs) {
      expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
      expect(env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
      expect(env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
      expect(env).not.toHaveProperty("OPENAI_API_KEY");
      expect(env).not.toHaveProperty("GITHUB_TOKEN");
      expect(env).not.toHaveProperty("MY_SECRET");
    }
    const serializedLog = JSON.stringify(recorded);
    expect(serializedLog).not.toContain("secret-");
    expect(serializedLog).not.toContain("shell-github-secret");
    expect(serializedLog).not.toContain("shell-openai-secret");

    await client.patchDaemonConfig({ providers: { "claude-work": { enabled: false } } });
    expect(Object.keys(await availableById()).sort()).toEqual([
      "claude:default.org",
      "claude:personal.org",
      "codex:chatgpt-default",
      "codex:chatgpt-work",
    ]);
  } finally {
    await client.close();
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("#3589: a provider whose agents talk to another API host has no login in the host list", async () => {
  vi.stubEnv("ANTHROPIC_BASE_URL", "https://llm-proxy.example");
  const root = await mkdtemp(path.join(os.tmpdir(), "usage-provider-host-"));
  await json(path.join(root, "claude-work", ".credentials.json"), {
    claudeAiOauth: { accessToken: "fixture-work" },
  });
  const builtinPlugins = await injectedUsageSources({
    root,
    lookup: { home: path.join(root, "home"), env: {} },
    fetchApi: `async function fetchApi(url) {
  if (String(url).endsWith('/profile')) {
    return new Response(JSON.stringify({ account: { uuid: 'work' }, organization: { uuid: 'org' } }));
  }
  return new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 1 } }, five_hour: { utilization: 1 } }));
}`,
  });
  const daemon = await createTestPaseoDaemon({
    pluginsEnabled: false,
    builtinPlugins,
    providerOverrides: {
      "claude-work": {
        extends: "claude",
        label: "Claude (work)",
        env: { CLAUDE_CONFIG_DIR: path.join(root, "claude-work") },
      },
    },
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await client.connect();
    expect((await client.listUsageReports()).reports).toEqual([]);
  } finally {
    await client.close();
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("#3589: an empty default store and disabled built-in provider do not hide configured accounts", async () => {
  for (const name of API_HOST_ENV) vi.stubEnv(name, undefined);
  const root = await mkdtemp(path.join(os.tmpdir(), "usage-empty-default-"));
  const providerOverrides: Record<string, ProviderOverride> = { claude: { enabled: false } };
  for (let i = 0; i < 5; i++) {
    const configDir = path.join(root, `account-${i}`);
    await json(path.join(configDir, ".credentials.json"), {
      claudeAiOauth: { accessToken: `fixture-independent-${i}` },
    });
    providerOverrides[`claude-${i}`] = {
      extends: "claude",
      label: `Account ${i}`,
      env: { CLAUDE_CONFIG_DIR: configDir },
    };
  }
  const builtinPlugins = await injectedUsageSources({
    root,
    lookup: { home: path.join(root, "empty-home"), env: {} },
    fetchApi: `async function fetchApi(url, init) {
      const token = new Headers(init.headers).get('Authorization');
      const uuid = token.slice('Bearer fixture-independent-'.length);
      if (String(url).endsWith('/profile')) return new Response(JSON.stringify({account:{uuid},organization:{uuid:'independent'}}));
      return new Response(JSON.stringify({five_hour:{utilization:7},seven_day:{utilization:13}}));
    }`,
  });
  const daemon = await createTestPaseoDaemon({
    pluginsEnabled: false,
    builtinPlugins,
    providerOverrides,
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await client.connect();
    const reports = (await client.listUsageReports()).reports;
    expect(reports.map((x) => x.id).sort()).toEqual(
      [0, 1, 2, 3, 4].map((i) => `claude:${i}.independent`),
    );
    expect(reports.every((x) => x.report.status === "available")).toBe(true);
  } finally {
    await client.close();
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("live Claude and Codex rate-limit observations push status.usage_report_changed without polling", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-live-usage-push-"));
  const workspaceDir = path.join(root, "workspace");
  await mkdir(workspaceDir, { recursive: true });
  const pluginDir = path.join(root, "live-usage-fixture");
  await mkdir(pluginDir, { recursive: true });
  await writeFile(
    path.join(pluginDir, "paseo-plugin.json"),
    JSON.stringify({ id: "live-usage-fixture", requirements: { paseo: ">=0.18.0" } }),
  );
  const fetchCountFile = path.join(root, "fetch-counts.json");
  await writeFile(fetchCountFile, JSON.stringify({ claude: 0, codex: 0 }));
  await writeFile(
    path.join(pluginDir, "index.server.ts"),
    `
import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
const countFile = ${JSON.stringify(fetchCountFile)};
function bump(source) {
  const counts = JSON.parse(readFileSync(countFile, "utf8"));
  counts[source] = (counts[source] ?? 0) + 1;
  writeFileSync(countFile, JSON.stringify(counts));
  return counts[source];
}
export default function contribute(server) {
  server.registerUsageSource({
    id: "claude",
    label: "Claude",
    input: z.object({}),
    discover: async (scope) => {
      if (scope.kind === "session" && scope.provider !== "claude") return [];
      if (scope.kind === "session" && scope.env.HOME === "/missing-claude") return [];
      return [{ key: "acct", input: {} }];
    },
    fetch: async () => {
      bump("claude");
      return {
        status: "available",
        windows: [
          { id: "five_hour", label: "Session", shortLabel: "5h", summary: true, usedPct: 12, remainingPct: 88, tone: "ok" },
          { id: "weekly", label: "Weekly", shortLabel: "wk", summary: true, usedPct: 24, remainingPct: 76, tone: "ok" },
        ],
      };
    },
  });
  server.registerUsageSource({
    id: "codex",
    label: "Codex",
    input: z.object({}),
    discover: async (scope) => {
      if (scope.kind === "session" && scope.provider !== "codex") return [];
      return [{ key: "acct", input: {} }];
    },
    fetch: async () => {
      bump("codex");
      return {
        status: "available",
        planLabel: "plus",
        windows: [
          { id: "five_hour", label: "5-hour", shortLabel: "5h", summary: true, usedPct: 8, remainingPct: 92, tone: "ok" },
          { id: "weekly", label: "Weekly", shortLabel: "wk", summary: true, usedPct: 19, remainingPct: 81, tone: "ok" },
        ],
        balances: [{ id: "credits", label: "Credits", remaining: 10, unit: "credits", tone: "ok" }],
      };
    },
  });
  return () => {};
}
`,
  );

  const emitters = new Map<string, (event: AgentStreamEvent) => void>();
  function createObservableClient(
    provider: "claude" | "codex",
    homeByCwd: Record<string, string>,
  ): AgentClient {
    const base = createTestAgentClient(provider);
    const wrap = (session: AgentSession, cwd: string): AgentSession => {
      const listeners = new Set<AgentStreamEventHandler>();
      const home = homeByCwd[cwd] ?? "/discovered";
      const key = `${provider}:${home}`;
      emitters.set(key, (event) => {
        for (const listener of listeners) listener(event);
      });
      return new Proxy(session, {
        get(target, prop, receiver) {
          if (prop === "subscribe") {
            return (handler: AgentStreamEventHandler) => {
              listeners.add(handler);
              const unsub = target.subscribe(handler);
              return () => {
                listeners.delete(handler);
                unsub();
              };
            };
          }
          if (prop === "usageSession") {
            return () => ({ provider, env: { HOME: home }, sessionKey: key });
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };
    return {
      ...base,
      createSession: async (config, launchContext) =>
        wrap(await base.createSession(config, launchContext), config.cwd),
      resumeSession: async (handle, overrides, launchContext) =>
        wrap(
          await base.resumeSession(handle, overrides, launchContext),
          overrides?.cwd ?? workspaceDir,
        ),
      fetchCatalog: (options) => base.fetchCatalog(options),
      isAvailable: () => base.isAvailable(),
    };
  }

  const missingWorkspaceDir = path.join(root, "workspace-missing");
  await mkdir(missingWorkspaceDir, { recursive: true });
  const daemon = await createTestPaseoDaemon({
    daemonVersion: "0.18.2",
    pluginsEnabled: false,
    builtinPlugins: new BuiltinPluginLoader(root, ["live-usage-fixture"]),
    agentClients: {
      claude: createObservableClient("claude", {
        [workspaceDir]: "/discovered-claude",
        [missingWorkspaceDir]: "/missing-claude",
      }),
      codex: createObservableClient("codex", { [workspaceDir]: "/discovered-codex" }),
    },
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.18.2",
  });
  const pushed: Array<{
    id: string;
    usedPct: number | null | undefined;
    planLabel?: string;
    credits?: number | null;
  }> = [];
  let feed: ReturnType<DaemonClient["observeEvents"]> | null = null;
  try {
    await client.connect();
    expect(client.getLastServerInfoMessage()?.features?.usageReportUpdates).toBe(true);

    feed = client.observeEvents(["status.usage_report_changed"]);
    feed.subscribe({
      snapshot: () => {},
      update: (message) => {
        if (message.type !== "status") return;
        const parsed = UsageReportChangedStatusPayloadSchema.safeParse(message.payload);
        if (!parsed.success) return;
        const { report } = parsed.data;
        const available = report.report.status === "available" ? report.report : null;
        pushed.push({
          id: report.id,
          usedPct: available?.windows.find((w) => w.id === "five_hour")?.usedPct,
          planLabel: available?.planLabel,
          credits: available?.balances?.find((b) => b.id === "credits")?.remaining,
        });
      },
    });
    await feed.ready;

    // Seed initial cached reports for both discovered accounts.
    const initial = await client.listUsageReports();
    expect(initial.reports.map((r) => r.id).sort()).toEqual(["claude:acct", "codex:acct"]);

    // Create discovered Claude & Codex agents plus one Claude agent with no discovered account.
    await client.createAgent({ provider: "claude", cwd: workspaceDir });
    await client.createAgent({ provider: "codex", cwd: workspaceDir });
    await client.createAgent({ provider: "claude", cwd: missingWorkspaceDir });

    const claudeWindows = readClaudeRateLimitUsage({
      status: "allowed_warning",
      unifiedWindows: {
        five_hour: { utilization: 0.73, resetsAt: 1795725600 },
        seven_day: { utilization: 0.9, resetsAt: 1795917600 },
      },
    });
    expect(claudeWindows).not.toBeNull();
    emitters.get("claude:/discovered-claude")?.({
      type: "usage_observed",
      provider: "claude",
      sourceId: CLAUDE_USAGE_SOURCE_ID,
      windows: claudeWindows!,
    });

    const codexObserved = readCodexRateLimitUsage({
      limitId: "codex",
      planType: "pro",
      primary: { usedPercent: 41, windowDurationMins: 300, resetsAt: 1795725600 },
      secondary: { usedPercent: 62, windowDurationMins: 10080, resetsAt: 1795917600 },
      credits: { balance: "19.5" },
    });
    expect(codexObserved).not.toBeNull();
    emitters.get("codex:/discovered-codex")?.({
      type: "usage_observed",
      provider: "codex",
      sourceId: CODEX_USAGE_SOURCE_ID,
      windows: codexObserved!.windows,
      balances: codexObserved!.balances,
      planLabel: codexObserved!.planLabel,
    });

    // Observation from an agent with no discovered account is ignored cleanly.
    emitters.get("claude:/missing-claude")?.({
      type: "usage_observed",
      provider: "claude",
      sourceId: CLAUDE_USAGE_SOURCE_ID,
      windows: claudeWindows!,
    });

    await expect
      .poll(() => pushed)
      .toEqual([
        { id: "claude:acct", usedPct: 73, planLabel: undefined, credits: undefined },
        { id: "codex:acct", usedPct: 41, planLabel: "pro", credits: 19.5 },
      ]);

    // Cached reports reflect the pushed live observations with zero additional vendor fetches.
    const after = await client.listUsageReports();
    expect(after.reports.map((r) => r.id).sort()).toEqual(["claude:acct", "codex:acct"]);
    const claudeAfter = after.reports.find((r) => r.id === "claude:acct");
    const codexAfter = after.reports.find((r) => r.id === "codex:acct");
    expect(
      claudeAfter?.report.status === "available" ? claudeAfter.report.windows[0]?.usedPct : null,
    ).toBe(73);
    expect(
      codexAfter?.report.status === "available" ? codexAfter.report.windows[0]?.usedPct : null,
    ).toBe(41);
    expect(JSON.parse(await readFile(fetchCountFile, "utf8"))).toEqual({ claude: 1, codex: 1 });
  } finally {
    await feed?.release().catch(() => undefined);
    await client.close();
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
