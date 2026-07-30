import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Transform } from "node:stream";

import pino from "pino";

import { OpenCodeAgentClient } from "../agent/providers/opencode-agent.js";
import { terminateWithTreeKill } from "../../utils/tree-kill.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { DaemonClient } from "../test-utils/daemon-client.js";

const PINNED_OPENCODE_VERSION = "1.18.9";
const PINNED_OMO_VERSION = "4.19.3";
const DEFAULT_OPENROUTER_MODEL = "openrouter/google/gemini-2.5-flash";
const NO_AUTH_MODEL = "opencode/big-pickle";
const COMMAND_TIMEOUT_MS = 180_000;

interface RuntimePaths {
  root: string;
  home: string;
  paseoHomeRoot: string;
  xdgConfig: string;
  xdgData: string;
  xdgCache: string;
  temporary: string;
  npmCache: string;
  runtime: string;
  artifacts: string;
  workspace: string;
}

interface CommandInput {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  artifactName: string;
  artifacts: string;
  secrets: string[];
  requiredOutput?: string;
}

export interface OpenCodeOmoRealRuntime {
  client: DaemonClient;
  daemon: TestPaseoDaemon;
  model: string;
  workspace: string;
  artifacts: string;
  close: (passed: boolean) => Promise<void>;
}

export async function createOpenCodeOmoRealRuntime(): Promise<OpenCodeOmoRealRuntime> {
  const paths = createRuntimePaths();
  const openCodeVersion =
    process.env.PASEO_REAL_OPENCODE_VERSION?.trim() || PINNED_OPENCODE_VERSION;
  const omoVersion = process.env.PASEO_REAL_OMO_VERSION?.trim() || PINNED_OMO_VERSION;
  const openRouterApiKey = process.env.OPENROUTER_API_KEY?.trim() || null;
  const model = resolveModel(openRouterApiKey);
  const secrets = collectEnvironmentSecrets(openRouterApiKey);
  const runtimeEnv = buildRuntimeEnv(paths, openRouterApiKey);
  const npmCli = process.env.npm_execpath;
  if (!npmCli || !existsSync(npmCli)) {
    throw new Error(
      `The targeted npm script must provide npm_execpath. Retained real-test artifacts: ${paths.artifacts}`,
    );
  }

  await runCommand({
    command: process.execPath,
    args: [
      npmCli,
      "install",
      "--no-save",
      "--no-package-lock",
      "--prefix",
      paths.runtime,
      "--cache",
      paths.npmCache,
      `opencode-ai@${openCodeVersion}`,
      `oh-my-openagent@${omoVersion}`,
    ],
    cwd: paths.root,
    env: runtimeEnv,
    artifactName: "npm-install.log",
    artifacts: paths.artifacts,
    secrets,
  });

  const executableSuffix = process.platform === "win32" ? ".cmd" : "";
  const openCodeCommand = path.join(
    paths.runtime,
    "node_modules",
    ".bin",
    `opencode${executableSuffix}`,
  );
  const omoCommand = path.join(paths.runtime, "node_modules", ".bin", `omo${executableSuffix}`);
  assertFixtureExecutable(openCodeCommand, `opencode-ai@${openCodeVersion}`);
  assertFixtureExecutable(omoCommand, `oh-my-openagent@${omoVersion}`);

  await runCommand({
    command: omoCommand,
    args: [
      "install",
      "--no-tui",
      "--platform=opencode",
      "--claude=no",
      "--openai=no",
      "--gemini=no",
      "--copilot=no",
      "--opencode-zen=yes",
      "--zai-coding-plan=no",
      "--opencode-go=no",
      "--kimi-for-coding=no",
    ],
    cwd: paths.workspace,
    env: runtimeEnv,
    artifactName: "omo-install.log",
    artifacts: paths.artifacts,
    secrets,
  });
  pinOpenCodePlugin(paths.xdgConfig, omoVersion);
  writeOmoModelConfig(paths.home, model);

  await runCommand({
    command: openCodeCommand,
    args: ["agent", "list"],
    cwd: paths.workspace,
    env: runtimeEnv,
    artifactName: "plugin-catalog-probe.log",
    artifacts: paths.artifacts,
    secrets,
  });

  if (model === NO_AUTH_MODEL) {
    await runCommand({
      command: openCodeCommand,
      args: ["run", "--model", model, "Reply with exactly: PASEO_BIG_PICKLE_PROBE_OK"],
      cwd: paths.workspace,
      env: runtimeEnv,
      artifactName: "big-pickle-probe.log",
      artifacts: paths.artifacts,
      secrets,
      requiredOutput: "PASEO_BIG_PICKLE_PROBE_OK",
    });
  }

  const previousPaseoHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = path.join(paths.paseoHomeRoot, ".paseo");
  const traceDestination = pino.destination({
    dest: path.join(paths.artifacts, "daemon.log"),
    sync: true,
  });
  const redactingTrace = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      callback(null, redactSecrets(chunk.toString(), secrets));
    },
  });
  redactingTrace.pipe(traceDestination, { end: false });
  const logger = pino({ level: "trace" }, redactingTrace);
  const closeTrace = createTraceCloser(redactingTrace, traceDestination);
  const openCodeClient = new OpenCodeAgentClient(logger, {
    command: { mode: "replace", argv: [openCodeCommand] },
    env: runtimeEnv,
  });

  let daemon: TestPaseoDaemon | null = null;
  let client: DaemonClient | null = null;
  try {
    daemon = await createTestPaseoDaemon({
      agentClients: { opencode: openCodeClient },
      logger,
      paseoHomeRoot: paths.paseoHomeRoot,
      staticDir: path.join(paths.root, "static"),
      cleanup: false,
    });
    client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    await client.connect();
    await client.fetchAgents({ subscribe: { subscriptionId: "opencode-omo-real" } });
  } catch (error) {
    await client?.close().catch(() => undefined);
    await daemon?.close().catch(() => undefined);
    closeTrace();
    restoreEnvironment("PASEO_HOME", previousPaseoHome);
    throw withArtifactLocation(error, paths.artifacts);
  }

  return {
    client,
    daemon,
    model,
    workspace: paths.workspace,
    artifacts: paths.artifacts,
    close: async (passed) => {
      await client.close().catch(() => undefined);
      await daemon.close().catch(() => undefined);
      closeTrace();
      restoreEnvironment("PASEO_HOME", previousPaseoHome);
      if (passed) {
        rmSync(paths.root, { recursive: true, force: true });
      }
    },
  };
}

