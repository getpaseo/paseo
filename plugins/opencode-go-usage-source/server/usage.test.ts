import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { inputSchema } from "../shared/input.js";
import { installedOpenCode, type OpenCodeInstall } from "./opencode.js";
import { discover, fetchUsage } from "./usage.js";

// Stands in for the OpenCode CLI: it answers the two commands the source runs, the way the real
// OpenCode 1.19.5 and 2.4.1 answer them, and logs every call.
const OPENCODE_CLI = `
import { appendFileSync, readFileSync } from "node:fs";
const state = JSON.parse(readFileSync(new URL("./opencode-state.json", import.meta.url), "utf8"));
const command = process.argv.slice(2).join(" ");
const colors = process.env.FORCE_COLOR && !process.env.NO_COLOR;
appendFileSync(new URL("./opencode-calls.log", import.meta.url), command + "\\n");
if (command === "--version" && state.hangs) setInterval(() => {}, 60_000);
else if (command === "--version" && state.version)
  console.log(colors && state.coloredVersion ? state.coloredVersion : state.version);
else if (command === "auth export --standalone" && state.exported !== undefined)
  process.stdout.write(state.exported);
else {
  console.error("opencode providers");
  process.exit(1);
}
`;

interface Credential {
  integrationID: string;
  value: unknown;
  active?: boolean;
}
let fixtureDirectory: string;
let authFile: string;
let install: OpenCodeInstall;

function installState(state: {
  version?: string;
  coloredVersion?: string;
  exported?: string;
  hangs?: boolean;
}) {
  return writeFile(join(fixtureDirectory, "opencode-state.json"), JSON.stringify(state));
}
/** OpenCode 1 keeps logins in auth.json and has no `auth export`. */
function openCode1() {
  return installState({ version: "1.19.5" });
}
/** OpenCode 2 lists its own logins and never reads auth.json. */
function openCode2(credentials: Credential[]) {
  const exported = credentials.map((credential, index) => ({
    id: `cred_${index}`,
    label: "API key",
    active: true,
    ...credential,
  }));
  return installState({
    version: "opencode v2.4.1",
    coloredVersion: "\u001b[1mopencode\u001b[0m \u001b[2mv\u001b[0m\u001b[1m2.4.1\u001b[0m",
    exported: JSON.stringify(exported),
  });
}
async function openCodeCalls() {
  const log = await readFile(join(fixtureDirectory, "opencode-calls.log"), "utf8");
  return log.trimEnd().split("\n");
}
/** The database OpenCode creates next to auth.json, with OpenCode's credential table. */
async function database(credentials: Array<{ integration: string; label: string }> | null) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(fixtureDirectory, "opencode.db"));
  db.exec("CREATE TABLE session (id TEXT PRIMARY KEY)");
  if (credentials) {
    db.exec(
      "CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT NOT NULL, value TEXT NOT NULL, connector_id TEXT, method_id TEXT, active INTEGER, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)",
    );
    const insert = db.prepare(
      "INSERT INTO credential (id, integration_id, label, value, time_created, time_updated) VALUES (?, ?, ?, ?, 1, 1)",
    );
    for (const { integration, label } of credentials)
      insert.run(integration, integration, label, JSON.stringify({ type: "key", key: "other" }));
  }
  db.close();
}
const account = (store: "file" | "credentials") => ({
  key: expect.stringMatching(/^[a-f0-9]{64}$/),
  input: { store },
});
const goKey = (key: string, active = true): Credential => ({
  integrationID: "opencode-go",
  value: { type: "key", key },
  active,
});

beforeEach(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "go-default-"));
  authFile = join(fixtureDirectory, "auth.json");
  await writeFile(authFile, JSON.stringify({ "opencode-go": { type: "api", key: "file-key" } }));
  const cli = join(fixtureDirectory, "opencode.mjs");
  await writeFile(cli, OPENCODE_CLI);
  install = { command: process.execPath, args: [cli], env: process.env, authFile };
  await openCode1();
});
afterEach(async () => {
  await rm(fixtureDirectory, { recursive: true, force: true });
});

test("discovery input holds no path and no API key", () => {
  expect(inputSchema.safeParse({ apiKey: "unused" }).success).toBe(false);
  expect(inputSchema.safeParse({ store: "credentials", apiKey: "unused" }).success).toBe(false);
  expect(inputSchema.safeParse({ store: "file", path: authFile }).success).toBe(false);
  expect(() => inputSchema.parse({})).toThrow();
});

