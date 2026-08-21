import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import {
  buildWorktreeLifecycleScript,
  buildWorktreeLifecycleShellInvocation,
  createWorktreeLifecycleOutputParser,
  resolveWorktreeLifecycleShell,
} from "./worktree-lifecycle-shell.js";
import type { WorktreeSetupCommandProgressEvent } from "./worktree.js";

function hasCommandOnPath(command: string): boolean {
  const result = spawnSync(command, ["-c", "true"], { stdio: "ignore" });
  return !result.error && result.status === 0;
}

const bashAvailable = hasCommandOnPath("bash");
const fishAvailable = hasCommandOnPath("fish");

describe("resolveWorktreeLifecycleShell", () => {
  it("returns null when SHELL is unset", () => {
    expect(resolveWorktreeLifecycleShell({})).toBeNull();
  });

  it("returns null for unrecognized shells", () => {
    expect(resolveWorktreeLifecycleShell({ SHELL: "/bin/dash" })).toBeNull();
    expect(resolveWorktreeLifecycleShell({ SHELL: "/bin/tcsh" })).toBeNull();
  });

  it("recognizes zsh", () => {
    expect(resolveWorktreeLifecycleShell({ SHELL: "/bin/zsh" })).toEqual({
      shell: "/bin/zsh",
      dialect: "zsh",
    });
  });

  it("recognizes bash", () => {
    expect(resolveWorktreeLifecycleShell({ SHELL: "/opt/homebrew/bin/bash" })).toEqual({
      shell: "/opt/homebrew/bin/bash",
      dialect: "bash",
    });
  });

  it("recognizes fish", () => {
    expect(resolveWorktreeLifecycleShell({ SHELL: "/usr/local/bin/fish" })).toEqual({
      shell: "/usr/local/bin/fish",
      dialect: "fish",
    });
  });
});

describe("buildWorktreeLifecycleShellInvocation", () => {
  it("invokes the resolved shell as login and interactive", () => {
    expect(buildWorktreeLifecycleShellInvocation({ shell: "/bin/zsh", script: "echo hi" })).toEqual(
      {
        shell: "/bin/zsh",
        args: ["-i", "-l", "-c", "echo hi"],
      },
    );
  });
});

describe("buildWorktreeLifecycleScript", () => {
  it("omits the PATH preamble when no original PATH is supplied", () => {
    const { script } = buildWorktreeLifecycleScript({
      commands: ["true"],
      originalPath: undefined,
      dialect: "bash",
    });
    expect(script).not.toContain("export PATH=");
  });

  it("generates a distinct marker token per call", () => {
    const first = buildWorktreeLifecycleScript({
      commands: ["true"],
      originalPath: undefined,
      dialect: "bash",
    });
    const second = buildWorktreeLifecycleScript({
      commands: ["true"],
      originalPath: undefined,
      dialect: "bash",
    });
    expect(first.markerToken).not.toBe(second.markerToken);
    expect(first.markerToken).toMatch(/^__paseo_lifecycle_[0-9a-f]+__$/);
  });

  it("stops after the first non-zero exit (bash/zsh dialect)", () => {
    const { script } = buildWorktreeLifecycleScript({
      commands: ["true", "false"],
      originalPath: undefined,
      dialect: "bash",
    });
    expect(script).toContain('if [ "$__paseo_lifecycle_status" -ne 0 ]; then exit');
  });

  it("stops after the first non-zero exit (fish dialect)", () => {
    const { script } = buildWorktreeLifecycleScript({
      commands: ["true", "false"],
      originalPath: undefined,
      dialect: "fish",
    });
    expect(script).toContain('if test "$__paseo_lifecycle_status" -ne 0');
    expect(script).not.toContain("export PATH=");
  });

  it("uses fish's list-valued PATH syntax instead of a colon-joined string", () => {
    const { script } = buildWorktreeLifecycleScript({
      commands: ["true"],
      originalPath: "/from/daemon",
      dialect: "fish",
    });
    expect(script).toContain("set -gx PATH $PATH (string split ':' -- '/from/daemon')");
  });

  it.skipIf(!bashAvailable)(
    "appends the daemon's original PATH after whatever the script body sets, safely quoted (bash)",
    () => {
      const originalPath = "/from/daemon:/also with a ' quote";
      // Starting PATH stands in for "whatever the profile left PATH as" —
      // real bash must still be resolvable to spawn it at all, so prepend a
      // marker directory to the real PATH rather than replacing it outright.
      const startingPath = `/from/profile:${process.env.PATH ?? ""}`;
      const { script } = buildWorktreeLifecycleScript({
        commands: [`printf '%s' "$PATH"`],
        originalPath,
        dialect: "bash",
      });
      const result = spawnSync("bash", ["-c", script], {
        encoding: "utf8",
        env: { PATH: startingPath },
      });
      expect(result.status).toBe(0);
      // The last marker-delimited stdout segment is the printf output; strip
      // marker lines to isolate it.
      const contentLines = (result.stdout ?? "")
        .split("\n")
        .filter((line) => !line.includes("__paseo_lifecycle_"));
      expect(contentLines.join("")).toBe(`${startingPath}:${originalPath}`);
    },
  );

  it.skipIf(!fishAvailable)(
    "appends the daemon's original PATH after whatever the script body sets, safely quoted (fish)",
    () => {
      const originalPath = "/from/daemon:/also with a ' quote";
      const startingPath = `/from/profile:${process.env.PATH ?? ""}`;
      const { script } = buildWorktreeLifecycleScript({
        commands: [`printf '%s' "$PATH"`],
        originalPath,
        dialect: "fish",
      });
      const result = spawnSync("fish", ["-c", script], {
        encoding: "utf8",
        env: { PATH: startingPath },
      });
      expect(result.status).toBe(0);
      const contentLines = (result.stdout ?? "")
        .split("\n")
        .filter((line) => !line.includes("__paseo_lifecycle_"));
      expect(contentLines.join("")).toBe(`${startingPath}:${originalPath}`);
    },
  );
});

