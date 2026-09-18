import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  realpathSync,
  existsSync,
  readdirSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  PROVIDERS,
  resolveProvider,
  validateProviderSelection,
  providerLaunchEnvironment,
  providerConfigScript,
  redactDiagnostic,
} = await import("../dist/providers.js");

test("provider catalog contains exact pins and defaults", () => {
  assert.deepEqual(Object.keys(PROVIDERS), ["codex", "claude", "opencode", "pi", "copilot"]);
  assert.equal(PROVIDERS.codex.version, "0.154.0");
  assert.equal(PROVIDERS.claude.version, "2.1.273");
  assert.equal(PROVIDERS.opencode.version, "1.18.31");
  assert.equal(PROVIDERS.pi.version, "0.85.1");
  assert.equal(PROVIDERS.copilot.version, "1.0.83");
  assert.equal(PROVIDERS.codex.defaultModel, "openai/gpt-6-astra");
  assert.equal(PROVIDERS.claude.defaultModel, "anthropic/claude-sonnet-5");
});

test("unknown providers and invalid models are rejected clearly", () => {
  assert.throws(
    () => resolveProvider("unknown"),
    /unsupported agent provider 'unknown'.*codex, claude, opencode, pi, copilot/,
  );
  assert.throws(
    () => validateProviderSelection("claude", "claude-sonnet-5"),
    /slash-qualified Gateway model ID/,
  );
});

test("daemon launch environment includes all provider credentials safely", () => {
  const key = "launch-secret";
  const env = providerLaunchEnvironment(key, "openai/gpt-6-astra");
  assert.equal(env.AI_GATEWAY_API_KEY, key);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, key);
  assert.equal(env.ANTHROPIC_API_KEY, "");
  assert.equal(env.ANTHROPIC_BASE_URL, "https://ai-gateway.vercel.sh/claude-code");
  assert.equal(env.COPILOT_PROVIDER_API_KEY, key);
  assert.equal(env.COPILOT_PROVIDER_BASE_URL, "https://ai-gateway.vercel.sh/coding-agent/v1");
  assert.equal(env.COPILOT_MODEL, "openai/gpt-6-astra");
});

test("diagnostic redaction removes known and structured secrets", () => {
  const key = "redaction-secret";
  const result = redactDiagnostic(
    { apiKey: key, nested: { auth_token: key, text: `Bearer ${key}` } },
    key,
  );
  assert.deepEqual(result, {
    apiKey: "[REDACTED]",
    nested: { auth_token: "[REDACTED]", text: "Bearer [REDACTED]" },
  });
});

test("provider configuration honors safe directory overrides and writes owner-only secrets", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "paseo-provider-config-")));
  const script = join(home, "configure-providers.js");
  const state = {
    agentProvider: "codex",
    agentModel: "openai/gpt-6-astra",
    paseoHome: join(home, "paseo"),
  };
  writeFileSync(script, providerConfigScript(state), { mode: 0o755 });
  const directories = {
    CLAUDE_CONFIG_DIR: join(home, "custom-claude"),
    XDG_DATA_HOME: join(home, "custom-data"),
    OPENCODE_CONFIG_DIR: join(home, "custom-config"),
    PI_CODING_AGENT_DIR: join(home, "custom-pi"),
  };
  for (const directory of Object.values(directories))
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      "require('node:os').homedir = () => process.argv[1]; require(process.argv[2]);",
      home,
      script,
    ],
    {
      encoding: "utf8",
      env: { PATH: process.env.PATH, ...directories, AI_GATEWAY_API_KEY: "path-dummy-key" },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.ok(
    readFileSync(join(directories.XDG_DATA_HOME, "opencode", "auth.json"), "utf8").includes(
      "path-dummy-key",
    ),
  );
  assert.equal(
    JSON.parse(readFileSync(join(directories.PI_CODING_AGENT_DIR, "auth.json"), "utf8"))[
      "vercel-ai-gateway"
    ].key,
    "path-dummy-key",
  );
  assert.equal(statSync(join(directories.XDG_DATA_HOME, "opencode", "auth.json")).mode & 0o077, 0);
  assert.equal(statSync(join(directories.PI_CODING_AGENT_DIR, "auth.json")).mode & 0o077, 0);
  assert.ok(
    readFileSync(join(directories.CLAUDE_CONFIG_DIR, "settings.json"), "utf8").includes(
      "anthropic/claude-sonnet-5",
    ),
  );
  assert.ok(
    readFileSync(join(directories.OPENCODE_CONFIG_DIR, "opencode.json"), "utf8").includes(
      '"vercel"',
    ),
  );
});