const CONSOLE_STATUS_URL = "https://opencode.ai/console/api/go/status";
const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const upstreamResponse = {
  usage: {
    rolling: { status: "ok", percent: 21, resetsAt: "2026-09-26T20:00:00.000Z" },
    weekly: { status: "ok", percent: 42, resetsAt: "2026-09-28T00:00:00.000Z" },
    monthly: { status: "rate-limited", percent: 100, resetsAt: "2026-10-01T00:00:00.000Z" },
  },
};
const bearer = (init?: RequestInit) => new Headers(init?.headers).get("Authorization");

// OpenCode 1.17.5 and newer creates the credential table too, and keeps every login in auth.json.
// OpenCode 2 fills that table when it opens the same directory, and OpenCode 1 keeps using the file.
test.each([
  ["no credential table", null],
  ["an empty credential table", []],
  [
    "only an unrelated credential that OpenCode 2 imported",
    [{ integration: "manifest", label: "API key" }],
  ],
  [
    "a Go credential that OpenCode 2 imported before the key changed",
    [{ integration: "opencode-go", label: "API key" }],
  ],
])("reads OpenCode 1's Go key from auth.json next to a database with %s", async (_name, rows) => {
  await database(rows);
  const accounts = await discover(install);
  expect(accounts).toEqual([account("file")]);
  const report = await fetchUsage(
    inputSchema.parse(accounts[0]!.input),
    async (_url, init) => {
      expect(bearer(init)).toBe("Bearer file-key");
      return Response.json(upstreamResponse);
    },
    install,
  );
  expect(report.status).toBe("available");
  // OpenCode 1 has no login listing, so it is never asked for one.
  expect(await openCodeCalls()).toEqual(["--version"]);
});

test("reads auth.json when OpenCode is not installed", async () => {
  const absent = { ...install, command: join(fixtureDirectory, "absent-opencode"), args: [] };
  expect(await discover(absent)).toEqual([account("file")]);
});

test("reads auth.json when OpenCode fails its version check", async () => {
  await installState({});
  expect(await discover(install)).toEqual([account("file")]);
});

// A check that is cut off does not show which store OpenCode uses. Reading auth.json here would
// drop the card of a login that only OpenCode 2 has.
test("fails instead of reading auth.json when OpenCode does not answer its version check", async () => {
  await installState({ hangs: true });
  await expect(discover(install)).rejects.toThrow("OpenCode did not report its version in time");
}, 15_000);

test("uses the Go key OpenCode 2 marks active instead of a stale auth.json key", async () => {
  await openCode2([goKey("inactive-key", false), goKey("active-key")]);
  const beforeFile = await readFile(authFile);
  const accounts = await discover(install);
  expect(accounts).toEqual([account("credentials")]);
  expect(JSON.stringify(accounts)).not.toContain("active-key");
  const report = await fetchUsage(
    inputSchema.parse(accounts[0]!.input),
    async (_url, init) => {
      expect(bearer(init)).toBe("Bearer active-key");
      return Response.json(upstreamResponse);
    },
    install,
  );
  expect(report.status).toBe("available");
  expect(report.windows.map((window) => window.usedPct)).toEqual([21, 42, 100]);
  expect(await readFile(authFile)).toEqual(beforeFile);
  // --standalone keeps the listing from starting OpenCode's background service.
  expect(await openCodeCalls()).toEqual([
    "--version",
    "auth export --standalone",
    "auth export --standalone",
  ]);
});

// OpenCode 2 colors its version when the environment forces colors, even into a pipe.
test("recognizes OpenCode 2 when the daemon's environment forces terminal colors", async () => {
  await openCode2([goKey("listed-key")]);
  const { NO_COLOR: _unset, ...env } = process.env;
  const colored = { ...install, env: { ...env, FORCE_COLOR: "1" } };
  expect(await discover(colored)).toEqual([account("credentials")]);
});

test("discovers OpenCode 2 Go usage without an auth.json", async () => {
  await openCode2([goKey("listed-key")]);
  await rm(authFile);
  const accounts = await discover(install);
  expect(accounts).toEqual([account("credentials")]);
  expect(JSON.stringify(accounts)).not.toContain("listed-key");
});

