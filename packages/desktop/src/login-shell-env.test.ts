import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { inheritLoginShellEnv } from "./login-shell-env";

const zsh = "/bin/zsh";
const describeIfZsh = existsSync(zsh) ? describe : describe.skip;
const basePath = "/usr/bin:/bin:/usr/sbin:/sbin";

interface RecordedLog {
  message: string;
  fields: Record<string, unknown>;
}

class RecordingLoginShellLogger {
  readonly infos: RecordedLog[] = [];
  readonly warnings: RecordedLog[] = [];

  info(message: string, fields: Record<string, unknown>): void {
    this.infos.push({ message, fields });
  }

  warn(message: string, fields: Record<string, unknown>): void {
    this.warnings.push({ message, fields });
  }
}

describeIfZsh("desktop login shell env wrapper", () => {
  const homes = new Set<string>();

  afterEach(async () => {
    await Promise.all([...homes].map((home) => rm(home, { recursive: true, force: true })));
    homes.clear();
  });

  it("resolves the login shell env with the default logger", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "paseo-desktop-login-shell-env-"));
    homes.add(home);
    const binDir = path.join(home, "tools");
    await mkdir(binDir);
    await writeFile(path.join(home, ".zprofile"), 'export PATH="$HOME/tools:$PATH"\n');
    const env: NodeJS.ProcessEnv = {
      HOME: home,
      USER: "paseo-test",
      LOGNAME: "paseo-test",
      SHELL: zsh,
      PATH: basePath,
    };

    // No logger passed: the wrapper must fall back to electron-log without throwing.
    inheritLoginShellEnv({ env });

    expect(env.PATH?.split(path.delimiter)[0]).toBe(binDir);
  });

  it("forwards an explicit logger to the core implementation", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "paseo-desktop-login-shell-env-"));
    homes.add(home);
    const env: NodeJS.ProcessEnv = {
      HOME: home,
      USER: "paseo-test",
      LOGNAME: "paseo-test",
      SHELL: zsh,
      PATH: basePath,
    };
    const logger = new RecordingLoginShellLogger();

    inheritLoginShellEnv({ env, logger });

    expect(logger.infos.map((entry) => entry.message)).toEqual([
      "[login-shell-env] start",
      "[login-shell-env] attempt applied",
      "[login-shell-env] applied",
    ]);
    expect(logger.warnings).toEqual([]);
  });
});