test("OpenCode auth-content override is rejected before writing credentials", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "paseo-provider-conflict-")));
  const script = join(home, "configure-providers.js");
  writeFileSync(
    script,
    providerConfigScript({
      agentProvider: "opencode",
      agentModel: "anthropic/claude-sonnet-5",
      paseoHome: join(home, "paseo"),
    }),
    { mode: 0o755 },
  );
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      "require('node:os').homedir = () => process.argv[1]; require(process.argv[2]);",
      home,
      script,
    ],
    {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        OPENCODE_AUTH_CONTENT: '{"vercel":{"type":"api","key":"opencode-secret"}}',
        AI_GATEWAY_API_KEY: "unused",
      },
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /OPENCODE_AUTH_CONTENT conflicts/);
  assert.ok(!readFileSync(script, "utf8").includes("opencode-secret"));
});

function executeConfig(home, state, setup = "") {
  const script = join(home, "configure-providers.cjs");
  writeFileSync(script, providerConfigScript({ paseoHome: join(home, "paseo"), ...state }));
  return spawnSync(
    process.execPath,
    [
      "-e",
      `require('node:os').homedir = () => process.argv[1]; ${setup}; require(process.argv[2]);`,
      home,
      script,
    ],
    {
      encoding: "utf8",
      env: { PATH: process.env.PATH, AI_GATEWAY_API_KEY: "dummy-config-secret" },
    },
  );
}

test("fresh missing Codex config writes the complete Gateway provider on first run", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "paseo-fresh-codex-")));
  const result = executeConfig(home, { agentProvider: "codex", agentModel: "openai/gpt-6-astra" });
  assert.equal(result.status, 0, result.stderr);
  const daemon = JSON.parse(readFileSync(join(home, "paseo", "config.json"), "utf8"));
  assert.deepEqual(daemon.daemon, {
    listen: "127.0.0.1:6767",
    cors: { allowedOrigins: ["https://app.paseo.sh"] },
    relay: { enabled: false },
  });
  assert.deepEqual(daemon.app, { baseUrl: "https://app.paseo.sh" });
  const config = readFileSync(join(home, ".codex", "config.toml"), "utf8");
  for (const line of [
    'model_provider = "vercel"',
    'model = "openai/gpt-6-astra"',
    "[model_providers.vercel]",
    'base_url = "https://ai-gateway.vercel.sh/codex/v1"',
    'env_key = "AI_GATEWAY_API_KEY"',
    'wire_api = "responses"',
  ])
    assert.ok(config.includes(line), line);
});

function temporaryHome() {
  return realpathSync(mkdtempSync(join(tmpdir(), "paseo-daemon-config-")));
}
function writeDaemonConfig(home, config) {
  mkdirSync(join(home, "paseo"), { mode: 0o700 });
  writeFileSync(
    join(home, "paseo", "config.json"),
    typeof config === "string" ? config : JSON.stringify(config),
    { mode: 0o600 },
  );
}
const readDaemonConfig = (home) =>
  JSON.parse(readFileSync(join(home, "paseo", "config.json"), "utf8"));