function createRuntimePaths(): RuntimePaths {
  const root = mkdtempSync(path.join(tmpdir(), "paseo-real-opencode-omo-"));
  const paths: RuntimePaths = {
    root,
    home: path.join(root, "home"),
    paseoHomeRoot: path.join(root, "paseo-home"),
    xdgConfig: path.join(root, "xdg", "config"),
    xdgData: path.join(root, "xdg", "data"),
    xdgCache: path.join(root, "xdg", "cache"),
    temporary: path.join(root, "tmp"),
    npmCache: path.join(root, "npm-cache"),
    runtime: path.join(root, "runtime"),
    artifacts: path.join(root, "artifacts"),
    workspace: path.join(root, "workspace"),
  };
  for (const directory of Object.values(paths)) {
    mkdirSync(directory, { recursive: true });
  }
  return paths;
}

function resolveModel(openRouterApiKey: string | null): string {
  const explicitModel = process.env.PASEO_REAL_OPENCODE_MODEL?.trim();
  if (explicitModel) {
    return explicitModel;
  }
  return openRouterApiKey ? DEFAULT_OPENROUTER_MODEL : NO_AUTH_MODEL;
}

function buildRuntimeEnv(paths: RuntimePaths, openRouterApiKey: string | null): NodeJS.ProcessEnv {
  return {
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    TZ: process.env.TZ,
    SystemRoot: process.env.SystemRoot,
    COMSPEC: process.env.COMSPEC,
    PATHEXT: process.env.PATHEXT,
    NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
    SSL_CERT_FILE: process.env.SSL_CERT_FILE,
    SSL_CERT_DIR: process.env.SSL_CERT_DIR,
    HOME: paths.home,
    PASEO_HOME: path.join(paths.paseoHomeRoot, ".paseo"),
    XDG_CONFIG_HOME: paths.xdgConfig,
    XDG_DATA_HOME: paths.xdgData,
    XDG_CACHE_HOME: paths.xdgCache,
    TMPDIR: paths.temporary,
    npm_config_cache: paths.npmCache,
    PATH: [path.join(paths.runtime, "node_modules", ".bin"), process.env.PATH]
      .filter((entry): entry is string => Boolean(entry))
      .join(path.delimiter),
    OPENCODE_DISABLE_AUTO_UPDATE: "1",
    CI: "1",
    FORCE_COLOR: "",
    ...(openRouterApiKey ? { OPENROUTER_API_KEY: openRouterApiKey } : {}),
  };
}