test("refresh follows the active Go account and re-reads its rotated key", async () => {
  await openCode2([goKey("first-key"), goKey("second-key", false)]);
  const accounts = await discover(install);
  await openCode2([goKey("first-key", false), goKey("rotated-key")]);
  expect(await discover(install)).toEqual(accounts);
  const report = await fetchUsage(
    inputSchema.parse(accounts[0]!.input),
    async (_url, init) => {
      expect(bearer(init)).toBe("Bearer rotated-key");
      return Response.json(upstreamResponse);
    },
    install,
  );
  expect(report.status).toBe("available");
  expect(JSON.stringify(report)).not.toContain("rotated-key");
});

// The state in #10659: OpenCode 2 opened the directory once and imported an unrelated login, and
// the Go key is only in auth.json.
test("reads the auth.json Go key when OpenCode 2 holds only an unrelated login", async () => {
  await database([{ integration: "manifest", label: "API key" }]);
  await openCode2([{ integrationID: "manifest", value: { type: "key", key: "other" } }]);
  const accounts = await discover(install);
  expect(accounts).toEqual([account("credentials")]);
  const requests: Array<string | null> = [];
  const report = await fetchUsage(
    inputSchema.parse(accounts[0]!.input),
    async (_url, init) => {
      requests.push(bearer(init));
      return Response.json(upstreamResponse);
    },
    install,
  );
  expect(report.status).toBe("available");
  expect(requests).toEqual(["Bearer file-key", "Bearer file-key"]);
});

// A login OpenCode 2 cannot serve Go with from opencode.ai counts as no login.
test.each<[string, Credential[]]>([
  ["no logins", []],
  ["an unrelated login", [{ integrationID: "manifest", value: { type: "key", key: "other" } }]],
  ["a Go key that is not the active one", [goKey("inactive-key", false)]],
  [
    "a Console sign-in on another server",
    [
      {
        integrationID: "opencode",
        value: {
          type: "oauth",
          access: "staging-token",
          expires: 0,
          metadata: { server: "https://staging.example.com/console", orgID: "org_TEST" },
        },
      },
    ],
  ],
  [
    "a Console key on another server",
    [
      {
        integrationID: "opencode",
        value: {
          type: "key",
          key: "staging-key",
          metadata: { server: "https://staging.example.com/console" },
        },
      },
    ],
  ],
  [
    "a sign-in on opencode-go",
    [{ integrationID: "opencode-go", value: { type: "oauth", access: "token", expires: 0 } }],
  ],
  ["an unreadable Go login", [{ integrationID: "opencode-go", value: "invalid" }]],
  ["an empty Go key", [goKey("")]],
])("reads the auth.json Go key when OpenCode 2 has %s", async (_name, credentials) => {
  await openCode2(credentials);
  expect(await discover(install)).toEqual([account("credentials")]);
  const report = await fetchUsage(
    { store: "credentials" },
    async (_url, init) => {
      expect(bearer(init)).toBe("Bearer file-key");
      return Response.json(upstreamResponse);
    },
    install,
  );
  expect(report.status).toBe("available");
});

test("discovers no account when neither OpenCode 2 nor auth.json has a Go login", async () => {
  await openCode2([{ integrationID: "manifest", value: { type: "key", key: "other" } }]);
  await rm(authFile);
  expect(await discover(install)).toEqual([]);
  await expect(
    fetchUsage(
      { store: "credentials" },
      async () => {
        throw new Error("must not fetch");
      },
      install,
    ),
  ).rejects.toThrow("login no longer exists");
});

// A failed listing does not show that OpenCode 2 has no Go login, so auth.json is not read.
test.each([
  ["has no login listing", { version: "opencode v2.0.10" }],
  ["answers with something else", { version: "opencode v2.4.1", exported: "not JSON" }],
  [
    "lists logins in another shape",
    { version: "opencode v2.4.1", exported: JSON.stringify({ "opencode-go": "listed-secret" }) },
  ],
])("fails instead of reading auth.json when OpenCode 2 %s", async (_name, state) => {
  await installState(state);
  const failure = await discover(install).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(String(failure)).toContain("OpenCode could not list its logins");
  expect(JSON.stringify(failure, Object.getOwnPropertyNames(failure))).not.toContain(
    "listed-secret",
  );
});

test("resolves OpenCode and its auth.json from the daemon environment", () => {
  expect(installedOpenCode({ HOME: fixtureDirectory })).toEqual({
    command: "opencode",
    args: [],
    env: { HOME: fixtureDirectory },
    authFile: join(fixtureDirectory, ".local", "share", "opencode", "auth.json"),
  });
  expect(installedOpenCode({ XDG_DATA_HOME: fixtureDirectory }).authFile).toBe(
    join(fixtureDirectory, "opencode", "auth.json"),
  );
});

