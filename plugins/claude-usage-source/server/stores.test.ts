import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { discover, fetchUsage, identify } from "./usage.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "usage-stores-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});
function lookup(env: NodeJS.ProcessEnv = {}) {
  return { home, env, platform: "linux" as const, now: () => 1000 };
}
async function json(path: string, value: unknown) {
  const { dirname } = await import("node:path");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}
async function profile(_url: RequestInfo | URL, init?: RequestInit) {
  expect(new Headers(init?.headers).get("Authorization")).toMatch(/^Bearer fixture-/);
  return new Response(
    JSON.stringify({ account: { uuid: "pi-account" }, organization: { uuid: "pi-org" } }),
  );
}
async function account(input: Parameters<typeof fetchUsage>[0], env: NodeJS.ProcessEnv = {}) {
  return identify(input, profile, () => 1000, lookup(env));
}
async function database(path: string) {
  await mkdir((await import("node:path")).dirname(path), { recursive: true });
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY, provider TEXT, credential_type TEXT, data TEXT, disabled_cause TEXT)",
  );
  const insert = db.prepare("INSERT INTO auth_credentials VALUES (?, ?, ?, ?, ?)");
  insert.run(
    1,
    "anthropic",
    "oauth",
    JSON.stringify({ access: "fixture-omp", accountId: "omp-account", expires: 2000 }),
    null,
  );
  insert.run(
    2,
    "anthropic",
    "oauth",
    JSON.stringify({ access: "fixture-expired", expires: 500 }),
    null,
  );
  insert.run(
    3,
    "anthropic",
    "oauth",
    JSON.stringify({ access: "fixture-disabled", expires: 2000 }),
    "revoked",
  );
  insert.run(
    4,
    "anthropic",
    "api_key",
    JSON.stringify({ access: "fixture-key", expires: 2000 }),
    null,
  );
  insert.run(5, "anthropic", "oauth", "invalid", null);
  db.close();
}

test("Pi uses its own OAuth identity and re-reads rotated tokens without writing", async () => {
  const path = join(home, ".pi", "agent", "auth.json");
  await json(path, {
    anthropic: { type: "oauth", access: "fixture-first", accountId: "pi-account" },
  });
  await json(join(home, ".claude.json"), {
    oauthAccount: { accountUuid: "other", organizationUuid: "other-org" },
  });
  const inputs = await discover(lookup());
  expect(inputs).toHaveLength(1);
  expect(await account(inputs[0]!)).toEqual({ key: "pi-account.pi-org" });
  await json(path, {
    anthropic: { type: "oauth", access: "fixture-rotated", accountId: "pi-account" },
  });
  const before = await readFile(path, "utf8");
  expect(
    (
      await fetchUsage(
        inputs[0]!,
        async (_url, init) => {
          expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer fixture-rotated");
          return new Response("{}", { status: 401 });
        },
        lookup(),
      )
    ).status,
  ).toBe("unavailable");
  expect(await readFile(path, "utf8")).toBe(before);
});

test("Pi honors directory override and ignores API keys and malformed files", async () => {
  const directory = join(home, "custom-pi");
  const env = { PI_CODING_AGENT_DIR: directory };
  const path = join(directory, "auth.json");
  await json(path, { anthropic: { type: "oauth", access: "fixture-pi", accountId: "pi-account" } });
  expect(await discover(lookup(env))).toEqual([{ route: { store: "pi", path } }]);
  await json(path, { anthropic: { type: "api_key", key: "fixture-key" } });
  expect(await discover(lookup(env))).toEqual([]);
  await writeFile(path, "broken");
  expect(await discover(lookup(env))).toEqual([]);
});

test("expired Pi tokens are unavailable without calling usage or refreshing", async () => {
  await json(join(home, ".pi", "agent", "auth.json"), {
    anthropic: { type: "oauth", access: "fixture-expired", accountId: "pi-account", expires: 500 },
  });
  const [input] = await discover(lookup());
  expect(
    (
      await fetchUsage(
        input!,
        async () => {
          throw new Error("must not fetch expired token");
        },
        lookup(),
      )
    ).status,
  ).toBe("unavailable");
});

