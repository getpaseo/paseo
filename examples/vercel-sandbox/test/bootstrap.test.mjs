import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { bootstrapScript, PASEO_CLI_VERSION, AGENT_CLI_PINS } = await import("../dist/bootstrap.js");
const { providerConfigScript } = await import("../dist/providers.js");

const state = {
  id: "test",
  name: "test",
  createdAt: "",
  updatedAt: "",
  phase: "intent",
  sandboxName: "paseo-sandbox-test",
  region: "iad1",
  image: "vercel/sandbox/node:24",
  teamId: "team_x",
  projectId: "prj_x",
  owner: "owner",
  paseoHome: "/vercel/paseo-home",
  workspacePath: "/vercel/workspace",
  repoPath: "/vercel/workspace/repo",
  agentProvider: "codex",
  agentModel: "openai/gpt-6-astra",
  sessionIds: [],
  snapshotIds: [],
  logs: [],
};

test("bootstrap script installs every exact pinned CLI", () => {
  const script = bootstrapScript(state);
  assert.ok(script.includes(`@getpaseo/cli@${PASEO_CLI_VERSION}`));
  for (const pin of AGENT_CLI_PINS) {
    assert.ok(script.includes(`${pin.package}@${pin.version}`), `${pin.package}@${pin.version}`);
  }
});

test("bootstrap and config sources never embed the gateway key", () => {
  const key = "bootstrap-source-secret";
  process.env.AI_GATEWAY_API_KEY = key;
  try {
    assert.ok(!bootstrapScript(state).includes(key));
    assert.ok(!providerConfigScript(state).includes(key));
  } finally {
    delete process.env.AI_GATEWAY_API_KEY;
  }
});

function makeSimulation() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "paseo-bootstrap-")));
  const home = join(root, "home");
  const bin = join(root, "bin");
  for (const directory of [
    join(home, ".claude"),
    join(home, ".config", "opencode"),
    join(home, ".local", "share", "opencode"),
    join(home, ".pi", "agent"),
    join(home, ".codex"),
    bin,
  ])
    mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({ theme: "dark", env: { KEEP: "yes" } }),
  );
  writeFileSync(
    join(home, ".config", "opencode", "opencode.json"),
    JSON.stringify({ theme: "dark", provider: { other: { enabled: true } } }),
  );
  writeFileSync(
    join(home, ".local", "share", "opencode", "auth.json"),
    JSON.stringify({ unrelated: { type: "api", key: "unrelated" } }),
    { mode: 0o600 },
  );
  writeFileSync(
    join(home, ".pi", "agent", "auth.json"),
    JSON.stringify({ unrelated: { type: "api_key", key: "unrelated" } }),
    { mode: 0o600 },
  );
  writeFileSync(
    join(home, ".codex", "config.toml"),
    [
      'approval_policy = "on-request"',
      "writable_roots = [",
      '  "/preserve-root",',
      "]",
      "[other]",
      "value = 1",
      "[[tools.preserved]]",
      'name = "preserve-tool"',
      "",
    ].join("\n"),
  );
  const stub = `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const name=path.basename(process.argv[1]);
if(name==='npm'&&process.argv.includes('install')){for(const a of process.argv.slice(2)){if(a.startsWith('-'))continue;const m=a.match(/^(.+)@([0-9].*)$/);if(m)fs.mkdirSync(path.join(process.env.HOME,'.npm-global/lib/node_modules',m[1]),{recursive:true});}}
if(process.argv.includes('--version'))console.log(name+' test-version');
`;
  for (const name of ["npm", "paseo", "codex", "claude", "opencode", "pi", "copilot"]) {
    writeFileSync(join(bin, name), stub, { mode: 0o755 });
  }
  return { home, bin };
}

function runBootstrap(home, bin, key) {
  const script = bootstrapScript(state)
    .replaceAll("/vercel/paseo-home", join(home, "paseo-home"))
    .replaceAll("/vercel/workspace/repo", join(home, "workspace", "repo"))
    .replaceAll("/vercel/workspace", join(home, "workspace"));
  writeFileSync(join(home, "bootstrap.sh"), script, { mode: 0o755 });
  writeFileSync(
    join(home, "configure-providers.js"),
    providerConfigScript({ ...state, paseoHome: join(home, "paseo-home") }),
    { mode: 0o755 },
  );
  return spawnSync("bash", [join(home, "bootstrap.sh")], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      PATH: `${bin}:${process.env.PATH}`,
      AI_GATEWAY_API_KEY: key,
    },
  });
}

