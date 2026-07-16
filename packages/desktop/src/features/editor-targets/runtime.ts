import type { ChildProcess, SpawnOptions } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync as nodeExistsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path, { posix, win32 } from "node:path";
import { app, shell } from "electron";

import type { EditorTargetIcon, EditorTargetRuntime } from "./target.js";

interface SpawnedProcess {
  once(event: "error", handler: (error: Error) => void): SpawnedProcess;
  once(event: "spawn", handler: () => void): SpawnedProcess;
  unref(): void;
}

export interface RecordedEditorLaunch {
  command: string;
  args: string[];
  options: SpawnOptions;
}

export interface EditorTargetRuntimeOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  pathExists?: (path: string) => boolean;
  spawn?: (command: string, args: string[], options: SpawnOptions) => SpawnedProcess;
  openPath?: (path: string) => Promise<string>;
  revealPath?: (path: string) => void;
  loadIcon?: (fileName: string) => Promise<EditorTargetIcon>;
  homeDirectory?: string;
}

const RUNTIME_CONTROL_ENV_KEYS = [
  "PASEO_NODE_ENV",
  "PASEO_DESKTOP_MANAGED",
  "PASEO_SUPERVISED",
  "ELECTRON_RUN_AS_NODE",
  "ELECTRON_NO_ATTACH_CONSOLE",
] as const;

function createExternalProcessEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  for (const key of RUNTIME_CONTROL_ENV_KEYS) {
    delete env[key];
  }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete env[key];
    }
  }
  return env;
}

function isAbsolutePath(value: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" ? win32.isAbsolute(value) : posix.isAbsolute(value);
}

function resolveExecutable(
  commands: readonly string[],
  input: {
    env: NodeJS.ProcessEnv;
    pathExists: (path: string) => boolean;
    platform: NodeJS.Platform;
  },
): string | null {
  for (const command of commands) {
    if (isAbsolutePath(command, input.platform) && input.pathExists(command)) {
      return command;
    }

    const pathValue = input.env.PATH ?? input.env.Path ?? input.env.path ?? "";
    const pathDelimiter = input.platform === "win32" ? ";" : ":";
    for (const directory of pathValue.split(pathDelimiter)) {
      if (!directory) continue;
      const candidate = `${directory}/${command}`;
      if (input.platform !== "win32") {
        if (input.pathExists(candidate)) return candidate;
        continue;
      }

      const hasExtension = Boolean(win32.extname(command));
      const extensions = hasExtension ? [""] : [".exe", ".cmd", ".bat", ".com", ""];
      for (const extension of extensions) {
        const windowsCandidate = `${candidate}${extension}`;
        if (input.pathExists(windowsCandidate)) return windowsCandidate;
      }
    }
  }
  return null;
}

function isWindowsCommandScript(executable: string, platform: NodeJS.Platform): boolean {
  if (platform !== "win32") return false;
  const extension = win32.extname(executable).toLowerCase();
  return extension === ".cmd" || extension === ".bat";
}

function escapeWindowsCmdValue(value: string): string {
  const isQuoted = value.startsWith('"') && value.endsWith('"');
  const unquoted = isQuoted ? value.slice(1, -1) : value;
  if (!isQuoted && !/[\s"&|^<>()!]/u.test(unquoted)) return unquoted;

  const quoted = unquoted
    .replace(/(\\*)"/g, (_match, slashes: string) => `${slashes}${slashes}\\"`)
    .replace(/\\+$/u, (slashes) => `${slashes}${slashes}`);
  return `"${quoted}"`;
}

function spawnProcess(command: string, args: string[], options: SpawnOptions): SpawnedProcess {
  return nodeSpawn(command, args, options) as ChildProcess as SpawnedProcess;
}

function iconPath(fileName: string): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "editor-target-icons", fileName);
  }
  return path.resolve(__dirname, "../../../assets/editor-targets", fileName);
}

async function loadBundledIcon(fileName: string): Promise<EditorTargetIcon> {
  const bytes = await readFile(iconPath(fileName));
  return { kind: "image", dataUrl: `data:image/png;base64,${bytes.toString("base64")}` };
}

export function createEditorTargetRuntime(
  options: EditorTargetRuntimeOptions = {},
): EditorTargetRuntime {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const pathExists = options.pathExists ?? nodeExistsSync;
  const spawn = options.spawn ?? spawnProcess;
  const openPath = options.openPath ?? ((targetPath) => shell.openPath(targetPath));
  const revealPath = options.revealPath ?? ((targetPath) => shell.showItemInFolder(targetPath));
  const loadIcon = options.loadIcon ?? loadBundledIcon;
  const homeDirectory = options.homeDirectory ?? os.homedir();

  return {
    platform,
    env,
    pathExists,
    isAbsolutePath: (targetPath) => isAbsolutePath(targetPath, platform),
    resolveCommand: (commands) => resolveExecutable(commands, { env, pathExists, platform }),
    async spawnDetached({ command, args }) {
      const commandScript = isWindowsCommandScript(command, platform);
      const launchCommand = commandScript ? escapeWindowsCmdValue(command) : command;
      const launchArgs = commandScript ? args.map(escapeWindowsCmdValue) : [...args];
      await new Promise<void>((resolve, reject) => {
        let child: SpawnedProcess;
        try {
          child = spawn(launchCommand, launchArgs, {
            detached: true,
            env: createExternalProcessEnv(env),
            shell: commandScript,
            stdio: "ignore",
          });
        } catch (error) {
          reject(error);
          return;
        }
        child.once("error", reject);
        child.once("spawn", () => {
          child.unref();
          resolve();
        });
      });
    },
    async openPath(targetPath) {
      const errorMessage = await openPath(targetPath);
      if (errorMessage) throw new Error(errorMessage);
    },
    revealPath,
    loadIcon,
    hasMacApplication(applicationName) {
      if (platform !== "darwin") return false;
      return [
        `/Applications/${applicationName}.app`,
        `${homeDirectory}/Applications/${applicationName}.app`,
        `/System/Applications/${applicationName}.app`,
      ].some(pathExists);
    },
    async openMacApplication({ applicationName, paths }) {
      await this.spawnDetached({
        command: "/usr/bin/open",
        args: ["-a", applicationName, ...paths],
      });
    },
  };
}
