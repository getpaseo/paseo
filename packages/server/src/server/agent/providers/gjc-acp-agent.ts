import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type {
  McpServer,
  SessionConfigOption,
  SessionConfigSelectGroup,
  SessionConfigSelectOption,
} from "@agentclientprotocol/sdk";
import type { Logger } from "pino";

import type {
  ACPClientCapabilityMeta,
  ACPNewSessionStarter,
  ACPProbeSessionCloser,
  SessionStateResponse,
} from "./acp-agent.js";
import { GenericACPAgentClient } from "./generic-acp-agent.js";
import { createProviderEnv } from "../provider-launch-config.js";

interface GjcACPAgentClientOptions {
  logger: Logger;
  command: [string, ...string[]];
  env?: Record<string, string>;
  providerId?: string;
  label?: string;
  providerParams?: unknown;
  execFile?: GjcExecFile;
}

interface GjcLifecycleCommand {
  command: string;
  args: string[];
}

interface GjcLifecycleCreateInput {
  cwd: string;
  target: { path: string };
  readinessTimeoutMs: number;
  mcpServers?: McpServer[];
}

interface GjcSessionCreateResult {
  sessionId: string;
}

type GjcExecFile = (
  file: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeout: number;
    maxBuffer: number;
    encoding: BufferEncoding;
    signal?: AbortSignal;
  },
) => Promise<{ stdout: string; stderr: string }>;

type GjcInputDirectoryRemover = (path: string) => Promise<void>;

type GjcJsonInputFileCleanup = { ok: true } | { ok: false; error: unknown };

interface GjcJsonInputFileResult<T> {
  value: T;
  cleanup: GjcJsonInputFileCleanup;
}

const GJC_CLIENT_CAPABILITIES = {
  terminal: true,
};

const GJC_CLIENT_CAPABILITY_META = {
  gjc: {
    permissionHandling: "prompt",
  },
} satisfies ACPClientCapabilityMeta;

const GJC_ACP_READINESS_TIMEOUT_MS = 60_000;
const GJC_ACP_RAW_CREATE_TIMEOUT_MS = 130_000;
const GJC_ACP_RAW_CLOSE_TIMEOUT_MS = 30_000;
const GJC_ACP_RAW_CREATE_MAX_BUFFER_BYTES = 1024 * 1024;
const GJC_DEFAULT_MODE_ID = "default";
const GJC_UNSUPPORTED_HOST_LIFECYCLE_MODE_IDS = new Set([
  "plan",
  "https://agentclientprotocol.com/protocol/session-modes#plan",
]);

type SelectConfigOption = Extract<SessionConfigOption, { type: "select" }>;
type GjcModeOption = SessionConfigSelectGroup | SessionConfigSelectOption;

const execFile = promisify(execFileCallback) as GjcExecFile;

export class GjcACPAgentClient extends GenericACPAgentClient {
  constructor(options: GjcACPAgentClientOptions) {
    super({
      logger: options.logger,
      command: options.command,
      env: options.env,
      providerId: options.providerId,
      label: options.label,
      providerParams: options.providerParams,
      clientCapabilities: GJC_CLIENT_CAPABILITIES,
      probeClientCapabilities: {
        terminal: false,
      },
      clientCapabilityMeta: GJC_CLIENT_CAPABILITY_META,
      diagnosticPhaseTimeoutMs: GJC_ACP_READINESS_TIMEOUT_MS,
      sessionResponseTransformer: transformGjcSessionResponse,
      configOptionsTransformer: transformGjcConfigOptions,
      modeIdTransformer: transformGjcModeId,
      newSessionStarter: createGjcACPNewSessionStarter({
        command: options.command,
        env: options.env,
        execFile: options.execFile,
      }),
      newSessionFailureCloser: createGjcACPProbeSessionCloser({
        command: options.command,
        env: options.env,
        execFile: options.execFile,
      }),
      sessionCloser: createGjcACPProbeSessionCloser({
        command: options.command,
        env: options.env,
        execFile: options.execFile,
      }),
      probeSessionCloser: createGjcACPProbeSessionCloser({
        command: options.command,
        env: options.env,
        execFile: options.execFile,
      }),
    });
  }
}