describe("createWorktreeLifecycleOutputParser", () => {
  const DIALECTS: Array<{
    label: string;
    dialect: "bash" | "fish";
    shell: string;
    available: boolean;
  }> = [
    { label: "bash", dialect: "bash", shell: "bash", available: bashAvailable },
    { label: "fish", dialect: "fish", shell: "fish", available: fishAvailable },
  ];

  function runScript(dialect: "bash" | "fish", shell: string, commands: string[]) {
    const { script, markerToken } = buildWorktreeLifecycleScript({
      commands,
      originalPath: undefined,
      dialect,
    });
    const result = spawnSync(shell, ["-c", script], {
      encoding: "utf8",
      env: process.env,
    });
    return { result, markerToken };
  }

  function extractEventTypes(events: WorktreeSetupCommandProgressEvent[]): string[] {
    return events.map((event) => event.type);
  }

  for (const { label, dialect, shell, available } of DIALECTS) {
    it.skipIf(!available)(
      `[${label}] reconstructs one result per command from a single shell process`,
      () => {
        const { result, markerToken } = runScript(dialect, shell, [
          'echo "one stdout"',
          'echo "two stdout"; echo "two stderr" 1>&2',
        ]);
        expect(result.status).toBe(0);

        const parser = createWorktreeLifecycleOutputParser({
          markerToken,
          commands: ["cmd1", "cmd2"],
          cwd: "/worktree",
        });
        parser.feed("stdout", result.stdout ?? "");
        parser.feed("stderr", result.stderr ?? "");
        const results = parser.finalize(result.status ?? null);

        expect(results).toHaveLength(2);
        expect(results[0]).toMatchObject({ command: "cmd1", cwd: "/worktree", exitCode: 0 });
        expect(results[0]?.stdout).toContain("one stdout");
        expect(results[1]).toMatchObject({ command: "cmd2", cwd: "/worktree", exitCode: 0 });
        expect(results[1]?.stdout).toContain("two stdout");
        expect(results[1]?.stderr).toContain("two stderr");
      },
    );

    it.skipIf(!available)(
      `[${label}] stops at the first failing command and never reports later entries`,
      () => {
        const { result, markerToken } = runScript(dialect, shell, [
          "true",
          "exit 7",
          "echo should-not-run",
        ]);
        expect(result.status).toBe(7);

        const parser = createWorktreeLifecycleOutputParser({
          markerToken,
          commands: ["cmd1", "cmd2", "cmd3"],
          cwd: "/worktree",
        });
        parser.feed("stdout", result.stdout ?? "");
        parser.feed("stderr", result.stderr ?? "");
        const results = parser.finalize(result.status ?? null);

        expect(results).toHaveLength(2);
        expect(results[0]?.exitCode).toBe(0);
        expect(results[1]?.exitCode).toBe(7);
      },
    );

    it.skipIf(!available)(
      `[${label}] emits command_started, output, and command_completed events in order`,
      () => {
        const { result, markerToken } = runScript(dialect, shell, ['echo "hello"']);
        const parser = createWorktreeLifecycleOutputParser({
          markerToken,
          commands: ["cmd1"],
          cwd: "/worktree",
        });
        const events: WorktreeSetupCommandProgressEvent[] = [
          ...parser.feed("stdout", result.stdout ?? ""),
          ...parser.feed("stderr", result.stderr ?? ""),
        ];
        expect(extractEventTypes(events)).toEqual([
          "command_started",
          "output",
          "command_completed",
        ]);
      },
    );

    it.skipIf(!available)(
      `[${label}] produces identical results whether output is fed whole or split into arbitrary chunks`,
      () => {
        const { result, markerToken } = runScript(dialect, shell, [
          'echo "first"',
          'echo "second"; echo "second-err" 1>&2',
        ]);

        const wholeParser = createWorktreeLifecycleOutputParser({
          markerToken,
          commands: ["cmd1", "cmd2"],
          cwd: "/worktree",
        });
        wholeParser.feed("stdout", result.stdout ?? "");
        wholeParser.feed("stderr", result.stderr ?? "");
        const wholeResults = wholeParser.finalize(result.status ?? null);

        const chunkedParser = createWorktreeLifecycleOutputParser({
          markerToken,
          commands: ["cmd1", "cmd2"],
          cwd: "/worktree",
        });
        for (const char of result.stdout ?? "") {
          chunkedParser.feed("stdout", char);
        }
        for (const char of result.stderr ?? "") {
          chunkedParser.feed("stderr", char);
        }
        const chunkedResults = chunkedParser.finalize(result.status ?? null);

        expect(chunkedResults).toEqual(wholeResults);
      },
    );
  }

  it("defers command_started until the previous command's stderr also closes", () => {
    // stdout and stderr are independent pipes: stdout can deliver command 2's
    // START marker before stderr delivers command 1's END marker, even
    // though the script writes them in that order. The live timeline must
    // not show both commands "running" at once in that case.
    const parser = createWorktreeLifecycleOutputParser({
      markerToken: "MARK",
      commands: ["cmd1", "cmd2"],
      cwd: "/worktree",
    });

    const stdoutEvents = [
      ...parser.feed("stdout", "MARK|START|1\n"),
      ...parser.feed("stdout", "line-one\n"),
      ...parser.feed("stdout", "MARK|END|1|0\n"),
      ...parser.feed("stdout", "MARK|START|2\n"),
    ];
    expect(stdoutEvents.map((event) => event.type)).toEqual(["command_started", "output"]);

    const stderrEvents = parser.feed("stderr", "MARK|END|1|0\n");
    expect(stderrEvents.map((event) => event.type)).toEqual([
      "command_completed",
      "command_started",
    ]);
    expect(stderrEvents[0]).toMatchObject({ index: 1, exitCode: 0 });
    expect(stderrEvents[1]).toMatchObject({ index: 2, command: "cmd2" });
  });

  it("surfaces a shell that never reaches the first marker as command 1 failing", () => {
    const parser = createWorktreeLifecycleOutputParser({
      markerToken: "__paseo_lifecycle_test__",
      commands: ["cmd1", "cmd2"],
      cwd: "/worktree",
    });
    parser.feed("stderr", "zsh: command not found: oh-my-zsh\n");
    const results = parser.finalize(127);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      command: "cmd1",
      cwd: "/worktree",
      exitCode: 127,
    });
    expect(results[0]?.stderr).toContain("command not found");
  });

  it("returns an empty array when there were no commands and no output", () => {
    const parser = createWorktreeLifecycleOutputParser({
      markerToken: "__paseo_lifecycle_test__",
      commands: [],
      cwd: "/worktree",
    });
    expect(parser.finalize(0)).toEqual([]);
  });
});
