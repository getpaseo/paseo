import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, expect, test } from "vitest";
import { resolveOmpUsageReference } from "./usage-reference.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): { run(...args: unknown[]): void };
    close(): void;
  };
};
// Upstream: packages/ai/src/auth/sqlite-credential-store.ts:576-581,711-724.
const OMP_AUTH_SCHEMA = `
  CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL);
  CREATE INDEX idx_cache_expires ON cache(expires_at);
  CREATE TABLE auth_credentials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    credential_type TEXT NOT NULL,
    data TEXT NOT NULL,
    disabled_cause TEXT DEFAULT NULL,
    identity_key TEXT DEFAULT NULL,
    created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
    updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
  );
`;
const dirs: string[] = [];
const future = Date.now() + 3_600_000;
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "omp-usage-"));
  dirs.push(home);
  const agentDir = join(home, "agent");
  mkdirSync(agentDir);
  const dbFile = join(agentDir, "agent.db");
  const db = new DatabaseSync(dbFile);
  db.exec(OMP_AUTH_SCHEMA);
  const env = { OMP_PROFILE: "", PI_CODING_AGENT_DIR: agentDir, XDG_DATA_HOME: "" };
  const row = (
    id: number,
    provider = "openai-codex",
    options: { disabled?: boolean; expires?: number; type?: string } = {},
  ) =>
    db
      .prepare(
        "INSERT INTO auth_credentials (id, provider, credential_type, data, disabled_cause) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        id,
        provider,
        options.type ?? "oauth",
        JSON.stringify({
          access: `fixture-token-${id}`,
          expires: options.expires ?? future,
          accountId: `account-${id}`,
        }),
        options.disabled ? "disabled" : null,
      );
  const sticky = (id: number, expires = Math.floor(Date.now() / 1000) + 100) =>
    db
      .prepare("INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?)")
      .run(
        "session:sticky:openai-codex:session-1",
        JSON.stringify({ type: "oauth", index: 0, credentialId: id }),
        expires,
      );
  const read = (override = {}) =>
    resolveOmpUsageReference("session-1", "openai-codex", { ...env, ...override });
  return { db, dbFile, agentDir, row, sticky, read };
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
test("sticky id selects the right OAuth row and leaves SQLite byte-identical", () => {
  const f = fixture();
  f.row(1);
  f.row(2);
  f.sticky(2);
  f.db.close();
  const before = readFileSync(f.dbFile);
  expect(f.read()).toEqual({
    source: "codex",
    input: { accessToken: "fixture-token-2", accountId: "account-2" },
  });
  expect(f.read()).toEqual({
    source: "codex",
    input: { accessToken: "fixture-token-2", accountId: "account-2" },
  });
  expect(readFileSync(f.dbFile)).toEqual(before);
});
test("single OAuth row resolves without sticky", () => {
  const f = fixture();
  f.row(1);
  f.db.close();
  expect(f.read()).toEqual({
    source: "codex",
    input: { accessToken: "fixture-token-1", accountId: "account-1" },
  });
});
test("multiple rows without sticky are ambiguous", () => {
  const f = fixture();
  f.row(1);
  f.row(2);
  f.db.close();
  expect(f.read()).toBeNull();
});
test("fallback counts only valid OAuth rows", () => {
  const f = fixture();
  f.row(1);
  f.row(2, "openai-codex", { expires: Date.now() - 1 });
  f.row(3, "openai-codex", { disabled: true });
  f.db
    .prepare(
      "INSERT INTO auth_credentials (id, provider, credential_type, data, disabled_cause) VALUES (?, ?, ?, ?, ?)",
    )
    .run(4, "openai-codex", "oauth", "invalid-json", null);
  f.db.close();
  expect(f.read()).toEqual({
    source: "codex",
    input: { accessToken: "fixture-token-1", accountId: "account-1" },
  });
});
test("disabled and expired rows do not resolve", () => {
  const a = fixture();
  a.row(1, "openai-codex", { disabled: true });
  a.sticky(1);
  a.db.close();
  expect(a.read()).toBeNull();
  const b = fixture();
  b.row(1, "openai-codex", { expires: Date.now() - 1 });
  b.db.close();
  expect(b.read()).toBeNull();
});
test("expired sticky falls back to a single row", () => {
  const f = fixture();
  f.row(1);
  f.sticky(1, 1);
  f.db.close();
  expect(f.read()?.source).toBe("codex");
});
test("env key does not displace OAuth with or without sticky", () => {
  const f = fixture();
  f.row(1);
  f.db.close();
  expect(f.read({ OPENAI_CODEX_OAUTH_TOKEN: "fixture-key" })?.source).toBe("codex");
  const g = fixture();
  g.row(1);
  g.sticky(1);
  g.db.close();
  expect(g.read({ OPENAI_CODEX_OAUTH_TOKEN: "fixture-key" })?.source).toBe("codex");
});
test("broker environment and config URLs block attribution", () => {
  const f = fixture();
  f.row(1);
  f.db.close();
  expect(f.read({ OMP_AUTH_BROKER_URL: "https://broker.invalid" })).toBeNull();
  writeFileSync(
    join(f.agentDir, "config.yml"),
    "auth:\n  broker:\n    url: https://broker.invalid\n",
  );
  expect(f.read()).toBeNull();
});
test("broker config.yaml and flat keys block attribution with config.yml precedence", () => {
  const f = fixture();
  f.row(1);
  f.db.close();
  writeFileSync(join(f.agentDir, "config.yaml"), '"auth.broker.url": https://broker.invalid\n');
  expect(f.read()).toBeNull();
  writeFileSync(join(f.agentDir, "config.yml"), "auth:\n  broker: {}\n");
  expect(f.read()).toEqual({
    source: "codex",
    input: { accessToken: "fixture-token-1", accountId: "account-1" },
  });
  writeFileSync(join(f.agentDir, "config.yml"), '"auth.broker.url": https://broker.invalid\n');
  expect(f.read()).toBeNull();
});
test("models config API key overrides sticky OAuth", () => {
  const f = fixture();
  f.row(1);
  f.sticky(1);
  f.db.close();
  writeFileSync(
    join(f.agentDir, "models.yml"),
    "providers:\n  openai-codex:\n    apiKey: fixture-key\n",
  );
  expect(f.read()).toBeNull();
});
test("provider mismatch and malformed sticky fail closed", () => {
  const f = fixture();
  f.row(1, "anthropic");
  f.sticky(1);
  f.db.close();
  expect(f.read()).toBeNull();
});

