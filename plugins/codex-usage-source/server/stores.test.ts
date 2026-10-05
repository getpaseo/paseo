import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { discover, fetchUsage } from "./usage.js";

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
async function accountIdentity(
  input: Parameters<typeof fetchUsage>[0],
  env: NodeJS.ProcessEnv = {},
) {
  const accounts = await discover({ kind: "global" }, lookup(env));
  const account = accounts.find(
    (candidate) => JSON.stringify(candidate.input) === JSON.stringify(input),
  );
  if (!account) throw new Error("Expected discovered login");
  return { key: account.key, ...(account.label ? { label: account.label } : {}) };
}
async function logins(options: Parameters<typeof discover>[1]) {
  return (await discover({ kind: "global" }, options)).map(
    (account) => account.input as Parameters<typeof fetchUsage>[0],
  );
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
    "openai-codex",
    "oauth",
    JSON.stringify({ access: "fixture-omp", accountId: "omp-account", expires: 2000 }),
    null,
  );
  insert.run(
    2,
    "openai-codex",
    "oauth",
    JSON.stringify({ access: "fixture-expired", expires: 500 }),
    null,
  );
  insert.run(
    3,
    "openai-codex",
    "oauth",
    JSON.stringify({ access: "fixture-disabled", expires: 2000 }),
    "revoked",
  );
  insert.run(
    4,
    "openai-codex",
    "api_key",
    JSON.stringify({ access: "fixture-key", expires: 2000 }),
    null,
  );
  insert.run(5, "openai-codex", "oauth", "invalid", null);
  db.close();
}

test("Pi uses its own OAuth identity and re-reads rotated tokens without writing", async () => {
  const path = join(home, ".pi", "agent", "auth.json");
  await json(path, {
    "openai-codex": { type: "oauth", access: "fixture-first", accountId: "pi-account" },
  });
  await json(join(home, ".claude.json"), {
    oauthAccount: { accountUuid: "other", organizationUuid: "other-org" },
  });
  const inputs = await logins(lookup());
  expect(inputs).toHaveLength(1);
  expect(await accountIdentity(inputs[0]!)).toEqual({ key: "pi-account" });
  await json(path, {
    "openai-codex": { type: "oauth", access: "fixture-rotated", accountId: "pi-account" },
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
  await json(path, {
    "openai-codex": { type: "oauth", access: "fixture-pi", accountId: "pi-account" },
  });
  expect(await logins(lookup(env))).toEqual([{ route: { store: "pi", path } }]);
  await json(path, { "openai-codex": { type: "api_key", key: "fixture-key" } });
  expect(await logins(lookup(env))).toEqual([]);
  await writeFile(path, "broken");
  expect(await logins(lookup(env))).toEqual([]);
});

test("expired Pi tokens are unavailable without calling usage or refreshing", async () => {
  await json(join(home, ".pi", "agent", "auth.json"), {
    "openai-codex": {
      type: "oauth",
      access: "fixture-expired",
      accountId: "pi-account",
      expires: 500,
    },
  });
  const [input] = await logins(lookup());
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
    const inputs = await logins(lookup(env));
    expect(inputs).toEqual([
      { route: { store: "omp", path, credentialId: 1 } },
      { route: { store: "omp", path, credentialId: 2 } },
    ]);
    expect(await accountIdentity(inputs[0]!, env)).toEqual({ key: "omp-account" });
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
    "openai-codex": { type: "oauth", access: "fixture-pi" },
  });
  const inputs = await logins({ ...lookup(), sqlite: () => undefined });
  expect(inputs).toEqual([
    { route: { store: "pi", path: join(home, ".pi", "agent", "auth.json") } },
  ]);
});

test("Codex and OpenCode discover accounts in preference order with XDG and CODEX_HOME", async () => {
  const codex = join(home, "codex");
  const data = join(home, "data");
  const env = { CODEX_HOME: codex, XDG_DATA_HOME: data };
  await json(join(codex, "auth.json"), {
    tokens: { access_token: "fixture-codex", account_id: "same" },
  });
  // Codex CLI never reads ~/.config/codex.
  await json(join(home, ".config", "codex", "auth.json"), {
    tokens: { access_token: "fixture-config", account_id: "same" },
  });
  await json(join(home, ".codex", "auth.json"), {
    tokens: { access_token: "fixture-legacy", account_id: "same" },
  });
  await json(join(data, "opencode", "auth.json"), {
    openai: { type: "oauth", access: "fixture-open", accountId: "same" },
  });
  const inputs = await logins(lookup(env));
  expect(inputs.map((input) => input.route.store)).toEqual(["codex", "codex", "opencode"]);
  for (const input of inputs) expect(await accountIdentity(input, env)).toEqual({ key: "same" });
  await json(join(data, "opencode", "auth.json"), { openai: { type: "api", key: "fixture-key" } });
  expect(await logins(lookup(env))).toHaveLength(2);
});

test("OMP fetch re-reads its row after rotation and skips a newly disabled login", async () => {
  const path = join(home, ".omp", "agent", "agent.db");
  await database(path);
  const [input] = await logins(lookup());
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
  await expect(
    fetchUsage(
      input!,
      async () => {
        throw new Error("must not fetch");
      },
      lookup(),
    ),
  ).rejects.toThrow("login store no longer exists");
});
