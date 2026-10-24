import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { BuiltinPluginLoader, resolveBuiltinPluginsRoot } from "./builtin/index.js";

const fixtureRoot = fileURLToPath(new URL("./test-fixtures/", import.meta.url));
const subprocessDirectory = fileURLToPath(
  new URL("./test-fixtures/usage-source-directory/", import.meta.url),
);

async function json(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value));
}

/** The real Claude and Codex readers, compiled as built-ins, with home, env and HTTP injected. */
interface UsageLookup {
  home: string;
  env: Record<string, string>;
}

interface InjectedUsageSourcesOptions {
  root: string;
  lookup: UsageLookup;
  /** Source of an `async function fetchApi(url, init)` the readers call instead of the network. */
  fetchApi: string;
}

async function injectedUsageSources({
  root,
  lookup,
  fetchApi,
}: InjectedUsageSourcesOptions): Promise<BuiltinPluginLoader> {
  const plugins = path.join(root, "plugins");
  for (const source of ["codex", "claude"]) {
    const directory = path.join(plugins, `${source}-usage-source`);
    await cp(path.join(resolveBuiltinPluginsRoot(), `${source}-usage-source`), directory, {
      recursive: true,
    });
    await writeFile(
      path.join(directory, "index.server.ts"),
      `
import { inputSchema } from './shared/input.js';
import { discover, fetchUsage } from './server/usage.js';
const lookup = { home: ${JSON.stringify(lookup.home)}, env: ${JSON.stringify(lookup.env)}, platform: 'linux' };
${fetchApi}
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
  return new BuiltinPluginLoader(plugins, ["codex-usage-source", "claude-usage-source"]);
}

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
  const builtinPlugins = await injectedUsageSources({
    root: root,
    lookup: { home, env },
    fetchApi: `async function fetchApi(url, init) {
  const token = new Headers(init.headers).get('Authorization');
  if (String(url).endsWith('/profile')) {
    const second = token === 'Bearer fixture-pi-claude';
    return new Response(JSON.stringify({ account: { uuid: second ? 'claude-two' : 'claude-one' }, organization: { uuid: second ? 'org-two' : 'org-one' } }));
  }
  if (token === 'Bearer fixture-revoked') return new Response(null, { status: 401 });
  const used = { 'Bearer fixture-codex': 11, 'Bearer fixture-opencode': 22, 'Bearer fixture-pi-codex': 33, 'Bearer fixture-omp-codex': 44, 'Bearer fixture-omp-claude': 66, 'Bearer fixture-pi-claude': 77 }[token] || 55;
  return new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: used } }, five_hour: { utilization: used } }));
}`,
  });
  const daemon = await createTestPaseoDaemon({ pluginsEnabled: false, builtinPlugins });
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

// The daemon launches every provider with its own environment, and a source lists nothing for a
// provider that sends its agents to another API host. A developer's shell, or the repo's .env,
// can already set these.
const API_HOST_ENV = [
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "OPENAI_BASE_URL",
];

afterEach(() => {
  vi.unstubAllEnvs();
});

test("#3589: host usage lists each enabled provider's own login without an agent", async () => {
  for (const name of API_HOST_ENV) vi.stubEnv(name, undefined);
  const root = await mkdtemp(path.join(os.tmpdir(), "usage-provider-env-"));
  const home = path.join(root, "home");
  const dir = (name: string) => path.join(root, name);
  await json(path.join(home, ".claude", ".credentials.json"), {
    claudeAiOauth: { accessToken: "fixture-default" },
  });
  await json(path.join(home, ".codex", "auth.json"), {
    tokens: { access_token: "fixture-codex", account_id: "chatgpt-default" },
  });
  // claude-same holds the default account's login in another directory.
  for (const name of ["work", "same", "off"]) {
    await json(path.join(dir(`claude-${name}`), ".credentials.json"), {
      claudeAiOauth: { accessToken: `fixture-${name}` },
    });
  }
  // claude-stale's token expired. Nothing says whose account it is, so it is a card of its own.
  await json(path.join(dir("claude-stale"), ".credentials.json"), {
    claudeAiOauth: { accessToken: "fixture-stale", expiresAt: 1 },
  });
  await json(path.join(dir("codex-work"), "auth.json"), {
    tokens: { access_token: "fixture-codex-work", account_id: "chatgpt-work" },
  });
  const builtinPlugins = await injectedUsageSources({
    root: root,
    lookup: { home, env: {} },
    fetchApi: `async function fetchApi(url, init) {
  const token = new Headers(init.headers).get('Authorization');
  if (String(url).endsWith('/profile')) {
    const uuid = { 'Bearer fixture-work': 'work', 'Bearer fixture-off': 'off' }[token] || 'default';
    return new Response(JSON.stringify({ account: { uuid }, organization: { uuid: 'org' } }));
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
        env: { CLAUDE_CONFIG_DIR: dir("claude-work") },
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
      "codex-work": {
        extends: "codex",
        label: "Codex (work)",
        env: { CODEX_HOME: dir("codex-work") },
      },
    },
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  const listed = async (status: "available" | "unavailable") =>
    (await client.listUsageReports()).reports.filter((entry) => entry.report.status === status);
  const availableIds = async () => (await listed("available")).map((entry) => entry.id).sort();
  try {
    await client.connect();
    expect(await availableIds()).toEqual([
      "claude:default.org",
      "claude:work.org",
      "codex:chatgpt-default",
      "codex:chatgpt-work",
    ]);
    // Several cards can read the same failure, so the card says which provider's login it is.
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
    await client.patchDaemonConfig({ providers: { "claude-work": { enabled: false } } });
    expect(await availableIds()).toEqual([
      "claude:default.org",
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
    root: root,
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