export function transformGjcSessionResponse(response: SessionStateResponse): SessionStateResponse {
  if (!response.modes) {
    return response;
  }
  const availableModes = response.modes.availableModes.filter(
    (mode) => !isGjcUnsupportedHostLifecycleMode(mode.id),
  );
  return {
    ...response,
    modes: {
      ...response.modes,
      availableModes,
      currentModeId: transformGjcModeId(response.modes.currentModeId) ?? GJC_DEFAULT_MODE_ID,
    },
  };
}

export function transformGjcConfigOptions(
  configOptions: SessionConfigOption[],
): SessionConfigOption[] {
  return configOptions.flatMap((option) => {
    if (option.type !== "select" || option.category !== "mode") {
      return [option];
    }
    const options = filterGjcModeOptions(option.options);
    const currentValue = transformGjcModeId(option.currentValue) ?? firstModeOptionValue(options);
    if (!currentValue) {
      return [];
    }
    return {
      ...option,
      options,
      currentValue,
    };
  });
}

export function transformGjcModeId(modeId: string): string | null {
  return isGjcUnsupportedHostLifecycleMode(modeId) ? null : modeId;
}

export function createGjcACPNewSessionStarter(options: {
  command: [string, ...string[]];
  env?: Record<string, string>;
  execFile?: GjcExecFile;
  removeInputDirectory?: GjcInputDirectoryRemover;
}): ACPNewSessionStarter {
  const runExecFile = options.execFile ?? execFile;

  return async ({
    connection,
    config,
    mcpServers,
    runRequest,
    registerProbeSession,
    signal,
    launchEnv,
  }) => {
    const lifecycleInput: GjcLifecycleCreateInput = {
      cwd: config.cwd,
      target: {
        path: config.cwd,
      },
      readinessTimeoutMs: GJC_ACP_READINESS_TIMEOUT_MS,
      ...(mcpServers.length > 0 ? { mcpServers } : {}),
    };

    let createResult: GjcSessionCreateResult;
    let createCleanup: GjcJsonInputFileCleanup = { ok: true };
    try {
      const createCommandResult = await withGjcJsonInputFile(
        lifecycleInput,
        async (inputFilePath) => {
          const lifecycleCommand = buildGjcLifecycleCreateCommand(
            options.command,
            config.cwd,
            lifecycleInput,
            { inputFilePath },
          );
          return await runExecFile(lifecycleCommand.command, lifecycleCommand.args, {
            cwd: config.cwd,
            env: buildGjcLifecycleEnv(options.env, launchEnv),
            timeout: GJC_ACP_RAW_CREATE_TIMEOUT_MS,
            maxBuffer: GJC_ACP_RAW_CREATE_MAX_BUFFER_BYTES,
            encoding: "utf8",
            signal,
          });
        },
        options.removeInputDirectory,
      );
      createCleanup = createCommandResult.cleanup;
      createResult = extractGjcSessionCreateResult(
        parseGjcJsonOutput(createCommandResult.value.stdout),
      );
    } catch (error) {
      throw new Error(`GJC lifecycle session.create failed: ${formatGjcExecError(error)}`, {
        cause: error,
      });
    }
    if (!createCleanup.ok) {
      let closeError: unknown;
      try {
        await closeGjcLifecycleSession({
          command: options.command,
          env: options.env,
          launchEnv,
          execFile: runExecFile,
          cwd: config.cwd,
          sessionId: createResult.sessionId,
        });
      } catch (error) {
        closeError = error;
      }
      if (closeError) {
        throw new Error(
          `GJC lifecycle input cleanup failed after session.create, and session.close failed: ${formatGjcExecError(
            closeError,
          )}`,
          {
            cause: createCleanup.error,
          },
        );
      }
      throw new Error(
        `GJC lifecycle input cleanup failed after session.create: ${formatGjcExecError(
          createCleanup.error,
        )}`,
        {
          cause: createCleanup.error,
        },
      );
    }
    const abortError = getGjcLifecycleAbortError(signal);
    if (abortError) {
      let closeError: unknown;
      try {
        await closeGjcLifecycleSession({
          command: options.command,
          env: options.env,
          launchEnv,
          execFile: runExecFile,
          cwd: config.cwd,
          sessionId: createResult.sessionId,
        });
      } catch (error) {
        closeError = error;
      }
      if (closeError) {
        throw new AggregateError(
          [abortError, closeError],
          `GJC lifecycle session startup cancelled and session.close failed: ${formatGjcExecError(
            abortError,
          )}; cleanup: ${formatGjcExecError(closeError)}`,
        );
      }
      throw abortError;
    }
    const closeViaProbeTracker = Boolean(registerProbeSession);
    registerProbeSession?.({ sessionId: createResult.sessionId });

    let sessionState: SessionStateResponse;
    try {
      sessionState = await runRequest(() =>
        connection.loadSession({
          sessionId: createResult.sessionId,
          cwd: config.cwd,
          mcpServers,
        }),
      );
    } catch (error) {
      if (closeViaProbeTracker) {
        throw error;
      }
      let closeError: unknown;
      try {
        await closeGjcLifecycleSession({
          command: options.command,
          env: options.env,
          launchEnv,
          execFile: runExecFile,
          cwd: config.cwd,
          sessionId: createResult.sessionId,
        });
      } catch (cleanupError) {
        closeError = cleanupError;
      }
      if (closeError) {
        const loadAndCloseError = new AggregateError(
          [error, closeError],
          `GJC lifecycle session.load failed and session.close failed: ${formatGjcExecError(
            error,
          )}; cleanup: ${formatGjcExecError(closeError)}`,
          { cause: error },
        );
        throw loadAndCloseError;
      }
      throw error;
    }
    return {
      ...sessionState,
      sessionId: createResult.sessionId,
    };
  };
}