test("Anthropic OAuth maps to Claude and changes are read on each request", () => {
  const f = fixture();
  f.row(1, "anthropic");
  f.db.close();
  expect(
    resolveOmpUsageReference("session-1", "anthropic", {
      OMP_PROFILE: "",
      PI_CODING_AGENT_DIR: f.agentDir,
    }),
  ).toEqual({
    source: "claude",
    input: { accessToken: "fixture-token-1" },
  });
  writeFileSync(
    join(f.agentDir, "config.yml"),
    "auth:\n  broker:\n    url: https://broker.invalid\n",
  );
  expect(
    resolveOmpUsageReference("session-1", "anthropic", {
      OMP_PROFILE: "",
      PI_CODING_AGENT_DIR: f.agentDir,
    }),
  ).toBeNull();
});

test("named profile ignores agent override and uses existing XDG profile data", () => {
  const f = fixture();
  f.db.close();
  const root = mkdtempSync(join(tmpdir(), "omp-profile-"));
  dirs.push(root);
  const data = join(root, "xdg", "omp", "profiles", "work");
  mkdirSync(data, { recursive: true });
  const profileDb = new DatabaseSync(join(data, "agent.db"));
  profileDb.exec(OMP_AUTH_SCHEMA);
  profileDb
    .prepare(
      "INSERT INTO auth_credentials (id, provider, credential_type, data, disabled_cause) VALUES (?, ?, ?, ?, ?)",
    )
    .run(
      1,
      "openai-codex",
      "oauth",
      JSON.stringify({ access: "profile-token", expires: future }),
      null,
    );
  profileDb.close();
  expect(
    resolveOmpUsageReference(
      "session-1",
      "openai-codex",
      {
        OMP_PROFILE: "work",
        PI_PROFILE: "other",
        PI_CODING_AGENT_DIR: f.agentDir,
        PI_CONFIG_DIR: join(root, "config"),
        XDG_DATA_HOME: join(root, "xdg"),
      },
      "linux",
    ),
  ).toEqual({ source: "codex", input: { accessToken: "profile-token" } });
});

test("missing database returns null without creating a file", () => {
  const home = mkdtempSync(join(tmpdir(), "omp-missing-db-"));
  dirs.push(home);
  const agentDir = join(home, "agent");
  mkdirSync(agentDir);
  expect(
    resolveOmpUsageReference("session-1", "openai-codex", {
      OMP_PROFILE: "",
      PI_CODING_AGENT_DIR: agentDir,
      XDG_DATA_HOME: "",
    }),
  ).toBeNull();
  expect(existsSync(join(agentDir, "agent.db"))).toBe(false);
});

test("missing cache or credentials table returns null", () => {
  const first = fixture();
  first.db.exec("DROP TABLE cache");
  first.db.close();
  expect(first.read()).toBeNull();
  const second = fixture();
  second.db.exec("DROP TABLE auth_credentials");
  second.db.close();
  expect(second.read()).toBeNull();
});
