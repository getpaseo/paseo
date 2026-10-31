#!/usr/bin/env node
/**
 * zcode-setup.js — one-shot setup, probe and billing configuration for the
 * Paseo ZCode provider.
 *
 * Zero dependencies: plain Node.js (>= 20), no imports from this repository,
 * so it runs on any machine that has this checkout (or even just this file).
 *
 * Subcommands:
 *   doctor                              Detect the ZCode CLI and print health info.
 *   probe                               Launch `zcode app-server --stdio`, create a
 *                                       scratch session and print every model the
 *                                       registry exposes (this is exactly what the
 *                                       Paseo provider will offer).
 *   add-provider --name N --api-key K   Register a Coding Plan API key as a manual
 *       [--models a,b] [--base-url U]   provider in ~/.zcode/v2/provider_config.json
 *       [--protocol openai|anthropic]   so it shows up for Paseo sessions.
 *       [--api-key-env VAR]              Read the key from an environment variable
 *       [--config-file PATH]             instead of the command line, so it stays
 *                                       out of shell history and process listings.
 *   list-providers                      Print the manual providers ZCode will load.
 *       [--config-file PATH]
 *
 * Billing guide:
 *   - Personal Coding Plan: create an API key at https://bigmodel.cn
 *     (Coding Plan page) and register it with --kind personal.
 *   - Team Coding Plan: create the API key under your TEAM in the BigModel
 *     console (team API keys carry the team billing), then register it with
 *     --kind team. Both providers can coexist; pick one per session in Paseo.
 *
 * The provider_config.json file is shared between the ZCode desktop app and
 * the CLI. Every write is preceded by a timestamped backup and merges into the
 * existing JSON instead of replacing it.
 */

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  accessSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_OPENAI_BASE_URL = "https://open.bigmodel.cn/api/coding/paas/v4";
const DEFAULT_ANTHROPIC_BASE_URL = "https://open.bigmodel.cn/api/anthropic";
const DEFAULT_MODELS = ["glm-5.3", "glm-5.3-flash"];
const APP_REQUEST_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// zcode discovery (mirrors plugins/zcode-provider/server/internal/binary.ts)
// ---------------------------------------------------------------------------

