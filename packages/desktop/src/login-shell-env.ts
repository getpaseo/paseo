// Shell environment resolution adapted from VS Code
// https://github.com/microsoft/vscode/blob/main/src/vs/platform/shell/node/shellEnv.ts
// Licensed under the MIT License.

import defaultLog from "electron-log/main";
import {
  inheritLoginShellEnv as inheritLoginShellEnvCore,
  type LoginShellEnvLogger,
} from "@getpaseo/server";

type LoginShellEnvDependencies = Omit<
  NonNullable<Parameters<typeof inheritLoginShellEnvCore>[0]>,
  "logger"
> & {
  logger?: LoginShellEnvLogger;
};

/**
 * On macOS/Linux, Electron inherits a minimal environment when launched from
 * Finder/Dock. Spawn the user's login shell and capture its full environment
 * via Node's JSON.stringify(process.env), so the daemon and all child processes
 * see the same tools and variables as a normal terminal session.
 *
 * Approach borrowed from VS Code (src/vs/platform/shell/node/shellEnv.ts).
 * The implementation lives in @getpaseo/server so the daemon can apply the
 * same resolution when it is launched without the desktop app.
 */
export function inheritLoginShellEnv(input: LoginShellEnvDependencies = {}): void {
  inheritLoginShellEnvCore({ ...input, logger: input.logger ?? defaultLog });
}
