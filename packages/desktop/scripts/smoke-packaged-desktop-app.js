const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const EXECUTABLE_NAME = "Paseo";
const SMOKE_TIMEOUT_MS = 60_000;
const EXIT_TIMEOUT_MS = 10_000;
const TERMINAL_CAPTURE_ATTEMPTS = 20;
const TERMINAL_CAPTURE_INTERVAL_MS = 500;

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function assertExecutable(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} does not exist: ${filePath}`);
  }
  if (process.platform !== "win32") {
    fs.accessSync(filePath, fs.constants.X_OK);
  }
}

function getExecutablePath(appPath) {
  if (process.platform === "darwin") {
    return path.join(appPath, "Contents", "MacOS", EXECUTABLE_NAME);
  }

  if (process.platform === "win32") {
    return path.join(appPath, `${EXECUTABLE_NAME}.exe`);
  }

  return path.join(appPath, EXECUTABLE_NAME);
}

function getCliShimPath(appPath) {
  if (process.platform === "darwin") {
    return path.join(appPath, "Contents", "Resources", "bin", "paseo");
  }

  if (process.platform === "win32") {
    return path.join(appPath, "resources", "bin", "paseo.cmd");
  }

  return path.join(appPath, "resources", "bin", "paseo");
}

function getLaunchCommand(executablePath) {
  if (process.platform !== "linux") {
    return {
      command: executablePath,
      args: [],
    };
  }

  return {
    command: "xvfb-run",
    args: ["-a", executablePath],
  };
}

function shellQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function shellQuoteCliArg(value) {
  if (process.platform === "win32") {
    return `"${String(value).replace(/"/g, '""')}"`;
  }

  return shellQuote(String(value));
}

function getShellCommand(script) {
  if (process.platform === "win32") {
    return {
      command: "cmd.exe",
      args: ["/d", "/c", script],
    };
  }

  return {
    command: "/bin/sh",
    args: ["-lc", script],
  };
}

function createDefaultDaemonEnv(extraEnv) {
  const env = {
    ...process.env,
    ...extraEnv,
  };

  delete env.PASEO_HOME;
  delete env.PASEO_LISTEN;
  return env;
}

function parseSmokeLine(line) {
  const prefix = "[paseo-smoke] ";
  if (!line.startsWith(prefix)) {
    return null;
  }
  return JSON.parse(line.slice(prefix.length));
}

function appendChunk(lines, chunk, onSmokeMessage) {
  const text = chunk.toString();
  lines.push(text);
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseSmokeLine(line.trim());
    if (parsed) {
      onSmokeMessage(parsed);
    }
  }
}

function readIfExists(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
}

function formatLogs({ stdout, stderr, userData }) {
  const desktopLog = readIfExists(path.join(userData, "logs", "main.log"));
  const daemonLog = readIfExists(path.join(os.homedir(), ".paseo", "daemon.log"));
  return [
    `App stdout:\n${stdout.join("").trim() || "<empty>"}`,
    `App stderr:\n${stderr.join("").trim() || "<empty>"}`,
    `Desktop log:\n${desktopLog?.trim() || "<missing>"}`,
    `Daemon log:\n${daemonLog?.trim() || "<missing>"}`,
  ].join("\n\n");
}

function isRunning(child) {
  return child.exitCode === null && child.signalCode === null;
}

function terminateChild(child, signal = "SIGTERM") {
  if (!isRunning(child)) {
    return;
  }

  if (process.platform === "win32" && child.pid) {
    spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    return;
  }

  if (child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {}
  }

  child.kill(signal);
}

function waitForChildExit(child, timeoutMs = EXIT_TIMEOUT_MS) {
  if (!isRunning(child)) {
    return Promise.resolve(true);
  }

  let onExit;
  const exitPromise = new Promise((resolve) => {
    onExit = () => resolve(true);
    child.once("exit", onExit);
  });

  return Promise.race([exitPromise, delay(timeoutMs, false)]).finally(() => {
    child.off("exit", onExit);
  });
}

function releaseChildHandles(child) {
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
}

async function removeTempDir(tempDir) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!["EBUSY", "ENOTEMPTY", "EPERM"].includes(error?.code) || attempt === 4) {
        console.warn(`Packaged desktop smoke: failed to remove temp dir ${tempDir}: ${error}`);
        return;
      }
      await delay(250);
    }
  }
}

