#!/usr/bin/env node
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const rootDir = resolvePath(import.meta.dirname, "..");
const appDir = join(rootDir, "packages/app");
const appProductName = "PaseoDebug";
const appScheme = "paseo";
const preferredSimulatorType = process.env.PASEO_IOS_DEVICE_TYPE || "iPhone 16 Pro";
const paseoPort = requiredEnv("PASEO_PORT");
const worktreePath = process.env.PASEO_WORKTREE_PATH || rootDir;
const worktreeName = process.env.PASEO_BRANCH_NAME || basename(worktreePath);
const worktreeHash = createHash("sha1").update(worktreePath).digest("hex").slice(0, 8);
const simulatorName =
  process.env.PASEO_IOS_SIMULATOR_NAME || `Paseo ${worktreeName} ${worktreeHash}`;
const daemonEndpoint =
  process.env.PASEO_DEV_DAEMON_ENDPOINT ||
  `localhost:${process.env.PASEO_SERVICE_DAEMON_PORT || "6768"}`;

const env = {
  ...process.env,
  PATH: `${join(rootDir, "node_modules/.bin")}:${process.env.PATH || ""}`,
  APP_VARIANT: "development",
  CI: process.env.CI || "1",
  EXPO_PUBLIC_LOCAL_DAEMON: daemonEndpoint,
};
const nativeBuildLog = join(rootDir, ".dev", "ios-build", `${simulatorSlug()}.log`);

let simulatorUdid = "";
let metro;
let shuttingDown = false;
let simulatorVisibilityGuard;

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
  void cleanup();
});

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

async function main() {
  startSimulatorVisibilityGuard();
  simulatorUdid = findSimulator(simulatorName) || createSimulator(simulatorName);
  hideNativeSimulatorApp();
  bootSimulator(simulatorUdid);
  hideNativeSimulatorApp();
  run("npx", ["serve-sim", "--detach", "-q", simulatorUdid], { cwd: rootDir });
  hideNativeSimulatorApp();

  metro = startMetro();
  await waitForUrl(`http://127.0.0.1:${paseoPort}/.sim`);
  console.log(`iOS preview: ${process.env.PASEO_URL || `http://127.0.0.1:${paseoPort}`}/.sim`);

  console.log("Building app dependencies...");
  try {
    run("npm", ["--prefix", rootDir, "run", "build:client"], { cwd: rootDir });
    console.log("Generating iOS project...");
    run("npx", ["expo", "prebuild", "--platform", "ios", "--non-interactive"], {
      cwd: appDir,
    });

    const nativeProject = getNativeProject();
    console.log(`Building iOS app (${nativeProject.scheme}); log: ${nativeBuildLog}`);
    buildApp(nativeProject);
    console.log("Installing iOS app...");
    installApp(nativeProject);
    console.log("Launching iOS app...");
    launchApp();
    hideNativeSimulatorApp();
  } catch (error) {
    process.exitCode = 1;
    console.error("iOS app build/install failed; leaving preview running for manual QA.");
    console.error(error instanceof Error ? error.message : error);
  }

  await waitForExit(metro);
  await cleanup();
}

function buildApp(nativeProject) {
  run(
    "xcodebuild",
    [
      ...nativeProject.args,
      "-scheme",
      nativeProject.scheme,
      "-configuration",
      "Debug",
      "-destination",
      `id=${simulatorUdid}`,
      "-derivedDataPath",
      nativeProject.derivedDataPath,
      "build",
    ],
    { cwd: appDir, logFile: nativeBuildLog },
  );
}

function installApp(nativeProject) {
  const appPath = findBuiltApp(nativeProject.derivedDataPath);
  run("xcrun", ["simctl", "install", simulatorUdid, appPath], { cwd: appDir });
}

function launchApp() {
  const metroUrl = encodeURIComponent(`http://127.0.0.1:${paseoPort}`);
  run(
    "xcrun",
    ["simctl", "openurl", simulatorUdid, `${appScheme}://expo-development-client/?url=${metroUrl}`],
    { cwd: appDir },
  );
}

function startMetro() {
  const child = spawn("npx", ["expo", "start", "--port", paseoPort, "--localhost"], {
    cwd: appDir,
    env: {
      ...env,
      PASEO_SERVE_SIM_PREVIEW: "1",
      PASEO_SERVE_SIM_DEVICE_UDID: simulatorUdid,
      BROWSER: "none",
    },
    stdio: "inherit",
  });
  child.on("exit", (code, signal) => {
    if (!shuttingDown && code !== 0) {
      console.error(`Metro exited with ${signal || code}`);
      process.exitCode = code || 1;
    }
  });
  return child;
}

function getNativeProject() {
  const workspace = firstPath(join(appDir, "ios"), (name) => name.endsWith(".xcworkspace"));
  const project = firstPath(join(appDir, "ios"), (name) => name.endsWith(".xcodeproj"));
  const projectFile = workspace || project;
  if (!projectFile) {
    throw new Error("Expo prebuild did not create an iOS workspace or project.");
  }
  return {
    args: workspace ? ["-workspace", workspace] : ["-project", projectFile],
    scheme: getScheme(workspace ? ["-workspace", workspace] : ["-project", projectFile]),
    derivedDataPath: join(rootDir, ".dev", "ios-build", simulatorSlug()),
  };
}

function getScheme(projectArgs) {
  const output = run("xcodebuild", [...projectArgs, "-list", "-json"], {
    cwd: appDir,
    capture: true,
  });
  const list = parseJson(output);
  const schemes = list.workspace?.schemes || list.project?.schemes || [];
  const scheme = schemes.find((value) => value === appProductName) || schemes[0];
  if (!scheme) throw new Error("No iOS scheme found after Expo prebuild.");
  return scheme;
}

function findBuiltApp(derivedDataPath) {
  const productsDir = join(derivedDataPath, "Build", "Products", "Debug-iphonesimulator");
  const appPath = join(productsDir, `${appProductName}.app`);
  if (existsSync(appPath)) return appPath;
  const fallback = firstPath(productsDir, (name) => name.endsWith(".app"));
  if (fallback) return fallback;
  throw new Error(`Built app was not found in ${productsDir}`);
}

function findSimulator(name) {
  const output = parseJson(run("xcrun", ["simctl", "list", "devices", "-j"], { capture: true }));
  for (const devices of Object.values(output.devices || {})) {
    for (const device of devices) {
      if (device.name === name && device.isAvailable !== false) {
        return device.udid;
      }
    }
  }
  return null;
}

function createSimulator(name) {
  return run("xcrun", ["simctl", "create", name, resolveSimulatorType()], {
    capture: true,
  }).trim();
}

function resolveSimulatorType() {
  const output = parseJson(
    run("xcrun", ["simctl", "list", "devicetypes", "-j"], {
      capture: true,
    }),
  );
  const types = output.devicetypes || [];
  const preferred = types.find((type) => type.name === preferredSimulatorType);
  if (preferred) return preferred.identifier;
  const fallback =
    types.find((type) => /^iPhone .* Pro$/.test(type.name)) ||
    types.find((type) => /^iPhone\b/.test(type.name));
  if (!fallback) throw new Error("No iPhone simulator device type is installed.");
  return fallback.identifier;
}

function bootSimulator(udid) {
  spawnSync("xcrun", ["simctl", "boot", udid], { stdio: "ignore" });
  waitForBootedSimulator(udid);
}

function waitForBootedSimulator(udid) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    hideNativeSimulatorApp();
    const output = parseJson(run("xcrun", ["simctl", "list", "devices", "-j"], { capture: true }));
    for (const devices of Object.values(output.devices || {})) {
      for (const device of devices) {
        if (device.udid === udid && device.state === "Booted") return;
      }
    }
    spawnSync("sleep", ["1"]);
  }
  throw new Error(`Timed out waiting for simulator ${udid} to boot.`);
}