test("discovers and fetches the key from read-only auth.json", async () => {
  const content = await readFile(authFile, "utf8");
  expect(await discover(install)).toEqual([account("file")]);
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const fetchApi = async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), authorization: bearer(init) });
    return Response.json(upstreamResponse);
  };
  const report = await fetchUsage({ store: "file" }, fetchApi, install);
  expect(requests).toEqual([
    { url: CONSOLE_STATUS_URL, authorization: "Bearer file-key" },
    { url: USAGE_URL, authorization: "Bearer file-key" },
  ]);
  expect(report.status).toBe("available");
  expect(report.windows.map((window) => [window.id, window.usedPct, window.resetsAt])).toEqual([
    ["rolling", 21, "2026-09-26T20:00:00.000Z"],
    ["weekly", 42, "2026-09-28T00:00:00.000Z"],
    ["monthly", 100, "2026-10-01T00:00:00.000Z"],
  ]);
  // The rolling window's length is not reported, so its percent stands without a name.
  expect(report.windows.map((window) => window.shortLabel)).toEqual(["", "wk", "mo"]);
  // The current upstream endpoint returns windows only; do not invent balances.
  expect(report.balances).toBeUndefined();
  expect(await readFile(authFile, "utf8")).toBe(content);
});

test.each([
  ["has another provider's login", JSON.stringify({ openai: { type: "oauth", access: "token" } })],
  ["is empty", "{}"],
  ["is missing", null],
])("discovers no account when auth.json %s", async (_name, content) => {
  if (content === null) await rm(authFile);
  else await writeFile(authFile, content);
  expect(await discover(install)).toEqual([]);
  await expect(
    fetchUsage(
      { store: "file" },
      async () => {
        throw new Error("must not fetch");
      },
      install,
    ),
  ).rejects.toThrow("login no longer exists");
});

test.each([401, 403])("maps HTTP %i to unavailable", async (status) => {
  const report = await fetchUsage(
    { store: "file" },
    async () => new Response(null, { status }),
    install,
  );
  expect(report).toEqual({
    status: "unavailable",
    problem: { kind: "rejected", status, refreshedBy: "opencode" },
  });
});

test("keeps the account identity when OpenCode 2 imports the auth.json Go login", async () => {
  const [legacy] = await discover(install);
  await openCode2([goKey("file-key")]);
  const [migrated] = await discover(install);
  expect(migrated!.input).toEqual({ store: "credentials" });
  // Usage settings are saved per account, so the card keeps its visibility and position.
  expect(migrated!.key).toBe(legacy!.key);
});

const consoleSignIn = (overrides: { expires?: number; server?: string } = {}): Credential => ({
  integrationID: "opencode",
  value: {
    type: "oauth",
    methodID: "device",
    access: "console-token",
    refresh: "console-refresh",
    expires: overrides.expires ?? Date.now() + 3_600_000,
    metadata: {
      ...(overrides.server ? { server: overrides.server } : {}),
      orgID: "org_TESTORG123",
      orgName: "Team",
    },
  },
});
const consoleKey = (key: string): Credential => ({
  integrationID: "opencode",
  value: { type: "key", key },
});
const goStatus = (
  access: unknown = {
    meters: {
      fiveHour: {
        resetsAt: "2026-08-12T12:00:00.000Z",
        limitMicroCents: "1000000000",
        usedMicroCents: "250000000",
      },
      week: {
        resetsAt: "2026-08-19T12:00:00.000Z",
        limitMicroCents: "2000000000",
        usedMicroCents: "800000000",
      },
      month: {
        resetsAt: "2026-09-01T00:00:00.000Z",
        limitMicroCents: "6000000000",
        usedMicroCents: "3000000000",
      },
    },
  },
) => ({ product: "go", access });

interface Request {
  url: string;
  authorization: string | null;
  orgID: string | null;
  redirect?: RequestRedirect;
}
/** Answers each URL and bearer token pair, recording what was asked. */
function upstream(answers: Record<string, () => Response>) {
  const requests: Request[] = [];
  const fetchApi = async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const authorization = headers.get("Authorization");
    requests.push({
      url: String(url),
      authorization,
      orgID: headers.get("x-org-id"),
      ...(init?.redirect ? { redirect: init.redirect } : {}),
    });
    const answer = answers[`${String(url)} ${authorization}`];
    return answer ? answer() : new Response(null, { status: 401 });
  };
  return { requests, fetchApi: fetchApi as typeof fetch };
}
async function storeWith(credentials: Credential[]) {
  await openCode2(credentials);
  await rm(authFile, { force: true });
  const [found] = await discover(install);
  return inputSchema.parse(found!.input);
}

