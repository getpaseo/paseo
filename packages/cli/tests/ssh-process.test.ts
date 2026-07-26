import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSshBaseArgs, createTerminalAskpassScript } from "../src/ssh/ssh-process.js";
import {
  ASKPASS_CANCELLED_MARKER,
  ENSURE_EXIT,
  READY_MARKER,
  REMOTE_SHELL_COMMAND,
  buildEnsureScript,
  describeEnsureFailure,
  describeSshFailure,
  remoteExpandHome,
  remoteHomePath,
  remoteInstallPath,
  shellPath,
  shellQuote,
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
  it("includes BatchMode, host key policy, keepalives, and user@host", () => {
    const args = buildSshBaseArgs(makeConfig());
    expect(args).toContain("BatchMode=yes");
    expect(args).toContain("StrictHostKeyChecking=accept-new");
    expect(args).toContain("ServerAliveInterval=15");
    expect(args).toContain("ServerAliveCountMax=3");
    expect(args).toContain("alice@server.example.com");
  });

  it("omits -p entirely when no port is configured so ~/.ssh/config wins", () => {
    expect(buildSshBaseArgs(makeConfig())).not.toContain("-p");
  });

  it("passes -p only when the port was set explicitly", () => {
    const args = buildSshBaseArgs(makeConfig({ port: 2222 }));
    expect(args[args.indexOf("-p") + 1]).toBe("2222");
  });

  it("drops BatchMode when an askpass program can answer the prompt", () => {
    const args = buildSshBaseArgs(makeConfig(), { askpassPath: "/tmp/askpass.sh" });
    expect(args).not.toContain("BatchMode=yes");
  });

  it("leaves the retry count alone so a typo stays retryable", () => {
    // Cancellation is handled by the askpass marker instead, so there is no
    // need to spend the user's retries to make Cancel work.
    const args = buildSshBaseArgs(makeConfig(), { askpassPath: "/tmp/askpass.sh" });
    expect(args.join(" ")).not.toContain("NumberOfPasswordPrompts");
  });
});

describe("remote-daemon: shell quoting", () => {
  it("neutralizes quotes, expansions, and backticks", () => {
    expect(shellQuote("plain")).toBe("'plain'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote("$(id)`id`")).toBe("'$(id)`id`'");
  });

  it("expands a leading tilde but quotes the rest of the path", () => {
    expect(shellPath("~")).toBe(`"$HOME"`);
    expect(shellPath("~/.paseo")).toBe(`"$HOME"/'.paseo'`);
    expect(shellPath("/opt/p aseo")).toBe("'/opt/p aseo'");
  });

  it("expands ~ to $HOME for display paths", () => {
    expect(remoteExpandHome("~")).toBe("$HOME");
    expect(remoteExpandHome("~/foo")).toBe("$HOME/foo");
    expect(remoteExpandHome("/abs/path")).toBe("/abs/path");
  });

  it("derives remote home and install paths", () => {
    const config = makeConfig();
    expect(remoteHomePath(config)).toBe("$HOME/.paseo");
    expect(remoteInstallPath(config)).toBe("$HOME/.paseo/cli");
  });
});

/**
 * Run a generated script the way the tunnel does: piped into a bare `sh` over
 * stdin, exactly as `REMOTE_SHELL_COMMAND` arranges on the remote host.
 * spawnSync closes stdin once the script is written, which stands in for the
 * tunnel tearing the connection down.
 */
function runEnsureScript(
  script: string,
  options: { path: string; home?: string },
): { status: number | null; stderr: string } {
  const result = spawnSync("sh", {
    encoding: "utf8",
    input: script,
    timeout: 30_000,
    env: { PATH: options.path, HOME: options.home ?? tmpdir() },
  });
  return { status: result.status, stderr: result.stderr };
}

/**
 * A PATH directory holding real coreutils plus the given stubs, so the ensure
 * script runs for real against a controlled idea of what the "remote" host has
 * installed.
 */
function makeBinDir(stubs: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "paseo-bin-"));
  for (const tool of ["sh", "sleep", "mkdir", "printf", "echo", "cat", "true", "rm"]) {
    if (stubs[tool]) continue;
    const resolved = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" });
    const target = resolved.stdout.trim();
    if (target) symlinkSync(target, path.join(dir, tool));
  }
  for (const [name, body] of Object.entries(stubs)) {
    writeFileSync(path.join(dir, name), body, { mode: 0o755 });
  }
  return dir;
}