export function createGjcACPProbeSessionCloser(options: {
  command: [string, ...string[]];
  env?: Record<string, string>;
  execFile?: GjcExecFile;
}): ACPProbeSessionCloser {
  const runExecFile = options.execFile ?? execFile;

  return async ({ response, config, launchEnv }) => {
    const sessionId = getSessionStateResponseId(response);
    if (!sessionId) {
      throw new Error("GJC probe session did not expose a session id");
    }
    await closeGjcLifecycleSession({
      command: options.command,
      env: options.env,
      launchEnv,
      execFile: runExecFile,
      cwd: config.cwd,
      sessionId,
    });
  };
}

export function buildGjcLifecycleCreateCommand(
  acpCommand: [string, ...string[]],
  cwd: string,
  input: GjcLifecycleCreateInput,
  options: { inputFilePath?: string } = {},
): GjcLifecycleCommand {
  const jsonInputArgs = options.inputFilePath
    ? ["--json-input-file", options.inputFilePath]
    : ["--json-input", JSON.stringify(input)];

  return buildGjcLifecycleCommand(acpCommand, [
    "sdk",
    "session",
    "raw",
    "global",
    "--op",
    "session.create",
    ...jsonInputArgs,
    "--idempotency-key",
    randomUUID(),
    "--json",
    "--repo",
    cwd,
  ]);
}

export function buildGjcLifecycleCloseCommand(
  acpCommand: [string, ...string[]],
  cwd: string,
  sessionId: string,
): GjcLifecycleCommand {
  return buildGjcLifecycleCommand(acpCommand, [
    "sdk",
    "session",
    "raw",
    "control",
    sessionId,
    "--op",
    "session.close",
    "--json-input",
    "{}",
    "--confirm",
    "--json",
    "--repo",
    cwd,
  ]);
}