for (const primary of Object.keys(PROVIDERS)) {
  test(`daemon catalog selects only ${primary}'s configured model and preserves unrelated config`, () => {
    const home = temporaryHome();
    const selected = "custom/explicit-model";
    const original = {
      version: 1,
      daemon: { listen: "127.0.0.1:6767", relay: { enabled: true } },
      agents: {
        catalogRefreshTimeoutMs: 10000,
        providers: {
          claude: { enabled: false },
          copilot: {
            label: "My Copilot",
            env: { KEEP: "preserved", COPILOT_MODEL: "old/model" },
            models: [{ id: "old/model", label: "Old" }],
          },
          codex: {
            env: { KEEP_CODEX: "yes" },
            additionalModels: [{ id: "other/model", label: "Keep", description: "unchanged" }],
          },
        },
      },
    };
    writeDaemonConfig(home, original);
    const result = executeConfig(home, { agentProvider: primary, agentModel: selected });
    assert.equal(result.status, 0, result.stderr);
    const merged = readDaemonConfig(home);
    const copilotModel = primary === "copilot" ? selected : PROVIDERS.copilot.defaultModel;
    const codexModel = primary === "codex" ? selected : PROVIDERS.codex.defaultModel;
    assert.deepEqual(merged.daemon, original.daemon);
    assert.equal(merged.agents.catalogRefreshTimeoutMs, 10000);
    assert.deepEqual(merged.agents.providers.claude, original.agents.providers.claude);
    assert.deepEqual(merged.agents.providers.copilot.env, {
      KEEP: "preserved",
      COPILOT_MODEL: copilotModel,
    });
    assert.deepEqual(merged.agents.providers.copilot.models, [
      { id: copilotModel, label: "Gateway", isDefault: true },
    ]);
    assert.equal(merged.agents.providers.copilot.label, "My Copilot");
    assert.deepEqual(merged.agents.providers.codex.additionalModels, [
      ...original.agents.providers.codex.additionalModels,
      { id: codexModel, label: "Gateway" },
    ]);
    assert.deepEqual(merged.agents.providers.codex.env, original.agents.providers.codex.env);
    assert.equal(Object.hasOwn(merged.agents.providers.codex, "models"), false);
    assert.equal(JSON.stringify(merged).includes("dummy-config-secret"), false);
    const before = readFileSync(join(home, "paseo", "config.json"), "utf8");
    assert.equal(executeConfig(home, { agentProvider: primary, agentModel: selected }).status, 0);
    assert.equal(readFileSync(join(home, "paseo", "config.json"), "utf8"), before);
  });
}

test("Codex exact-ID upsert retains existing catalog metadata without duplicates", () => {
  const home = temporaryHome();
  const model = {
    id: PROVIDERS.codex.defaultModel,
    label: "Custom label",
    description: "Keep",
    isDefault: true,
  };
  writeDaemonConfig(home, { agents: { providers: { codex: { additionalModels: [model] } } } });
  assert.equal(
    executeConfig(home, { agentProvider: "pi", agentModel: PROVIDERS.pi.defaultModel }).status,
    0,
  );
  assert.deepEqual(readDaemonConfig(home).agents.providers.codex.additionalModels, [model]);
});

for (const [label, config] of [
  ["malformed JSON", "{"],
  ["root array", []],
  ["null agents", { agents: null }],
  ["provider map array", { agents: { providers: [] } }],
  ["invalid provider", { agents: { providers: { copilot: [] } } }],
  ["invalid env", { agents: { providers: { copilot: { env: { COPILOT_MODEL: 1 } } } } }],
  ["invalid models", { agents: { providers: { copilot: { models: {} } } } }],
  [
    "invalid model label",
    { agents: { providers: { codex: { additionalModels: [{ id: "x" }] } } } },
  ],
  [
    "invalid model default",
    {
      agents: {
        providers: { codex: { additionalModels: [{ id: "x", label: "X", isDefault: "yes" }] } },
      },
    },
  ],
]) {
  test(`${label} refuses before provider file writes`, () => {
    const home = temporaryHome();
    writeDaemonConfig(home, config);
    const before = readFileSync(join(home, "paseo", "config.json"));
    assert.notEqual(
      executeConfig(home, { agentProvider: "codex", agentModel: PROVIDERS.codex.defaultModel })
        .status,
      0,
    );
    assert.deepEqual(readFileSync(join(home, "paseo", "config.json")), before);
    assert.equal(existsSync(join(home, ".claude", "settings.json")), false);
    assert.equal(existsSync(join(home, ".local", "share", "opencode", "auth.json")), false);
  });
}