describe("remote-daemon: buildEnsureScript", () => {
  it("is valid POSIX shell", () => {
    const script = buildEnsureScript(makeConfig(), "1.2.3");
    const result = spawnSync("sh", ["-n"], { input: script, encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("covers check, install, launch, and readiness wait", () => {
    const script = buildEnsureScript(makeConfig({ remotePort: 6767 }), "1.2.3");
    expect(script).toContain("6767");
    expect(script).toContain("command -v paseo");
    expect(script).toContain("npm install");
    expect(script).toContain("@getpaseo/cli@$paseo_want");
    expect(script).toContain("daemon start");
    expect(script).toContain("--no-relay");
    expect(script).toContain("--no-mcp");
    expect(script).toContain(READY_MARKER);
  });

  it("holds the connection open by falling through, with no keepalive command", () => {
    // The script arrives on the remote sh's stdin, so running off the end
    // leaves sh blocked for more input. `sleep infinity` (rejected by BusyBox
    // and older BSD sleep) and `cat` are both unnecessary.
    const script = buildEnsureScript(makeConfig(), "1.2.3");
    expect(script).not.toContain("sleep infinity");
    expect(script).not.toContain("exec cat");
    expect(script.trimEnd().endsWith("[ $paseo_rc -eq 0 ] || exit $paseo_rc")).toBe(true);
  });

  it("propagates the ensure exit code instead of collapsing it to 1", () => {
    const script = buildEnsureScript(makeConfig(), "1.2.3");
    expect(script).toContain("exit $paseo_rc");
  });

  it("closes stdin for children that could otherwise swallow the script", () => {
    // The script is on stdin; a child inheriting it and reading would eat the
    // remainder of the script.
    const script = buildEnsureScript(makeConfig(), "1.2.3");
    for (const line of script.split("\n")) {
      if (line.includes("npm install") || line.includes("daemon start")) {
        expect(line).toContain("</dev/null");
      }
    }
  });

  it("neutralizes shell metacharacters in host paths", () => {
    const script = buildEnsureScript(
      makeConfig({ installDir: "~/a'b", remoteHome: "~/$(touch /tmp/pwned)" }),
      "1.2.3",
    );
    expect(spawnSync("sh", ["-n"], { input: script, encoding: "utf8" }).status).toBe(0);
    // Inside single quotes the expansion is inert.
    expect(script).toContain(`"$HOME"/'$(touch /tmp/pwned)'`);
  });

  it("defaults to latest when no version is given", () => {
    const script = buildEnsureScript(makeConfig(), "");
    expect(script).toContain("paseo_want='latest'");
  });

  it("only falls back to latest when a specific version was requested", () => {
    expect(buildEnsureScript(makeConfig(), "1.2.3")).toContain("@getpaseo/cli@latest");
    // Already asking for latest: a second attempt would be pointless.
    expect(buildEnsureScript(makeConfig(), "latest")).toContain('[ "$paseo_want" = latest ]');
  });
});

/**
 * These run the generated script through a real `sh` against stubbed
 * executables. Asserting on the emitted markers and exit codes is what proves
 * the contract the tunnel depends on, which string matching on the script
 * source cannot.
 */
describe("remote-daemon: keepalive over stdin", () => {
  it("keeps the shell alive after a successful run and exits when stdin closes", async () => {
    // The whole port forward depends on this: the remote shell must still be
    // running once the script succeeds, and must exit when we close stdin.
    const bin = makeBinDir({ node: `#!/bin/sh\nexit 0\n` });
    // `sh -c "exec /bin/sh"` is what sshd does with REMOTE_SHELL_COMMAND.
    const child = spawn("sh", ["-c", REMOTE_SHELL_COMMAND], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: bin, HOME: tmpdir() },
    });
    const exited = new Promise<number | null>((resolve) => {
      child.once("close", (code) => resolve(code));
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.stdin.write(`${buildEnsureScript(makeConfig(), "1.2.3")}\n`);
    await vi.waitFor(() => expect(stderr).toContain(`${READY_MARKER}running`));

    // Ready, and still running with stdin held open.
    expect(child.exitCode).toBeNull();

    child.stdin.end();
    expect(await exited).toBe(0);
    rmSync(bin, { recursive: true, force: true });
  });
});

describe("remote-daemon: REMOTE_SHELL_COMMAND", () => {
  it("is metacharacter-free so any login shell parses it identically", () => {
    // sshd runs `<user's shell> -c "<command>"` with the shell from the
    // password database, so this string may be parsed by fish or tcsh.
    expect(REMOTE_SHELL_COMMAND).toBe("exec /bin/sh");
    expect(REMOTE_SHELL_COMMAND).not.toMatch(/['"`$\\\n;&|<>()]/);
  });
});

describe("remote-daemon: ensure script behavior", () => {
  const cleanups: string[] = [];
  const bin = (stubs: Record<string, string>): string => {
    const dir = makeBinDir(stubs);
    cleanups.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** Stub `node` so the port probe succeeds only once `marker` exists. */
  const nodeProbe = (marker?: string) =>
    marker ? `#!/bin/sh\n[ -f ${marker} ] && exit 0\nexit 1\n` : `#!/bin/sh\nexit 1\n`;

  it("reports READY:running and exits 0 when the daemon is already listening", () => {
    const dir = bin({ node: `#!/bin/sh\nexit 0\n` });
    const { status, stderr } = runEnsureScript(buildEnsureScript(makeConfig(), "1.2.3"), {
      path: dir,
    });
    expect(status).toBe(0);
    expect(stderr).toContain(`${READY_MARKER}running`);
    // Nothing should have been installed or launched.
    expect(stderr).not.toContain("Launching");
  });

  it("exits nodeMissing when the host has no node", () => {
    const { status, stderr } = runEnsureScript(buildEnsureScript(makeConfig(), "1.2.3"), {
      path: bin({}),
    });
    expect(status).toBe(ENSURE_EXIT.nodeMissing);
    expect(stderr).toContain("Node.js is required");
  });

  it("prefers a paseo already on PATH over installing a second copy", () => {
    const markerDir = mkdtempSync(path.join(tmpdir(), "paseo-marker-"));
    cleanups.push(markerDir);
    const marker = path.join(markerDir, "launched");
    const dir = bin({
      node: nodeProbe(marker),
      paseo: `#!/bin/sh\necho "$*" > ${marker}\nexit 0\n`,
      // Reaching npm at all would mean a conflicting second daemon.
      npm: `#!/bin/sh\necho SHOULD_NOT_INSTALL >&2\nexit 0\n`,
    });
    const { status, stderr } = runEnsureScript(buildEnsureScript(makeConfig(), "1.2.3"), {
      path: dir,
    });
    expect(status).toBe(0);
    expect(stderr).toContain("Using the Paseo already installed");
    expect(stderr).not.toContain("SHOULD_NOT_INSTALL");
    expect(stderr).toContain(`${READY_MARKER}launched`);
    expect(readFileSync(marker, "utf8")).toContain("daemon start");
  });

  it("passes the configured home and port to the daemon it launches", () => {
    const markerDir = mkdtempSync(path.join(tmpdir(), "paseo-marker-"));
    cleanups.push(markerDir);
    const marker = path.join(markerDir, "launched");
    const dir = bin({
      node: nodeProbe(marker),
      paseo: `#!/bin/sh\necho "$*" > ${marker}\nexit 0\n`,
    });
    const config = makeConfig({ remotePort: 7777, remoteHome: "/tmp/paseo-remote-home" });
    runEnsureScript(buildEnsureScript(config, "1.2.3"), { path: dir });
    const argv = readFileSync(marker, "utf8");
    expect(argv).toContain("--home /tmp/paseo-remote-home");
    expect(argv).toContain("--port 7777");
    expect(argv).toContain("--no-relay");
  });

  it("exits npmMissing when it must install but npm is absent", () => {
    const { status, stderr } = runEnsureScript(buildEnsureScript(makeConfig(), "1.2.3"), {
      path: bin({ node: nodeProbe() }),
    });
    expect(status).toBe(ENSURE_EXIT.npmMissing);
    expect(stderr).toContain("npm is required");
  });

  it("falls back to latest when the pinned version is not published", () => {
    const markerDir = mkdtempSync(path.join(tmpdir(), "paseo-marker-"));
    cleanups.push(markerDir);
    const marker = path.join(markerDir, "launched");
    const installDir = path.join(markerDir, "cli");
    const dir = bin({
      node: nodeProbe(marker),
      // Reject the pinned spec the way the registry would for a dev build,
      // accept @latest, and drop the managed binary in place.
      npm: `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    *@latest)
      mkdir -p "${installDir}/node_modules/.bin"
      printf '#!/bin/sh\\necho "$*" > ${marker}\\n' > "${installDir}/node_modules/.bin/paseo"
      chmod +x "${installDir}/node_modules/.bin/paseo"
      exit 0 ;;
    *@9.9.9-unpublished) echo "npm ERR! 404 Not Found" >&2; exit 1 ;;
  esac
done
exit 1
`,
      chmod: `#!/bin/sh\nexec /usr/bin/chmod "$@"\n`,
    });
    const config = makeConfig({ installDir });
    const { status, stderr } = runEnsureScript(buildEnsureScript(config, "9.9.9-unpublished"), {
      path: dir,
    });
    expect(stderr).toContain("is not published");
    expect(status).toBe(0);
    expect(stderr).toContain(`${READY_MARKER}launched`);
  });
});

describe("remote-daemon: failure descriptions", () => {
  const config = makeConfig();

  it("explains a missing runtime", () => {
    const message = describeEnsureFailure({
      config,
      exitCode: ENSURE_EXIT.nodeMissing,
      stderr: "",
    });
    expect(message).toMatch(/Node\.js is required/);
    expect(message).toMatch(/nodejs\.org/);
  });

  it("includes npm output when the install fails", () => {
    const message = describeEnsureFailure({
      config,
      exitCode: ENSURE_EXIT.installFailed,
      stderr: "npm ERR! 404 Not Found",
    });
    expect(message).toContain("npm ERR! 404 Not Found");
  });

  it("points at the remote log when the daemon never listens", () => {
    const message = describeEnsureFailure({ config, exitCode: ENSURE_EXIT.notReady, stderr: "" });
    expect(message).toContain("~/.paseo/daemon.log");
  });

  it("surfaces the ssh diagnostic rather than an opaque exit code", () => {
    // The single most common failure: SSH itself refused the connection.
    const message = describeEnsureFailure({
      config,
      exitCode: 255,
      stderr: "alice@server.example.com: Permission denied (publickey).",
    });
    expect(message).toContain("SSH connection to server.example.com failed");
    expect(message).toContain("Permission denied (publickey)");
  });

  it("falls back to the exit code only when there is no stderr at all", () => {
    expect(describeSshFailure("h", 7, "")).toContain("exit code 7");
  });
});

describe("ssh-process: terminal askpass", () => {
  it("produces valid POSIX shell without bash-only `read -s`", () => {
    const askpass = createTerminalAskpassScript();
    expect(spawnSync("sh", ["-n", askpass.path], { encoding: "utf8" }).status).toBe(0);
    const body = readFileSync(askpass.path, "utf8");
    // dash is /bin/sh on Debian and Ubuntu and rejects `read -s`.
    expect(body).not.toMatch(/read\s+-\w*s/);
    expect(body).toContain("stty -echo");
    askpass.cleanup();
  });

  it("reports EOF as a cancellation rather than an empty password", () => {
    const askpass = createTerminalAskpassScript();
    expect(readFileSync(askpass.path, "utf8")).toContain(`echo "${ASKPASS_CANCELLED_MARKER}" >&2`);
    askpass.cleanup();
  });

  it("writes into a private directory and removes it on cleanup", () => {
    const askpass = createTerminalAskpassScript();
    const dir = path.dirname(askpass.path);
    expect(dir).not.toBe(tmpdir());
    askpass.cleanup();
    expect(spawnSync("test", ["-d", dir]).status).not.toBe(0);
  });
});