async function cleanup() {
  if (shuttingDown) return;
  shuttingDown = true;
  stopSimulatorVisibilityGuard();
  if (metro && !metro.killed) {
    metro.kill("SIGTERM");
  }
  if (simulatorUdid) {
    spawnSync("npx", ["serve-sim", "--kill", simulatorUdid], {
      cwd: rootDir,
      stdio: "ignore",
      env,
    });
    spawnSync("xcrun", ["simctl", "shutdown", simulatorUdid], { stdio: "ignore" });
  }
}

async function shutdown() {
  await cleanup();
  process.exit();
}

function run(command, args, options = {}) {
  if (options.logFile) {
    return runWithLogFile(command, args, options);
  }
  const stdio = options.capture || options.logFile ? ["ignore", "pipe", "pipe"] : "inherit";
  const result = spawnSync(command, args, {
    cwd: options.cwd || rootDir,
    env,
    encoding: "utf8",
    stdio,
  });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(`${command} ${args.join(" ")} failed${output ? `\n${output}` : ""}`);
  }
  return result.stdout || "";
}

function runWithLogFile(command, args, options) {
  mkdirSync(dirname(options.logFile), { recursive: true });
  const logFile = openSync(options.logFile, "w");
  try {
    const result = spawnSync(command, args, {
      cwd: options.cwd || rootDir,
      env,
      encoding: "utf8",
      stdio: ["ignore", logFile, logFile],
    });
    if (result.status !== 0) {
      throw new Error(`${command} ${args.join(" ")} failed; see ${options.logFile}`);
    }
    return "";
  } finally {
    closeSync(logFile);
  }
}

function hideNativeSimulatorApp() {
  spawnSync(
    "osascript",
    [
      "-e",
      'tell application "System Events"',
      "-e",
      'if exists application process "Simulator" then set visible of application process "Simulator" to false',
      "-e",
      "end tell",
    ],
    { stdio: "ignore", timeout: 2_000 },
  );
}

function startSimulatorVisibilityGuard() {
  hideNativeSimulatorApp();
  simulatorVisibilityGuard = setInterval(hideNativeSimulatorApp, 250);
  simulatorVisibilityGuard.unref?.();
}

function stopSimulatorVisibilityGuard() {
  if (simulatorVisibilityGuard) {
    clearInterval(simulatorVisibilityGuard);
    simulatorVisibilityGuard = undefined;
  }
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Could not parse JSON: ${error instanceof Error ? error.message : error}`, {
      cause: error,
    });
  }
}

function firstPath(dir, predicate) {
  try {
    const name = readdirSync(dir).find(predicate);
    return name ? join(dir, name) : null;
  } catch {
    return null;
  }
}

function simulatorSlug() {
  return `${simulatorName.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")}-${worktreeHash}`;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required; run this as a Paseo service.`);
  return value;
}

async function waitForUrl(url) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((done) => setTimeout(done, 1000));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function waitForExit(child) {
  return new Promise((done) => child.on("exit", done));
}