for (const target of [
  "paseo",
  "paseo/config.json",
  ".codex/config.toml",
  "paseo/provider-config-receipts",
]) {
  test(`rejects symlink ${target} before writes, including dangling links`, () => {
    const home = temporaryHome();
    const file = join(home, target);
    mkdirSync(join(file, ".."), { recursive: true });
    symlinkSync(join(home, "missing-target"), file);
    const result = executeConfig(home, {
      agentProvider: "codex",
      agentModel: PROVIDERS.codex.defaultModel,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /configuration path is not a (directory|regular file)/);
    assert.equal(existsSync(join(home, ".claude", "settings.json")), false);
    assert.equal(existsSync(join(home, "missing-target")), false);
  });
}

test("CAS refuses an intervening edit without replacing other provider files", () => {
  const home = temporaryHome();
  writeDaemonConfig(home, {});
  const target = join(home, "paseo", "config.json");
  const setup = `const fs = require('node:fs'); const open = fs.openSync; let changed = false;
    fs.openSync = function(file, ...args) {
      if (!changed && file === ${JSON.stringify(target + ".edit-lock")}) {
        changed = true; fs.writeFileSync(${JSON.stringify(target)}, '{"version":1}');
      }
      return open.call(this, file, ...args);
    }`;
  const result = executeConfig(
    home,
    { agentProvider: "codex", agentModel: PROVIDERS.codex.defaultModel },
    setup,
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /STALE_PRECONDITION/);
  assert.equal(readFileSync(target, "utf8"), '{"version":1}');
  assert.equal(existsSync(join(home, ".claude", "settings.json")), false);
  assert.equal(existsSync(target + ".edit-lock"), false);
});

test("existing edit lock is preserved and prevents all writes", () => {
  const home = temporaryHome();
  writeDaemonConfig(home, {});
  const lock = join(home, "paseo", "config.json.edit-lock");
  writeFileSync(lock, "other-writer");
  const result = executeConfig(home, {
    agentProvider: "copilot",
    agentModel: PROVIDERS.copilot.defaultModel,
  });
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(lock, "utf8"), "other-writer");
  assert.equal(existsSync(join(home, ".claude", "settings.json")), false);
});

test("all config files and hash-only change receipts are owner-only", async () => {
  const { createHash } = await import("node:crypto");
  const home = temporaryHome();
  assert.equal(
    executeConfig(home, { agentProvider: "codex", agentModel: PROVIDERS.codex.defaultModel })
      .status,
    0,
  );
  const directory = join(home, "paseo", "provider-config-receipts");
  const files = readdirSync(directory);
  assert.equal(files.length, 6);
  for (const name of files) {
    const text = readFileSync(join(directory, name), "utf8");
    const receipt = JSON.parse(text);
    assert.equal(statSync(join(directory, name)).mode & 0o777, 0o600);
    assert.equal(statSync(receipt.target).mode & 0o777, 0o600);
    assert.equal(receipt.pre_edit_sha256, "MISSING");
    assert.equal(
      receipt.post_edit_sha256,
      createHash("sha256").update(readFileSync(receipt.target)).digest("hex"),
    );
    assert.equal(receipt.result, "WRITE_COMMITTED");
    assert.equal(text.includes("dummy-config-secret"), false);
  }
});