function waitForSmokeMessage({ child, stdout, stderr, userData, type, validate }) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      callback(value);
    };

    const timer = setTimeout(() => {
      terminateChild(child);
      finish(
        reject,
        new Error(
          `Timed out waiting for packaged desktop smoke result.\n${formatLogs({
            stdout,
            stderr,
            userData,
          })}`,
        ),
      );
    }, SMOKE_TIMEOUT_MS);

    const onSmokeMessage = (message) => {
      if (message.type !== type) {
        return;
      }
      if (validate(message)) {
        finish(resolve, message);
        return;
      }
      finish(reject, new Error(`Unexpected desktop smoke message: ${JSON.stringify(message)}`));
    };

    child.stdout.on("data", (chunk) => appendChunk(stdout, chunk, onSmokeMessage));
    child.stderr.on("data", (chunk) => appendChunk(stderr, chunk, onSmokeMessage));
    child.once("error", (error) => finish(reject, error));
    child.once("exit", (code, signal) => {
      if (settled) {
        return;
      }
      finish(
        reject,
        new Error(
          `Packaged app exited before reporting smoke success (code ${code}, signal ${
            signal ?? "none"
          }).\n${formatLogs({ stdout, stderr, userData })}`,
        ),
      );
    });
  });
}

function assertRunningDesktopManagedDaemon(message) {
  return (
    message.status?.status === "running" &&
    message.status?.desktopManaged === true &&
    typeof message.status?.pid === "number" &&
    typeof message.status?.listen === "string" &&
    message.status.listen.length > 0
  );
}

function runShellCommand({ script, env, label }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const shell = getShellCommand(script);
    const child = spawn(shell.command, shell.args, {
      detached: process.platform !== "win32",
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsVerbatimArguments: process.platform === "win32",
    });
    const stdout = [];
    const stderr = [];

    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      releaseChildHandles(child);
      callback(value);
    };

    const timer = setTimeout(() => {
      terminateChild(child);
      finish(
        reject,
        new Error(
          `${label} timed out.\nStdout:\n${stdout.join("").trim() || "<empty>"}\n\nStderr:\n${
            stderr.join("").trim() || "<empty>"
          }`,
        ),
      );
    }, SMOKE_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => stdout.push(chunk.toString()));
    child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
    child.once("error", (error) => finish(reject, error));
    child.once("exit", (code, signal) => {
      if (code === 0) {
        finish(resolve, {
          stdout: stdout.join(""),
          stderr: stderr.join(""),
        });
        return;
      }

      finish(
        reject,
        new Error(
          `${label} failed (code ${code}, signal ${signal ?? "none"}).\nStdout:\n${
            stdout.join("").trim() || "<empty>"
          }\n\nStderr:\n${stderr.join("").trim() || "<empty>"}`,
        ),
      );
    });
  });
}

function getCliShimScript(cliShimPath, args) {
  const commandArgs = args.map(shellQuoteCliArg).join(" ");
  if (process.platform === "win32") {
    return `call "${cliShimPath}" ${commandArgs}`;
  }

  return `${shellQuote(cliShimPath)} ${commandArgs}`;
}

async function runCliShimCommand({ appPath, env, args, label }) {
  const cliShimPath = getCliShimPath(appPath);
  assertExecutable(cliShimPath, "Bundled CLI shim");

  return await runShellCommand({
    script: getCliShimScript(cliShimPath, args),
    env,
    label,
  });
}

async function runCliShimJsonCommand({ appPath, env, args, label }) {
  const result = await runCliShimCommand({
    appPath,
    env,
    args: [...args, "--json"],
    label,
  });
  const output = result.stdout.trim();
  if (!output) {
    throw new Error(`${label} produced empty JSON output`);
  }

  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(`${label} produced invalid JSON: ${output}`, { cause: error });
  }
}

async function smokeCliShim({ appPath, env }) {
  console.log("Packaged desktop smoke: running bundled CLI shim daemon status");
  await runCliShimCommand({
    appPath,
    env,
    args: ["daemon", "status"],
    label: "Bundled CLI shim daemon status",
  });
}