test("bootstrap configures and merges all providers across retries", () => {
  const { home, bin } = makeSimulation();
  const key = "first-dummy-key";
  let result = runBootstrap(home, bin, key);
  assert.equal(result.status, 0, result.stderr);
  result = runBootstrap(home, bin, "rotated-dummy-key");
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.stdout.includes("rotated-dummy-key"));
  assert.ok(!result.stderr.includes("rotated-dummy-key"));

  const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
  const claude = readJson(join(home, ".claude", "settings.json"));
  assert.equal(claude.theme, "dark");
  assert.equal(claude.env.KEEP, "yes");
  assert.equal(claude.model, "anthropic/claude-sonnet-5");
  assert.equal(claude.env.ANTHROPIC_API_KEY, "");
  assert.equal(claude.env.ANTHROPIC_MODEL, "anthropic/claude-sonnet-5");
  assert.equal(claude.env.ANTHROPIC_DEFAULT_SONNET_MODEL, "anthropic/claude-sonnet-5");

  const openCodeConfig = readJson(join(home, ".config", "opencode", "opencode.json"));
  assert.equal(openCodeConfig.theme, "dark");
  assert.equal(openCodeConfig.provider.other.enabled, true);
  assert.equal(openCodeConfig.provider.vercel.disabled, false);
  const openCodeAuth = readJson(join(home, ".local", "share", "opencode", "auth.json"));
  assert.equal(openCodeAuth.unrelated.key, "unrelated");
  assert.deepEqual(openCodeAuth.vercel, { type: "api", key: "rotated-dummy-key" });
  const piAuth = readJson(join(home, ".pi", "agent", "auth.json"));
  assert.equal(piAuth.unrelated.key, "unrelated");
  assert.deepEqual(piAuth["vercel-ai-gateway"], { type: "api_key", key: "rotated-dummy-key" });
  const codex = readFileSync(join(home, ".codex", "config.toml"), "utf8");
  assert.match(codex, /approval_policy = "on-request"/);
  assert.match(codex, /writable_roots = \[/);
  assert.match(codex, /\/preserve-root/);
  assert.match(codex, /\[\[tools\.preserved\]\]/);
  assert.match(codex, /preserve-tool/);
  assert.match(codex, /\[other\]\nvalue = 1/);
  assert.match(codex, /base_url = "https:\/\/ai-gateway\.vercel\.sh\/codex\/v1"/);
  assert.match(codex, /wire_api = "responses"/);

  for (const path of [
    join(home, ".claude", "settings.json"),
    join(home, ".config", "opencode", "opencode.json"),
    join(home, ".local", "share", "opencode", "auth.json"),
    join(home, ".pi", "agent", "auth.json"),
    join(home, ".codex", "config.toml"),
  ]) {
    assert.equal(statSync(path).mode & 0o077, 0, path);
  }
});

test("malformed configuration fails without being overwritten", () => {
  const { home, bin } = makeSimulation();
  writeFileSync(join(home, ".claude", "settings.json"), "{broken");
  const before = readFileSync(join(home, ".claude", "settings.json"), "utf8");
  const result = runBootstrap(home, bin, "dummy");
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(join(home, ".claude", "settings.json"), "utf8"), before);
});

test("malformed Codex TOML fails without rewriting any provider file", () => {
  const { home, bin } = makeSimulation();
  const codexPath = join(home, ".codex", "config.toml");
  const claudePath = join(home, ".claude", "settings.json");
  const malformed = "this is not toml\n";
  writeFileSync(codexPath, malformed);
  const result = runBootstrap(home, bin, "never-written-key");
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(codexPath, "utf8"), malformed);
  assert.equal(
    readFileSync(claudePath, "utf8"),
    JSON.stringify({ theme: "dark", env: { KEEP: "yes" } }),
  );
  assert.ok(
    !readFileSync(join(home, ".local", "share", "opencode", "auth.json"), "utf8").includes(
      "never-written-key",
    ),
  );
});

test("missing gateway key is actionable", () => {
  const { home } = makeSimulation();
  writeFileSync(
    join(home, "configure-providers.js"),
    providerConfigScript({ ...state, paseoHome: join(home, "paseo-home") }),
    { mode: 0o755 },
  );
  const result = spawnSync("node", [join(home, "configure-providers.js")], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, AI_GATEWAY_API_KEY: "" },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /AI_GATEWAY_API_KEY is required/);
});
