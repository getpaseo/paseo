import { describe, expect, it } from "vitest";

import { buildStringCommandShellInvocation } from "./string-command-shell.js";

describe("buildStringCommandShellInvocation", () => {
  it("uses bash login-command semantics on unix platforms", () => {
    expect(
      buildStringCommandShellInvocation({
        command: 'echo "hello"',
        platform: "darwin",
      }),
    ).toEqual({
      shell: "/bin/bash",
      args: ["-lc", 'echo "hello"'],
    });
  });

  it("uses powershell command semantics on windows", () => {
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
});
