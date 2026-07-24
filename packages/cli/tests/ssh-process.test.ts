import { describe, expect, it } from "vitest";
import { buildSshBaseArgs } from "../src/ssh/ssh-process.js";
import {
  buildEnsureScript,
  ensureRemoteDaemon,
  remoteExpandHome,
  remoteHomePath,
  remoteInstallPath,
  remotePaseoBin,
  type EnsureRemoteDaemonOptions,
  type SshExecResult,
} from "../src/ssh/remote-daemon.js";
import { normalizeSshHostConfig, type SshHostConfig } from "../src/ssh/ssh-host-config.js";
function makeConfig(overrides: Partial<SshHostConfig> = {}): SshHostConfig {
  return normalizeSshHostConfig({
    id: "myhost",
    host: "server.example.com",
    user: "alice",
    ...overrides,
  });
}

describe("ssh-process: buildSshBaseArgs", () => {
  it("includes port, BatchMode, host key, and user@host", () => {
    const args = buildSshBaseArgs(makeConfig());
    expect(args).toContain("-p");
    expect(args).toContain("22");
    expect(args).toContain("BatchMode=yes");
    expect(args).toContain("StrictHostKeyChecking=accept-new");
    expect(args).toContain("alice@server.example.com");
  });

  it("uses the configured SSH port", () => {
    const args = buildSshBaseArgs(makeConfig({ port: 2222 }));
    expect(args).toContain("2222");
  });
});

describe("remote-daemon: path helpers", () => {
  it("expands ~ to $HOME", () => {
    expect(remoteExpandHome("~")).toBe("$HOME");
    expect(remoteExpandHome("~/foo")).toBe("$HOME/foo");
    expect(remoteExpandHome("/abs/path")).toBe("/abs/path");
  });

  it("derives remote home and install paths", () => {
    const config = makeConfig();
    expect(remoteHomePath(config)).toBe("$HOME/.paseo");
    expect(remoteInstallPath(config)).toBe("$HOME/.paseo/cli");
  });

  it("derives the paseo bin path", () => {
    const config = makeConfig();
    expect(remotePaseoBin(config)).toBe('"$HOME/.paseo/cli/node_modules/.bin/paseo"');
  });
});
describe("remote-daemon: buildEnsureScript", () => {
  it("includes port check, node check, install, launch, and ready wait", () => {
    const config = makeConfig({ remotePort: 6767 });
    const script = buildEnsureScript(config, "1.2.3");
    expect(script).toContain("6767");
    expect(script).toContain("node -e");
    expect(script).toContain("node -v");
    expect(script).toContain("npm -v");
    expect(script).toContain("npm install");
    expect(script).toContain("@getpaseo/cli@1.2.3");
    expect(script).toContain("$HOME/.paseo/cli");
    expect(script).toContain("daemon start");
    expect(script).toContain("--no-relay");
    expect(script).toContain("--no-mcp");
    expect(script).toContain("$HOME/.paseo");
    expect(script).toContain("PROGRESS:");
  });

  it("uses latest when version is empty", () => {
    const config = makeConfig();
    const script = buildEnsureScript(config, "");
    expect(script).toContain("@getpaseo/cli");
    expect(script).not.toContain("@getpaseo/cli@");
  });
});

/** A sequential fake exec: returns responses in order, matching by pattern. */
function fakeExec(
  responses: { command: RegExp; result: Partial<SshExecResult> }[],
): (command: string) => Promise<SshExecResult> {
  let index = 0;
  return async (command: string) => {
    const entry = responses[index];
    index += 1;
    if (!entry || !entry.command.test(command)) {
      throw new Error(
        `Unexpected exec #${index} (expected ${entry?.command?.source ?? "end"}): ${command}`,
      );
    }
    return {
      stdout: "",
      stderr: "",
      exitCode: null,
      signal: null,
      timedOut: false,
      ...entry.result,
    };
  };
}

function makeEnsureOptions(
  exec: (command: string) => Promise<SshExecResult>,
  overrides: Partial<EnsureRemoteDaemonOptions> = {},
): EnsureRemoteDaemonOptions {
  return {
    config: makeConfig(),
    exec,
    ...overrides,
  };
}

describe("remote-daemon: ensureRemoteDaemon", () => {
  it("returns ready when the script exits 0 (daemon already running)", async () => {
    const exec = fakeExec([
      {
        command: /.*/,
        result: { exitCode: 0, stderr: "PROGRESS:Remote daemon is already running.\n" },
      },
    ]);
    const result = await ensureRemoteDaemon(makeEnsureOptions(exec));
    expect(result).toEqual({ installed: false, launched: false, ready: true });
  });

  it("returns ready when the script exits 0 after install and launch", async () => {
    const exec = fakeExec([
      {
        command: /.*/,
        result: {
          exitCode: 0,
          stderr: "PROGRESS:Installing Paseo…\nPROGRESS:Remote daemon is ready.\n",
        },
      },
    ]);
    const result = await ensureRemoteDaemon(makeEnsureOptions(exec));
    expect(result).toEqual({ installed: false, launched: false, ready: true });
  });

  it("throws when node is missing (exit 10)", async () => {
    const exec = fakeExec([{ command: /.*/, result: { exitCode: 10 } }]);
    await expect(ensureRemoteDaemon(makeEnsureOptions(exec))).rejects.toThrow(/Node.js/);
  });

  it("throws when install fails (exit 11)", async () => {
    const exec = fakeExec([{ command: /.*/, result: { exitCode: 11, stderr: "npm ERR\n" } }]);
    await expect(ensureRemoteDaemon(makeEnsureOptions(exec))).rejects.toThrow(/Failed to install/);
  });

  it("throws when daemon does not become ready (exit 12)", async () => {
    const exec = fakeExec([{ command: /.*/, result: { exitCode: 12 } }]);
    await expect(ensureRemoteDaemon(makeEnsureOptions(exec))).rejects.toThrow(
      /did not become ready/,
    );
  });

  it("throws SSH auth error when permission denied (exit 255)", async () => {
    const exec = fakeExec([
      { command: /.*/, result: { exitCode: 255, stderr: "Permission denied (publickey).\n" } },
    ]);
    await expect(ensureRemoteDaemon(makeEnsureOptions(exec))).rejects.toThrow(
      /SSH connection to .* failed: Permission denied/,
    );
  });

  it("throws on unexpected exit code", async () => {
    const exec = fakeExec([{ command: /.*/, result: { exitCode: 99, stderr: "weird\n" } }]);
    await expect(ensureRemoteDaemon(makeEnsureOptions(exec))).rejects.toThrow(/Failed to ensure/);
  });

  it("reports progress from stderr PROGRESS: lines", async () => {
    const messages: string[] = [];
    const exec = fakeExec([
      {
        command: /.*/,
        result: { exitCode: 0, stderr: "PROGRESS:Remote daemon is already running.\n" },
      },
    ]);
    await ensureRemoteDaemon({
      ...makeEnsureOptions(exec),
      onProgress: (m) => messages.push(m),
    });
    expect(messages).toContain("Remote daemon is already running.");
  });
});