async function withGjcJsonInputFile<T>(
  input: GjcLifecycleCreateInput,
  operation: (inputFilePath: string) => Promise<T>,
  removeInputDirectory: GjcInputDirectoryRemover = (path) =>
    rm(path, { recursive: true, force: true }),
): Promise<GjcJsonInputFileResult<T>> {
  const directory = await mkdtemp(join(tmpdir(), "paseo-gjc-json-"));
  const inputFilePath = join(directory, "input.json");
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    await writeFile(inputFilePath, JSON.stringify(input), { mode: 0o600 });
    await chmod(inputFilePath, 0o600);
    outcome = { ok: true, value: await operation(inputFilePath) };
  } catch (error) {
    outcome = { ok: false, error };
  }

  let cleanup: GjcJsonInputFileCleanup;
  try {
    await removeInputDirectory(directory);
    cleanup = { ok: true };
  } catch (error) {
    cleanup = { ok: false, error };
  }

  if (!outcome.ok) {
    if (!cleanup.ok) {
      throw new AggregateError(
        [outcome.error, cleanup.error],
        `GJC lifecycle request failed and input cleanup failed: ${formatGjcExecError(
          outcome.error,
        )}; cleanup: ${formatGjcExecError(cleanup.error)}`,
      );
    }
    throw outcome.error;
  }
  return { value: outcome.value, cleanup };
}

async function closeGjcLifecycleSession(options: {
  command: [string, ...string[]];
  env?: Record<string, string>;
  launchEnv?: Record<string, string>;
  execFile: GjcExecFile;
  cwd: string;
  sessionId: string;
}): Promise<void> {
  const lifecycleCommand = buildGjcLifecycleCloseCommand(
    options.command,
    options.cwd,
    options.sessionId,
  );
  try {
    const { stdout } = await options.execFile(lifecycleCommand.command, lifecycleCommand.args, {
      cwd: options.cwd,
      env: buildGjcLifecycleEnv(options.env, options.launchEnv),
      timeout: GJC_ACP_RAW_CLOSE_TIMEOUT_MS,
      maxBuffer: GJC_ACP_RAW_CREATE_MAX_BUFFER_BYTES,
      encoding: "utf8",
    });
    assertGjcLifecycleCommandSucceeded(stdout);
  } catch (error) {
    throw new Error(`GJC lifecycle session.close failed: ${formatGjcExecError(error)}`, {
      cause: error,
    });
  }
}

function buildGjcLifecycleEnv(
  providerEnv: Record<string, string> | undefined,
  launchEnv: Record<string, string> | undefined,
): NodeJS.ProcessEnv {
  return createProviderEnv({
    overlays: [providerEnv, launchEnv],
  });
}

function isGjcUnsupportedHostLifecycleMode(modeId: string): boolean {
  return GJC_UNSUPPORTED_HOST_LIFECYCLE_MODE_IDS.has(modeId);
}

function filterGjcModeOptions(
  options: SelectConfigOption["options"],
): SelectConfigOption["options"] {
  const filtered: GjcModeOption[] = [];
  for (const option of options as GjcModeOption[]) {
    if ("value" in option) {
      if (!isGjcUnsupportedHostLifecycleMode(option.value)) {
        filtered.push(option);
      }
      continue;
    }
    const groupOptions = option.options.filter(
      (choice) => !isGjcUnsupportedHostLifecycleMode(choice.value),
    );
    if (groupOptions.length > 0) {
      filtered.push({ ...option, options: groupOptions });
    }
  }
  return filtered as SelectConfigOption["options"];
}

function firstModeOptionValue(options: SelectConfigOption["options"]): string | null {
  for (const option of options as GjcModeOption[]) {
    if ("value" in option) {
      return option.value;
    }
    const firstGroupOption = option.options[0];
    if (firstGroupOption) {
      return firstGroupOption.value;
    }
  }
  return null;
}

