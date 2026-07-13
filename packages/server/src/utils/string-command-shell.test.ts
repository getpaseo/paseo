import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildStringCommandShellInvocation,
  createStringCommandShellEnv,
} from "./string-command-shell.js";

function hasBashOnPath(): boolean {
  const result = spawnSync("bash", ["-c", "true"], { stdio: "ignore" });
  return !result.error && result.status === 0;
}

describe("buildStringCommandShellInvocation", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it("uses bash script semantics on unix platforms", () => {
    expect(
      buildStringCommandShellInvocation({
        command: 'echo "hello"',
        platform: "darwin",
      }),
    ).toEqual({
      shell: "bash",
      args: ["-c", 'echo "hello"'],
    });
  });

  it.skipIf(process.platform === "win32" || !hasBashOnPath())(
    "preserves the supplied PATH when login profiles rewrite it",
    () => {
      const home = mkdtempSync(join(tmpdir(), "paseo-shell-home-"));
      tempDirs.push(home);
      const binDir = join(home, "bin");
      mkdirSync(binDir);

      const shimPath = join(binDir, "paseo-shim");
      writeFileSync(shimPath, "#!/bin/sh\nprintf 'shim:%s\\n' \"$1\"\n");
      chmodSync(shimPath, 0o755);
      writeFileSync(join(home, ".bash_profile"), "export PATH=/usr/bin:/bin\n");
      const bashEnvPath = join(home, "bash-env");
      writeFileSync(bashEnvPath, "export PATH=/usr/bin:/bin\n");

      const invocation = buildStringCommandShellInvocation({
        command: "command -v paseo-shim >/dev/null && paseo-shim ok",
      });
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: home,
        PATH: `${binDir}${delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`,
        BASH_ENV: bashEnvPath,
      };

      const stdout = execFileSync(invocation.shell, invocation.args, {
        encoding: "utf8",
        env: createStringCommandShellEnv(env),
      });

      expect(stdout.trim()).toBe("shim:ok");
    },
  );

  it("uses powershell command semantics on windows by default", () => {
    expect(
      buildStringCommandShellInvocation({
        command: "Write-Output 'hello'",
        platform: "win32",
      }),
    ).toEqual({
      shell: "powershell",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "Write-Output 'hello'",
      ],
    });
  });

  it("can preserve cmd command semantics on windows", () => {
    expect(
      buildStringCommandShellInvocation({
        command: "echo %TEMP% && echo ok",
        platform: "win32",
        windowsShell: "cmd",
      }),
    ).toEqual({
      shell: "cmd.exe",
      args: ["/c", "echo %TEMP% && echo ok"],
    });
  });
});
