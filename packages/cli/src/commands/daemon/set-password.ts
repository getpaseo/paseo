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
import { resolveLocalPaseoHome } from "./local-daemon.js";

const CONFIG_FILENAME = "config.json";

interface SetPasswordResult {
  action: "password_set";
  configPath: string;
  restartCommand: string;
  message: string;
}

export type PromptPassword = (message: string) => Promise<string | symbol>;

export interface SetPasswordOptions {
  home?: string;
  promptPassword?: PromptPassword;
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
  const promptPassword =
    typeof options.promptPassword === "function"
      ? (options.promptPassword as PromptPassword)
      : (message: string) => passwordPrompt({ message });
  const newPassword = await promptForPassword(promptPassword);
  const result = await setDaemonPasswordInConfig(newPassword, {
    home: typeof options.home === "string" ? options.home : undefined,
  });

  return {
    type: "single",
    data: result,
    schema: setPasswordResultSchema,
  };
}
