import path from "node:path";
import type { Command } from "commander";
import { isCancel, password as passwordPrompt } from "@clack/prompts";
import {
  hashDaemonPassword,
  loadPersistedConfig,
  savePersistedConfig,
  type PersistedConfig,
} from "@getpaseo/server";
import type {
  CommandError,
  CommandOptions,
  OutputOptions,
  OutputSchema,
  SingleResult,
} from "../../output/index.js";
import {
  isInteractiveTerminal,
  isWindowsElectronRunAsNode,
  PASSWORD_ALTERNATES_DETAILS,
  promptPasswordViaWindowsConsole,
  type InteractivePasswordProcess,
} from "../../utils/interactive-password.js";
import { resolveLocalPaseoHome } from "./local-daemon.js";

const CONFIG_FILENAME = "config.json";
const SET_PASSWORD_ENV = "PASEO_SET_PASSWORD";

interface SetPasswordResult {
  action: "password_set";
  configPath: string;
  restartCommand: string;
  message: string;
}

export type PromptPassword = (message: string) => Promise<string | symbol>;

export interface SetPasswordOptions {
  home?: string;
  password?: string;
  promptPassword?: PromptPassword;
  promptWindowsConsole?: PromptPassword;
  process?: InteractivePasswordProcess;
  env?: NodeJS.ProcessEnv;
}

const setPasswordResultSchema: OutputSchema<SetPasswordResult> = {
  idField: "action",
  columns: [
    { header: "STATUS", field: "action", color: () => "green" },
    { header: "CONFIG", field: "configPath" },
    { header: "RESTART", field: "restartCommand" },
  ],
  renderHuman: (result, options: OutputOptions) => {
    const data = result.data as SetPasswordResult;
    const rows = [
      `Password written to ${data.configPath}`,
      "Restart the daemon for the change to take effect.",
      `Run: ${data.restartCommand}`,
    ];
    if (options.format === "table") {
      return rows.join("\n");
    }
    return data.message;
  },
};

function createCommandError(code: string, message: string, details?: string): CommandError {
  return { code, message, ...(details ? { details } : {}) };
}

function resolveProvidedPassword(options: SetPasswordOptions): string | undefined {
  if (typeof options.password === "string") {
    return options.password;
  }

  const env = options.env ?? process.env;
  const fromEnv = env[SET_PASSWORD_ENV];
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return fromEnv;
  }

  return undefined;
}

async function promptForPassword(promptPassword: PromptPassword): Promise<string> {
  const first = await promptPassword("New daemon password");
  if (isCancel(first)) {
    throw createCommandError("PASSWORD_CANCELLED", "Password update cancelled");
  }
  if (typeof first !== "string" || first.length === 0) {
    throw createCommandError("PASSWORD_REQUIRED", "Password cannot be empty");
  }

  const second = await promptPassword("Confirm daemon password");
  if (isCancel(second)) {
    throw createCommandError("PASSWORD_CANCELLED", "Password update cancelled");
  }
  if (first !== second) {
    throw createCommandError("PASSWORD_MISMATCH", "Passwords do not match");
  }

  return first;
}

function throwPromptUnavailable(message: string, cause?: unknown): never {
  let causeMessage: string | undefined;
  if (cause instanceof Error) {
    causeMessage = cause.message;
  } else if (cause !== undefined) {
    causeMessage = String(cause);
  }
  const details = causeMessage
    ? `${causeMessage}\n\n${PASSWORD_ALTERNATES_DETAILS}`
    : PASSWORD_ALTERNATES_DETAILS;
  throw createCommandError("PASSWORD_PROMPT_UNAVAILABLE", message, details);
}

async function resolveNewPassword(options: SetPasswordOptions): Promise<string> {
  const provided = resolveProvidedPassword(options);
  if (provided !== undefined) {
    if (provided.length === 0) {
      throw createCommandError("PASSWORD_REQUIRED", "Password cannot be empty");
    }
    return provided;
  }

  if (typeof options.promptPassword === "function") {
    return await promptForPassword(options.promptPassword);
  }

  const processLike = options.process ?? process;
  const windowsElectron = isWindowsElectronRunAsNode(processLike);

  if (!isInteractiveTerminal(processLike) && !windowsElectron) {
    throwPromptUnavailable(
      "Non-interactive terminal detected; provide --password or set PASEO_SET_PASSWORD.",
    );
  }

  if (windowsElectron) {
    const promptWindows =
      typeof options.promptWindowsConsole === "function"
        ? options.promptWindowsConsole
        : (message: string) => promptPasswordViaWindowsConsole(message);
    try {
      return await promptForPassword(promptWindows);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof (error as CommandError).code === "string"
      ) {
        throw error;
      }
      throwPromptUnavailable(
        "Could not read a password from the Windows console under the desktop CLI.",
        error,
      );
    }
  }

  if (!isInteractiveTerminal(processLike)) {
    throwPromptUnavailable(
      "Non-interactive terminal detected; provide --password or set PASEO_SET_PASSWORD.",
    );
  }

  return await promptForPassword((message) => passwordPrompt({ message }));
}

export async function setDaemonPasswordInConfig(
  newPassword: string,
  options: SetPasswordOptions = {},
): Promise<SetPasswordResult> {
  const paseoHome = resolveLocalPaseoHome(options.home);
  const configPath = path.join(paseoHome, CONFIG_FILENAME);
  const persisted = loadPersistedConfig(paseoHome);
  const nextConfig: PersistedConfig = {
    ...persisted,
    daemon: {
      ...persisted.daemon,
      auth: {
        ...persisted.daemon?.auth,
        password: hashDaemonPassword(newPassword),
      },
    },
  };

  savePersistedConfig(paseoHome, nextConfig);

  return {
    action: "password_set",
    configPath,
    restartCommand: "paseo daemon restart",
    message: `Password written to ${configPath}\nRestart the daemon for the change to take effect.\nRun: paseo daemon restart`,
  };
}

export async function runSetPasswordCommand(
  options: CommandOptions,
  _command: Command,
): Promise<SingleResult<SetPasswordResult>> {
  const setPasswordOptions: SetPasswordOptions = {
    home: typeof options.home === "string" ? options.home : undefined,
    password: typeof options.password === "string" ? options.password : undefined,
    promptPassword:
      typeof options.promptPassword === "function"
        ? (options.promptPassword as PromptPassword)
        : undefined,
    promptWindowsConsole:
      typeof options.promptWindowsConsole === "function"
        ? (options.promptWindowsConsole as PromptPassword)
        : undefined,
    process:
      options.process && typeof options.process === "object"
        ? (options.process as InteractivePasswordProcess)
        : undefined,
    env:
      options.env && typeof options.env === "object"
        ? (options.env as NodeJS.ProcessEnv)
        : undefined,
  };

  const newPassword = await resolveNewPassword(setPasswordOptions);
  const result = await setDaemonPasswordInConfig(newPassword, {
    home: setPasswordOptions.home,
  });

  return {
    type: "single",
    data: result,
    schema: setPasswordResultSchema,
  };
}