for (const location of ["default", "profile", "xdg", "override", "config"]) {
  test(`OMP discovers enabled live OAuth rows in ${location} store read-only`, async () => {
    let path = join(home, ".omp", "agent", "agent.db");
    let env: NodeJS.ProcessEnv = { OMP_AUTH_BROKER_URL: "https://broker.test" };
    if (location === "profile") {
      env.OMP_PROFILE = "work";
      path = join(home, ".omp", "profiles", "work", "agent", "agent.db");
    }
    if (location === "xdg") {
      env.XDG_DATA_HOME = join(home, "data");
      env.PI_PROFILE = "work";
      path = join(home, "data", "omp", "profiles", "work", "agent.db");
    }
    if (location === "override") {
      env.PI_CODING_AGENT_DIR = join(home, "custom");
      path = join(home, "custom", "agent.db");
    }
    if (location === "config") {
      env.PI_CONFIG_DIR = "custom-config";
      path = join(home, "custom-config", "agent", "agent.db");
    }
    await database(path);
    const before = await readFile(path);
    const inputs = await discover(lookup(env));
    expect(inputs).toEqual([{ route: { store: "omp", path, credentialId: 1 } }]);
    expect(await account(inputs[0]!, env)).toEqual({ key: "pi-account.pi-org" });
    expect(
      (
        await fetchUsage(
          inputs[0]!,
          async (_url, init) => {
            expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer fixture-omp");
            return new Response("{}", { status: 401 });
          },
          lookup(env),
        )
      ).status,
    ).toBe("unavailable");
    expect(await readFile(path)).toEqual(before);
  });
}

test("missing SQLite skips only OMP", async () => {
  await database(join(home, ".omp", "agent", "agent.db"));
  await json(join(home, ".pi", "agent", "auth.json"), {
    anthropic: { type: "oauth", access: "fixture-pi" },
  });
  const inputs = await discover({ ...lookup(), sqlite: () => undefined });
  expect(inputs).toEqual([
    { route: { store: "pi", path: join(home, ".pi", "agent", "auth.json") } },
  ]);
});

test("Claude file and keychain are independent discovery candidates", async () => {
  const path = join(home, ".claude", ".credentials.json");
  await json(path, { claudeAiOauth: { accessToken: "fixture-file" } });
  const inputs = await discover({
    ...lookup(),
    platform: "darwin",
    readKeychainCredentials: async () => ({ claudeAiOauth: { accessToken: "fixture-keychain" } }),
  });
  expect(inputs).toEqual([{ route: { store: "claude", path } }, { route: { store: "keychain" } }]);
});

test("Claude account metadata alone does not discover a login", async () => {
  await json(join(home, ".claude.json"), {
    oauthAccount: { accountUuid: "old", organizationUuid: "old-org" },
  });
  expect(await discover(lookup())).toEqual([]);
  expect(
    await identify(
      { route: { store: "claude", path: join(home, ".claude", ".credentials.json") } },
      profile,
      Date.now,
      lookup(),
    ),
  ).toBeNull();
});

test("keychain identity belongs to its token even when Claude Code metadata names another account", async () => {
  await json(join(home, ".claude.json"), {
    oauthAccount: { accountUuid: "stale", organizationUuid: "stale-org" },
  });
  const identity = await identify({ route: { store: "keychain" } }, profile, () => 1000, {
    ...lookup(),
    platform: "darwin",
    readKeychainCredentials: async () => ({
      claudeAiOauth: { accessToken: "fixture-keychain-other" },
    }),
  });
  expect(identity).toEqual({ key: "pi-account.pi-org" });
});

test("OMP fetch re-reads its row after rotation and skips a newly disabled login", async () => {
  const path = join(home, ".omp", "agent", "agent.db");
  await database(path);
  const [input] = await discover(lookup());
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path);
  db.prepare("UPDATE auth_credentials SET data = ? WHERE id = 1").run(
    JSON.stringify({ access: "fixture-rotated-omp", accountId: "omp-account", expires: 2000 }),
  );
  expect(
    (
      await fetchUsage(
        input!,
        async (_url, init) => {
          expect(new Headers(init?.headers).get("Authorization")).toBe(
            "Bearer fixture-rotated-omp",
          );
          return new Response("{}", { status: 401 });
        },
        lookup(),
      )
    ).status,
  ).toBe("unavailable");
  db.prepare("UPDATE auth_credentials SET disabled_cause = 'revoked' WHERE id = 1").run();
  db.close();
  expect(
    (
      await fetchUsage(
        input!,
        async () => {
          throw new Error("disabled login must not fetch");
        },
        lookup(),
      )
    ).status,
  ).toBe("unavailable");
});

test("Claude discovery honors CLAUDE_CONFIG_DIR", async () => {
  const directory = join(home, "configured-claude");
  const ignoredDirectory = join(home, "other-home");
  await json(join(directory, ".credentials.json"), {
    claudeAiOauth: { accessToken: "fixture-configured" },
  });
  await json(join(ignoredDirectory, ".credentials.json"), {
    claudeAiOauth: { accessToken: "fixture-other" },
  });
  const inputs = await discover(
    lookup({ CLAUDE_CONFIG_DIR: directory, CLAUDE_HOME: ignoredDirectory }),
  );
  expect(inputs).toEqual([
    { route: { store: "claude", path: join(directory, ".credentials.json") } },
  ]);
});
