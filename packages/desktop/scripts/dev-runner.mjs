#!/usr/bin/env node
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const rootDir = path.resolve(desktopDir, "../..");
const appDir = path.resolve(desktopDir, "../app");
const require = createRequire(import.meta.url);
const electron = require("electron");

const expoPort = Number(process.env.EXPO_PORT);
if (!Number.isInteger(expoPort) || expoPort <= 0) {
  console.error("[dev] EXPO_PORT must be set before running desktop dev");
  process.exit(1);
}

const expoDevUrl = process.env.EXPO_DEV_URL || `http://localhost:${expoPort}`;
const daemonEndpoint = process.env.PASEO_DAEMON_ENDPOINT || process.env.PASEO_LISTEN || "";
const colorEnv = {
  FORCE_COLOR: process.env.FORCE_COLOR || "1",
  npm_config_color: process.env.npm_config_color || "always",
};

const children = new Map();
let stopping = false;
let exitCode = 0;

function prefixStream(name, stream, target) {
  let buffered = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffered += chunk;
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      target.write(line ? `[${name}] ${line}\n` : `[${name}]\n`);
    }
  });
  stream.on("end", () => {
    if (buffered) {
      target.write(`[${name}] ${buffered}\n`);
    }
  });
}

function spawnChild(name, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: rootDir,
    env: {
      ...process.env,
      ...colorEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });

  children.set(name, child);
  prefixStream(name, child.stdout, process.stdout);
  prefixStream(name, child.stderr, process.stderr);

  child.on("error", (error) => {
    console.error(`[${name}] failed to start: ${error.message}`);
    exitCode = 1;
    stopAll("SIGTERM");
  });

  child.on("exit", (code, signal) => {
    children.delete(name);
    if (!stopping) {
      if (code !== 0) {
        exitCode = code ?? 1;
        console.error(`[${name}] exited with ${signal ?? code}`);
      }
      stopAll("SIGTERM");
    }
  });

  return child;
}

function killChild(child, signal) {
  if (!child.pid || child.killed) {
    return;
  }

  try {
    if (child.detached) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    // The child may have exited between the liveness check and the signal.
  }
}

function stopAll(signal) {
  if (stopping) {
    return;
  }

  stopping = true;
  for (const child of children.values()) {
    killChild(child, signal);
  }

  const forceKill = setTimeout(() => {
    for (const child of children.values()) {
      killChild(child, "SIGKILL");
    }
  }, 2500);
  forceKill.unref();

  const finish = setInterval(() => {
    if (children.size === 0) {
      clearInterval(finish);
      process.exit(exitCode);
    }
  }, 50);
}

async function waitForPort(port, host = "127.0.0.1", timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await canConnect(port, host)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for ${host}:${port}`);
}

function canConnect(port, host) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    socket.setTimeout(1000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

process.on("SIGINT", () => stopAll("SIGTERM"));
process.on("SIGTERM", () => stopAll("SIGTERM"));

spawnChild("metro", "npx", ["expo", "start", "--port", String(expoPort)], {
  cwd: appDir,
  detached: true,
  env: {
    ...process.env,
    ...colorEnv,
    BROWSER: "none",
    APP_VARIANT: "development",
    PASEO_WEB_PLATFORM: "electron",
    EXPO_PUBLIC_LOCAL_DAEMON: daemonEndpoint,
  },
});

try {
  await waitForPort(expoPort);
} catch (error) {
  console.error(`[dev] ${error.message}`);
  exitCode = 1;
  stopAll("SIGTERM");
}

if (!stopping) {
  spawnChild("electron", electron, [desktopDir], {
    detached: true,
    env: {
      ...process.env,
      ...colorEnv,
      EXPO_DEV_URL: expoDevUrl,
    },
  });
}