test("reads Go from the Console sign-in OpenCode serves it with, ahead of the opencode-go key", async () => {
  const input = await storeWith([consoleSignIn(), goKey("go-key")]);
  const { requests, fetchApi } = upstream({
    [`${CONSOLE_STATUS_URL} Bearer console-token`]: () => Response.json(goStatus()),
  });
  const report = await fetchUsage(input, fetchApi, install);
  expect(requests).toEqual([
    {
      url: CONSOLE_STATUS_URL,
      authorization: "Bearer console-token",
      orgID: "org_TESTORG123",
      redirect: "error",
    },
  ]);
  expect(report.status === "available" && report.windows.map((w) => [w.id, w.usedPct])).toEqual([
    ["rolling", 25],
    ["weekly", 40],
    ["monthly", 50],
  ]);
});

test("discovers a Console sign-in on its own, including one saved for the retired host", async () => {
  const input = await storeWith([consoleSignIn({ server: "https://console.opencode.ai" })]);
  const { fetchApi } = upstream({
    [`${CONSOLE_STATUS_URL} Bearer console-token`]: () => Response.json(goStatus()),
  });
  expect((await fetchUsage(input, fetchApi, install)).status).toBe("available");
});

test.each([
  ["another product", { product: "zen", access: null }],
  ["an ended subscription", goStatus(null)],
])("falls back to the opencode-go key when the sign-in's workspace has %s", async (_, body) => {
  const input = await storeWith([consoleSignIn(), goKey("go-key")]);
  const { fetchApi } = upstream({
    [`${CONSOLE_STATUS_URL} Bearer console-token`]: () => Response.json(body),
    [`${USAGE_URL} Bearer go-key`]: () => Response.json(upstreamResponse),
  });
  const report = await fetchUsage(input, fetchApi, install);
  expect(report.status === "available" && report.windows.map((w) => w.usedPct)).toEqual([
    21, 42, 100,
  ]);
});

test("reports the absent subscription for a Console sign-in without Go", async () => {
  const input = await storeWith([consoleSignIn()]);
  const { fetchApi } = upstream({
    [`${CONSOLE_STATUS_URL} Bearer console-token`]: () => Response.json(goStatus(null)),
  });
  expect(await fetchUsage(input, fetchApi, install)).toEqual({
    status: "unavailable",
    problem: { kind: "no_quota", detail: "No active OpenCode Go subscription" },
  });
});

test("reports an expired sign-in without a request, and keeps it over a rejected fallback key", async () => {
  const expires = Date.now() - 1000;
  const alone = await storeWith([consoleSignIn({ expires })]);
  const { requests, fetchApi } = upstream({});
  const expired = {
    status: "unavailable",
    problem: {
      kind: "expired",
      expiresAt: new Date(expires).toISOString(),
      refreshedBy: "opencode",
    },
  };
  expect(await fetchUsage(alone, fetchApi, install)).toEqual(expired);
  expect(requests).toEqual([]);
  const withKey = await storeWith([consoleSignIn({ expires }), goKey("expired-go-key")]);
  expect(await fetchUsage(withKey, fetchApi, install)).toEqual(expired);
});

test("reads Go with a key on the opencode integration and falls back when its workspace lacks Go", async () => {
  const input = await storeWith([consoleKey("workspace-key"), goKey("go-key")]);
  const served = upstream({
    [`${CONSOLE_STATUS_URL} Bearer workspace-key`]: () => Response.json(goStatus()),
  });
  const report = await fetchUsage(input, served.fetchApi, install);
  expect(report.status).toBe("available");
  expect(served.requests.map((request) => [request.authorization, request.orgID])).toEqual([
    ["Bearer workspace-key", null],
  ]);
  const refused = upstream({
    [`${USAGE_URL} Bearer workspace-key`]: () => new Response(null, { status: 403 }),
    [`${USAGE_URL} Bearer go-key`]: () => Response.json(upstreamResponse),
  });
  expect((await fetchUsage(input, refused.fetchApi, install)).status).toBe("available");
  expect(refused.requests.at(-1)).toMatchObject({ url: USAGE_URL, authorization: "Bearer go-key" });
});