function isExecutable(path) {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function firstOnPath(names) {
  const delimiter = process.platform === "win32" ? ";" : ":";
  for (const entry of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(entry, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

function desktopBundleCandidates() {
  const home = homedir();
  const roots = [];
  if (process.platform === "darwin") {
    roots.push("/Applications/ZCode.app", join(home, "Applications", "ZCode.app"));
  } else if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    roots.push(join(local, "Programs", "ZCode"));
    // The app is also installable outside %LOCALAPPDATA%\Programs, so the
    // drives applications are installed to are searched too.
    for (const drive of ["C:", "D:", "E:", "F:"]) {
      roots.push(join(`${drive}\\`, "Programs", "ZCode"));
    }
  } else {
    roots.push("/opt/ZCode", join(home, ".local", "share", "ZCode"));
  }
  return roots.flatMap((root) => [
    join(root, "Contents", "Resources", "glm", "zcode.cjs"),
    join(root, "resources", "glm", "zcode.cjs"),
  ]);
}

/**
 * The desktop app's bundled runtime needs the built-in provider config. The
 * CLI only looks for it next to its own entrypoint, and the app keeps it under
 * `resources/config/`, so it has to be passed through the environment.
 */
function bundledProviderConfigEnv(bundlePath) {
  const bundleDir = dirname(bundlePath);
  const candidates = [
    join(bundleDir, "..", "config", "provider", "zcode-builtin.json"),
    join(bundleDir, "provider", "zcode-builtin.json"),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  return found ? { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: found } : {};
}

/** Returns { command, args, env } for `zcode app-server --stdio`, or null. */
function resolveZCodeLaunch() {
  const onPath = firstOnPath(["zcode"]);
  if (onPath) return { command: onPath, args: ["app-server", "--stdio"], env: {} };

  const bundle = desktopBundleCandidates().find((candidate) => existsSync(candidate));
  if (bundle) {
    return {
      command: process.execPath,
      args: [bundle, "app-server", "--stdio"],
      env: { ELECTRON_RUN_AS_NODE: "1", ...bundledProviderConfigEnv(bundle) },
    };
  }

  const fromEnv = process.env.GLM_BINARY_PATH?.trim();
  if (fromEnv && isExecutable(fromEnv)) {
    return { command: fromEnv, args: ["app-server", "--stdio"], env: {} };
  }
  return null;
}

// ---------------------------------------------------------------------------
// provider_config.json handling (shared with the ZCode desktop app — merge only)
// ---------------------------------------------------------------------------

function defaultConfigFile() {
  const baseDir = process.env.ZCODE_DATA_BASE_DIR?.trim() || homedir();
  return join(baseDir, ".zcode", "v2", "provider_config.json");
}

function loadProviderConfig(path) {
  if (!existsSync(path)) {
    return {
      schemaVersion: 1,
      config: {
        providerConfigRules: { templateRules: [], providerRules: [] },
        modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
      },
    };
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function providerRules(config) {
  const rules = ((config.config ??= {}).providerConfigRules ??= {});
  rules.providerRules ??= [];
  return rules.providerRules;
}

// ---------------------------------------------------------------------------
// subcommands
// ---------------------------------------------------------------------------

function cmdDoctor() {
  const launch = resolveZCodeLaunch();
  if (!launch) {
    console.error(
      [
        "✗ ZCode CLI not found.",
        "  Fix one of these:",
        "  1. Install the ZCode desktop app (its bundled runtime is auto-discovered),",
        "  2. put a `zcode` launcher on PATH (see local/zcode-setup.sh in the ZCode repo), or",
        "  3. export GLM_BINARY_PATH=/path/to/zcode.cjs",
      ].join("\n"),
    );
    process.exit(1);
  }
  console.log(`✓ ZCode runtime: ${launch.command} ${launch.args.join(" ")}`);
  // The version check runs the same runtime the app-server would, so the
  // bundle path and the environment have to be passed the same way.
  const versionArgs = launch.args.slice(0, -2).concat(["--version"]);
  const child = spawn(launch.command, versionArgs, {
    env: { ...process.env, ...launch.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  child.on("exit", (code) => {
    const detail = out.trim() || err.trim() || `(exit ${code})`;
    console.log(`✓ zcode version: ${detail}`);
    console.log("Next: node scripts/zcode-setup.js probe");
  });
}

/**
 * The app-server asks the client questions mid-turn. The probe answers the one
 * the create path needs and declines anything else, so the server falls back
 * instead of hanging on a silent client.
 */
function answerReverseRequest(frame, write) {
  const result =
    frame.method === "session/requestRuntimePreferences"
      ? {
          nativeSearchEnhancementsEnabled: false,
          toolSearchMode: "off",
          memoryEnabled: false,
          askUserQuestionAutoResolutionEnabled: true,
        }
      : undefined;
  const response = result
    ? { id: frame.id, result }
    : {
        id: frame.id,
        error: { code: -32601, message: `setup probe does not support ${frame.method}` },
      };
  write(`${JSON.stringify(response)}\n`);
}

/**
 * Routes one line of app-server output: a reverse request is answered, a
 * response settles the pending request it belongs to.
 */
function handleFrame(line, pending, write) {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    return; // tolerant: ignore non-JSON noise
  }
  if (frame.method !== undefined && frame.id !== undefined) {
    answerReverseRequest(frame, write);
    return;
  }
  const entry = pending.get(frame.id);
  if (!entry) return;
  pending.delete(frame.id);
  clearTimeout(entry.timer);
  if (frame.error) entry.reject(new Error(`${frame.error.message} (code ${frame.error.code})`));
  else entry.resolve(frame.result);
}

/**
 * Prints what a probe session can see: every model the registry exposes, the
 * current default, and whether a Team Coding Plan provider is among them.
 */
function reportProbeModels(snapshot, session) {
  const settings = snapshot.settings ?? {};
  const available = settings.model?.available ?? [];
  console.log(`\nModels visible to Paseo sessions (${available.length}):`);
  for (const model of available) {
    console.log(
      `  - ${model.ref.providerId}/${model.ref.modelId}` +
        `  [${model.providerLabel}]` +
        `  context=${model.contextWindow ?? "?"}` +
        `  reasoning=${(model.reasoning?.levels ?? []).map((level) => level.value).join("/") || "-"}`,
    );
  }
  const current = settings.model?.current ?? session?.model;
  if (current) {
    console.log(
      `Current default: ${
        typeof current === "string" ? current : `${current.providerId}/${current.modelId}`
      }`,
    );
  }
  const hasTeam = available.some((model) =>
    String(model.providerLabel ?? "")
      .toLowerCase()
      .includes("team"),
  );
  console.log(
    hasTeam
      ? "\n✓ A Team Coding Plan provider is visible."
      : '\nℹ No Team Coding Plan provider visible. Register one:\n  node scripts/zcode-setup.js add-provider --name "BigModel Team CodingPlan" --api-key <TEAM_KEY> --kind team',
  );
}

async function cmdProbe() {
  const launch = resolveZCodeLaunch();
  if (!launch) {
    console.error("✗ ZCode CLI not found (run `doctor` for fixes).");
    process.exit(1);
  }
  console.log(`Probing ${launch.command} ${launch.args.join(" ")} ...`);

  const child = spawn(launch.command, [...launch.args], {
    cwd: process.platform === "win32" ? homedir() : "/tmp",
    env: { ...process.env, ...launch.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => (stderr += chunk));

  const pending = new Map();
  let nextId = 1;
  const readline = createInterface({ input: child.stdout });
  readline.on("line", (line) => {
    handleFrame(line, pending, (payload) => child.stdin.write(payload));
  });
  child.on("exit", () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`app-server exited before answering. stderr: ${stderr.slice(-400)}`));
    }
    pending.clear();
  });

  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(
        () => reject(new Error(`timeout waiting for ${method}`)),
        APP_REQUEST_TIMEOUT_MS,
      );
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });

  try {
    const created = await request("session/create", {
      workspace: { workspacePath: "/tmp", workspaceKey: "/tmp" },
    });
    const session = created.session ?? {};
    const sessionId = session.sessionId ?? session.id;
    if (!sessionId) throw new Error("session/create returned no session id");
    const snapshot = await request("session/read", { sessionId });
    reportProbeModels(snapshot, created.session);
    await request("session/close", { sessionId }).catch(() => {});
    console.log("\nProbe OK.");
  } finally {
    child.kill();
    if (stderr.trim()) {
      console.error(`\n(app-server stderr tail)\n${stderr.trim().slice(-600)}`);
    }
  }
}

function cmdAddProvider(args) {
  const option = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const name = option("--name");
  const apiKeyEnv = option("--api-key-env");
  // A key passed on the command line ends up in shell history and in the
  // process listing, so the environment is the safer source.
  const apiKey = apiKeyEnv ? process.env[apiKeyEnv]?.trim() : option("--api-key");
  const kind = option("--kind") ?? "personal";
  const protocol = option("--protocol") ?? "openai";
  const baseUrl =
    option("--base-url") ??
    (protocol === "anthropic" ? DEFAULT_ANTHROPIC_BASE_URL : DEFAULT_OPENAI_BASE_URL);
  const models = (option("--models") ?? DEFAULT_MODELS.join(","))
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
  const configFile = option("--config-file") ?? defaultConfigFile();

  if (!name || !apiKey) {
    console.error(
      "Usage: add-provider --name <provider name> --api-key <key> [--kind personal|team] [--models a,b] [--protocol openai|anthropic] [--base-url URL] [--config-file PATH]",
    );
    process.exit(1);
  }

  mkdirSync(dirname(configFile), { recursive: true });
  const config = loadProviderConfig(configFile);
  const rules = providerRules(config);

  const existing = rules.find((rule) => rule.providerName === name);
  const providerId = existing?.providerId ?? randomUUID();
  const entry = {
    providerId,
    providerName: name,
    config: {
      group: "standard-personal",
      access: { type: "api-key", apiKey },
      api: {
        type: protocol === "anthropic" ? "anthropic-messages" : "openai-chat-completions",
        baseUrl,
      },
      personalModelIds: models,
      modelOrder: models,
    },
  };
  if (existing) {
    console.log(`Provider "${name}" already exists (${providerId}) — updating its key/models.`);
    rules.splice(rules.indexOf(existing), 1, entry);
  } else {
    rules.push(entry);
  }

  if (existsSync(configFile)) {
    const backup = `${configFile}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(configFile, backup);
    console.log(`Backup written: ${backup}`);
  }
  writeFileSync(configFile, `${JSON.stringify(config, null, 1)}\n`);
  console.log(`✓ Provider registered in ${configFile}`);
  console.log(`  providerId: ${providerId}`);
  console.log(`  models:     ${models.join(", ")}`);
  console.log(`  protocol:   ${entry.config.api.type} @ ${baseUrl}`);
  if (kind === "team") {
    console.log(
      "  NOTE: the key must be a TEAM Coding Plan key (created under your organization\n" +
        "  in the BigModel console) — personal keys on this entry will bill personally.",
    );
  }
  console.log("Next: node scripts/zcode-setup.js probe");
}

function cmdListProviders(args) {
  const index = args.indexOf("--config-file");
  const configFile = index >= 0 ? args[index + 1] : defaultConfigFile();
  if (!existsSync(configFile)) {
    console.log(`(no provider config at ${configFile})`);
    return;
  }
  const rules = providerRules(JSON.parse(readFileSync(configFile, "utf8")));
  if (rules.length === 0) {
    console.log("(no manual providers registered)");
    return;
  }
  for (const rule of rules) {
    console.log(
      `- ${rule.providerName}  [${String(rule.providerId).slice(0, 8)}…]  ` +
        `${rule.config?.api?.type} @ ${rule.config?.api?.baseUrl}  ` +
        `models: ${(rule.config?.personalModelIds ?? []).join(", ") || "-"}`,
    );
  }
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------

const [command, ...args] = process.argv.slice(2);
switch (command) {
  case "doctor":
    cmdDoctor();
    break;
  case "probe":
    await cmdProbe();
    break;
  case "add-provider":
    cmdAddProvider(args);
    break;
  case "list-providers":
    cmdListProviders(args);
    break;
  default:
    console.error(
      [
        "Usage: node scripts/zcode-setup.js <command>",
        "",
        "  doctor          Detect the ZCode CLI and print health info",
        "  probe           List every model Paseo sessions will see",
        "  add-provider    Register a personal/team Coding Plan API key",
        "  list-providers  Print registered manual providers",
        "",
        "See plugins/zcode-provider/README.md for the full guide.",
      ].join("\n"),
    );
    process.exit(command === undefined ? 0 : 1);
}