async function smokeCliTerminal({ appPath, env }) {
  const cwd = createTempDir("paseo-smoke-terminal-cwd-");
  const marker = `paseo-packaged-terminal-smoke-${Date.now()}`;
  const name = `packaged-smoke-${process.pid}-${Date.now()}`;
  let terminalId = null;

  try {
    console.log("Packaged desktop smoke: creating terminal through bundled CLI shim");
    const created = await runCliShimJsonCommand({
      appPath,
      env,
      args: ["terminal", "create", "--cwd", cwd, "--name", name],
      label: "Bundled CLI shim terminal create",
    });
    if (!created || typeof created.id !== "string" || created.id.length === 0) {
      throw new Error(`Terminal create returned unexpected payload: ${JSON.stringify(created)}`);
    }
    terminalId = created.id;

    const terminals = await runCliShimJsonCommand({
      appPath,
      env,
      args: ["terminal", "ls", "--all"],
      label: "Bundled CLI shim terminal ls",
    });
    if (!Array.isArray(terminals) || !terminals.some((terminal) => terminal.id === terminalId)) {
      throw new Error(`Terminal ${terminalId} was not listed after create`);
    }

    await runCliShimJsonCommand({
      appPath,
      env,
      args: ["terminal", "send-keys", terminalId, "echo", "Space", marker, "Enter"],
      label: "Bundled CLI shim terminal send-keys",
    });

    for (let attempt = 1; attempt <= TERMINAL_CAPTURE_ATTEMPTS; attempt += 1) {
      const capture = await runCliShimJsonCommand({
        appPath,
        env,
        args: ["terminal", "capture", terminalId, "--scrollback"],
        label: "Bundled CLI shim terminal capture",
      });
      const lines = Array.isArray(capture?.lines) ? capture.lines : [];
      if (lines.join("\n").includes(marker)) {
        console.log("Packaged desktop smoke: terminal command output captured");
        return;
      }

      if (attempt < TERMINAL_CAPTURE_ATTEMPTS) {
        await delay(TERMINAL_CAPTURE_INTERVAL_MS);
      }
    }

    throw new Error(`Timed out waiting for terminal capture marker ${marker}`);
  } finally {
    if (terminalId) {
      await runCliShimJsonCommand({
        appPath,
        env,
        args: ["terminal", "kill", terminalId],
        label: "Bundled CLI shim terminal kill",
      }).catch((error) => {
        console.warn(`Packaged desktop smoke: failed to kill terminal ${terminalId}: ${error}`);
      });
    }
    await removeTempDir(cwd);
  }
}

async function stopCliDaemon({ appPath, env }) {
  console.log("Packaged desktop smoke: stopping daemon through bundled CLI shim");
  await runCliShimCommand({
    appPath,
    env,
    args: ["daemon", "stop", "--force"],
    label: "Bundled CLI shim daemon stop",
  });
}

async function smokePackagedDesktopApp({ appPath }) {
  const executablePath = getExecutablePath(appPath);
  assertExecutable(executablePath, "Packaged app executable");

  const userData = createTempDir("paseo-smoke-user-data-");
  const env = createDefaultDaemonEnv({
    PASEO_DESKTOP_SMOKE: "1",
    PASEO_ELECTRON_USER_DATA_DIR: userData,
  });

  const stdout = [];
  const stderr = [];
  const launch = getLaunchCommand(executablePath);
  console.log(`Packaged desktop smoke: launching ${launch.command} ${launch.args.join(" ")}`);
  const child = spawn(launch.command, launch.args, {
    detached: process.platform !== "win32",
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let smokeStarted = false;
  let daemonStopped = false;

  const stopDaemonForCleanup = async () => {
    if (daemonStopped) {
      return;
    }

    await stopCliDaemon({ appPath, env: createDefaultDaemonEnv() });
    daemonStopped = true;
  };

  try {
    const message = await waitForSmokeMessage({
      child,
      stdout,
      stderr,
      userData,
      type: "desktop-daemon-smoke-started",
      validate: assertRunningDesktopManagedDaemon,
    });
    smokeStarted = true;
    console.log("Packaged desktop smoke: desktop-managed daemon reported running");
    const cliEnv = createDefaultDaemonEnv();
    await smokeCliShim({ appPath, env: cliEnv });
    await smokeCliTerminal({ appPath, env: cliEnv });
    await stopDaemonForCleanup();
    console.log(
      `Packaged desktop smoke passed: desktop-managed daemon pid ${message.status.pid}, listen ${message.status.listen}; CLI shim daemon status and terminal smoke succeeded`,
    );
  } catch (error) {
    if (smokeStarted && !daemonStopped) {
      try {
        await stopDaemonForCleanup();
      } catch {}
    }
    throw error;
  } finally {
    if (isRunning(child)) {
      terminateChild(child);
      if (!(await waitForChildExit(child))) {
        terminateChild(child, "SIGKILL");
        await waitForChildExit(child);
      }
    }
    releaseChildHandles(child);
    await removeTempDir(userData);
  }
}

module.exports = {
  smokePackagedDesktopApp,
};

if (require.main === module) {
  const appIndex = process.argv.indexOf("--app");
  const appPath = appIndex >= 0 ? process.argv[appIndex + 1] : null;
  if (!appPath) {
    process.stderr.write("Usage: node smoke-packaged-desktop-app.js --app <Paseo.app>\n");
    process.exit(2);
  }

  smokePackagedDesktopApp({ appPath }).catch((error) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