async function runCommand(input: CommandInput): Promise<void> {
  const launch = resolveCommandLaunch(input.command, input.args);
  const child = spawn(launch.command, launch.args, {
    cwd: input.cwd,
    env: input.env,
    detached: process.platform !== "win32",
    shell: launch.shell,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

  let timeout: NodeJS.Timeout | null = null;
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    },
  );
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`Command timed out: ${input.artifactName}`)),
      COMMAND_TIMEOUT_MS,
    );
  });

  let result: { code: number | null; signal: NodeJS.Signals | null };
  try {
    result = await Promise.race([exit, timedOut]);
  } catch (error) {
    await stopChild(child);
    writeCommandArtifact(input, stdout, stderr);
    throw withArtifactLocation(error, input.artifacts);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }

  const output = writeCommandArtifact(input, stdout, stderr);
  if (result.code !== 0) {
    throw new Error(
      `Command failed (${result.code ?? result.signal ?? "unknown"}): ${input.artifactName}. Retained real-test artifacts: ${input.artifacts}`,
    );
  }
  if (input.requiredOutput && !output.includes(input.requiredOutput)) {
    throw new Error(
      `Command did not produce ${input.requiredOutput}: ${input.artifactName}. Retained real-test artifacts: ${input.artifacts}`,
    );
  }
}

export function resolveCommandLaunch(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[]; shell: boolean } {
  return {
    command,
    args,
    shell: platform === "win32" && path.extname(command).toLowerCase() === ".cmd",
  };
}

function writeCommandArtifact(input: CommandInput, stdout: Buffer[], stderr: Buffer[]): string {
  const combined = [Buffer.concat(stdout).toString(), Buffer.concat(stderr).toString()]
    .filter((text) => text.length > 0)
    .join("\n");
  writeFileSync(
    path.join(input.artifacts, input.artifactName),
    redactSecrets(combined, input.secrets),
  );
  return combined;
}

function redactSecrets(text: string, secrets: string[]): string {
  return secrets.reduce((redacted, secret) => redacted.split(secret).join("[REDACTED]"), text);
}

function collectEnvironmentSecrets(openRouterApiKey: string | null): string[] {
  const secrets = Object.entries(process.env)
    .filter(([name, value]) => /(?:AUTH|KEY|PASSWORD|SECRET|TOKEN)/i.test(name) && value)
    .map(([, value]) => value)
    .filter((value): value is string => typeof value === "string" && value.length >= 8);
  if (openRouterApiKey) {
    secrets.push(openRouterApiKey);
  }
  return [...new Set(secrets)];
}

function createTraceCloser(
  trace: Transform,
  destination: ReturnType<typeof pino.destination>,
): () => void {
  let closed = false;
  return () => {
    if (closed) {
      return;
    }
    closed = true;
    trace.end();
    destination.flushSync();
    destination.end();
  };
}

async function stopChild(child: ChildProcess): Promise<void> {
  await terminateWithTreeKill(child, {
    gracefulTimeoutMs: 2_000,
    forceTimeoutMs: 2_000,
  });
}

function assertFixtureExecutable(filePath: string, packageName: string): void {
  if (!existsSync(filePath)) {
    throw new Error(`Fixture install did not provide ${packageName} at ${filePath}`);
  }
}

function pinOpenCodePlugin(xdgConfig: string, omoVersion: string): void {
  const configDirectory = path.join(xdgConfig, "opencode");
  const jsonPath = path.join(configDirectory, "opencode.json");
  mkdirSync(configDirectory, { recursive: true });
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        plugin: [`oh-my-openagent@${omoVersion}`],
      },
      null,
      2,
    ),
  );
}

function writeOmoModelConfig(home: string, model: string): void {
  const configDirectory = path.join(home, ".omo");
  mkdirSync(configDirectory, { recursive: true });
  writeFileSync(
    path.join(configDirectory, "omo.jsonc"),
    JSON.stringify(
      {
        "[opencode]": {
          $schema:
            "https://raw.githubusercontent.com/code-yeongyu/oh-my-openagent/dev/assets/omo.schema.json",
          agents: {
            sisyphus: { model, fallback_models: [{ model }] },
            "sisyphus-junior": { model, fallback_models: [{ model }] },
          },
          categories: {
            quick: { model, fallback_models: [{ model }] },
          },
          opencode: {
            background_task: {
              providerConcurrency: { [model.split("/")[0] ?? "opencode"]: 2 },
              modelConcurrency: { [model]: 2 },
            },
          },
        },
      },
      null,
      2,
    ),
  );
}

function restoreEnvironment(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = previous;
}

export function withArtifactLocation(error: unknown, artifacts: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${message}. Retained real-test artifacts: ${artifacts}`, { cause: error });
}