function buildGjcLifecycleCommand(
  acpCommand: [string, ...string[]],
  lifecycleArgs: string[],
): GjcLifecycleCommand {
  const acpArgs = acpCommand.slice(1);
  const acpArgIndex = acpArgs.findIndex((arg) => arg === "acp");
  const prefixArgs = acpArgIndex === -1 ? acpArgs : acpArgs.slice(0, acpArgIndex);
  return {
    command: acpCommand[0],
    args: [...prefixArgs, ...lifecycleArgs],
  };
}

function parseGjcJsonOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error("empty JSON response");
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    const jsonLine = trimmed
      .split(/\r?\n/)
      .toReversed()
      .find((line) => line.trim().startsWith("{"));
    if (!jsonLine) {
      throw new Error("non-JSON response");
    }
    return JSON.parse(jsonLine);
  }
}

function extractGjcSessionCreateResult(value: unknown): GjcSessionCreateResult {
  if (isRecord(value) && value.ok === false) {
    throw new Error(formatGjcBrokerError(value));
  }

  const result = isRecord(value) && isRecord(value.result) ? value.result : value;
  if (isRecord(result) && result.ok === false) {
    throw new Error(formatGjcBrokerError(result));
  }

  const nestedResult = isRecord(result) && isRecord(result.result) ? result.result : result;
  if (isRecord(nestedResult) && typeof nestedResult.sessionId === "string") {
    return { sessionId: nestedResult.sessionId };
  }

  throw new Error("missing session id");
}

function assertGjcLifecycleCommandSucceeded(stdout: string): void {
  if (!stdout.trim()) {
    return;
  }
  const value = parseGjcJsonOutput(stdout);
  if (isRecord(value) && value.ok === false) {
    throw new Error(formatGjcBrokerError(value));
  }

  const result = isRecord(value) && isRecord(value.result) ? value.result : value;
  if (isRecord(result) && result.ok === false) {
    throw new Error(formatGjcBrokerError(result));
  }
}

function getGjcLifecycleAbortError(signal: AbortSignal | undefined): Error | null {
  if (!signal?.aborted) {
    return null;
  }
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("GJC lifecycle session startup cancelled");
}

function getSessionStateResponseId(response: SessionStateResponse): string | null {
  return "sessionId" in response && typeof response.sessionId === "string"
    ? response.sessionId
    : null;
}

function formatGjcBrokerError(value: Record<string, unknown>): string {
  const error = value.error;
  if (isRecord(error)) {
    const code = typeof error.code === "string" ? error.code : null;
    const message = typeof error.message === "string" ? error.message : null;
    return sanitizeGjcDiagnostic([code, message].filter(Boolean).join(": "));
  }
  return "broker returned an error";
}

function formatGjcExecError(error: unknown): string {
  if (error instanceof Error) {
    const stdoutMessage = isRecord(error) ? extractGjcStdoutError(error.stdout) : null;
    if (stdoutMessage) {
      return stdoutMessage;
    }
    return sanitizeGjcDiagnostic(error.message);
  }
  return sanitizeGjcDiagnostic(error);
}

function extractGjcStdoutError(stdout: unknown): string | null {
  if (typeof stdout !== "string" || !stdout.trim()) {
    return null;
  }
  try {
    const parsed = parseGjcJsonOutput(stdout);
    if (isRecord(parsed) && parsed.ok === false) {
      return formatGjcBrokerError(parsed);
    }
    if (isRecord(parsed) && isRecord(parsed.result) && parsed.result.ok === false) {
      return formatGjcBrokerError(parsed.result);
    }
  } catch {
    return null;
  }
  return null;
}

function sanitizeGjcDiagnostic(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return (text || "unknown error")
    .replace(/("token"\s*:\s*")[^"]+(")/gi, "$1[redacted]$2")
    .replace(/(token=)[^\s&]+/gi, "$1[redacted]")
    .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, "$1[redacted]");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