test("reports a key on the opencode integration without Go as the absent subscription", async () => {
  const input = await storeWith([consoleKey("zen-key")]);
  const { fetchApi } = upstream({
    [`${USAGE_URL} Bearer zen-key`]: () => new Response(null, { status: 403 }),
  });
  expect(await fetchUsage(input, fetchApi, install)).toEqual({
    status: "unavailable",
    problem: { kind: "no_quota", detail: "No active OpenCode Go subscription" },
  });
});

// The auth.json key stands in for a Go login that OpenCode 2 never imported.
test.each<[string, Credential, Record<string, () => Response>]>([
  [
    "key",
    consoleKey("workspace-key"),
    { [`${USAGE_URL} Bearer workspace-key`]: () => new Response(null, { status: 403 }) },
  ],
  [
    "sign-in",
    consoleSignIn(),
    { [`${CONSOLE_STATUS_URL} Bearer console-token`]: () => Response.json(goStatus(null)) },
  ],
])(
  "reads the auth.json Go key when the workspace of OpenCode 2's opencode %s has no Go",
  async (_name, login, refusal) => {
    await openCode2([login]);
    const [found] = await discover(install);
    const { requests, fetchApi } = upstream({
      ...refusal,
      [`${USAGE_URL} Bearer file-key`]: () => Response.json(upstreamResponse),
    });
    const report = await fetchUsage(inputSchema.parse(found!.input), fetchApi, install);
    expect(report.status).toBe("available");
    expect(requests.at(-1)).toMatchObject({ url: USAGE_URL, authorization: "Bearer file-key" });
  },
);

test("keeps the card on OpenCode 2's opencode key ahead of the auth.json Go key", async () => {
  await openCode2([consoleKey("workspace-key")]);
  const [found] = await discover(install);
  const input = inputSchema.parse(found!.input);
  const served = upstream({
    [`${CONSOLE_STATUS_URL} Bearer workspace-key`]: () => Response.json(goStatus()),
    [`${USAGE_URL} Bearer file-key`]: () => Response.json(upstreamResponse),
  });
  expect((await fetchUsage(input, served.fetchApi, install)).status).toBe("available");
  const failing = upstream({
    [`${USAGE_URL} Bearer workspace-key`]: () => new Response(null, { status: 503 }),
    [`${USAGE_URL} Bearer file-key`]: () => Response.json(upstreamResponse),
  });
  await expect(fetchUsage(input, failing.fetchApi, install)).rejects.toThrow("returned 503");
  const asked = [...served.requests, ...failing.requests].map((request) => request.authorization);
  expect(asked).not.toContain("Bearer file-key");
});

test("keeps the card on the opencode key through a temporary failure", async () => {
  const input = await storeWith([consoleKey("workspace-key"), goKey("go-key")]);
  const { requests, fetchApi } = upstream({
    [`${USAGE_URL} Bearer workspace-key`]: () => new Response(null, { status: 503 }),
  });
  await expect(fetchUsage(input, fetchApi, install)).rejects.toThrow("returned 503");
  expect(requests.some((request) => request.authorization === "Bearer go-key")).toBe(false);
});

test("keeps the card on the Console sign-in through a temporary failure", async () => {
  const input = await storeWith([consoleSignIn(), goKey("go-key")]);
  const { requests, fetchApi } = upstream({
    [`${CONSOLE_STATUS_URL} Bearer console-token`]: () => new Response(null, { status: 503 }),
    [`${USAGE_URL} Bearer go-key`]: () => Response.json(upstreamResponse),
  });
  await expect(fetchUsage(input, fetchApi, install)).rejects.toThrow("returned 503");
  expect(requests.some((request) => request.authorization === "Bearer go-key")).toBe(false);
});

test("reads a key's usage within the refresh deadline when the Console does not answer", async () => {
  const fetchApi = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === USAGE_URL) return Response.json(upstreamResponse);
    // The Console holds the request open until the caller gives up on it.
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });
  }) as typeof fetch;
  const started = Date.now();
  const report = await fetchUsage({ store: "file" }, fetchApi, install);
  expect(report.status).toBe("available");
  // The daemon gives a usage refresh 20 seconds, and the usage API keeps 15 of them.
  expect(Date.now() - started).toBeLessThan(5_000);
}, 20_000);
