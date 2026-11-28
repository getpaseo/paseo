import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { once } from "node:events";
import { expect, test } from "vitest";
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
  async function json(file: string, value: unknown) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(value));
  }
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
  const { readFile } = await import("node:fs/promises");
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
