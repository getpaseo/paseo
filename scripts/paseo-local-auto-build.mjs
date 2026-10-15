#!/usr/bin/env node

import { assertReleaseInventory } from "./local-release-inventory.mjs";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(join(import.meta.dirname, ".."));
const label = "sh.paseo.local-auto-build";

function paths(env) {
  const state = resolve(
    env.PASEO_LOCAL_BUILDER_HOME ??
      join(homedir(), "Library/Application Support/Paseo Local Builder"),
  );
  const launchAgents = resolve(
    env.PASEO_LOCAL_BUILDER_LAUNCH_AGENTS_DIR ?? join(homedir(), "Library/LaunchAgents"),
  );
  return {
    state,
    checkout: join(state, "checkout"),
    lock: join(state, "build.lock"),
    marker: join(state, "last-successful-commit"),
    activeMarker: join(state, "last-active-commit"),
    desktopStatus:
      env.PASEO_LOCAL_DESKTOP_STATUS ??
      join(homedir(), "Library/Application Support/Paseo Local/local-release-status.json"),
    workflowActivationMarker: join(state, "last-successful-workflow-activation-commit"),
    workflowReleases: join(state, "workflow-releases"),
    paseoHome: resolve(env.PASEO_LOCAL_BUILDER_PASEO_HOME ?? join(homedir(), ".paseo")),
    launchAgents,
    plist: join(launchAgents, `${label}.plist`),
    log: resolve(
      env.PASEO_LOCAL_BUILDER_LOG ?? join(homedir(), "Library/Logs/Paseo Local Builder.log"),
    ),
  };
}

function execute(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: options.env,
    cwd: options.cwd,
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim();
    throw new Error(`${command} ${args.join(" ")} failed: ${detail}`);
  }
  return result.stdout.trim();
}

function executeStreaming(command, args, options) {
  const result = spawnSync(command, args, { ...options, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status}`);
  }
}

function log(message) {
  process.stdout.write(`[${new Date().toISOString()}] ${message}\n`);
}

function writeMarker(marker, commit) {
  const temporaryMarker = `${marker}.${process.pid}.tmp`;
  writeFileSync(temporaryMarker, `${commit}\n`);
  renameSync(temporaryMarker, marker);
}

function workflowSource(env) {
  const { paseoHome, workflowReleases } = paths(env);
  const configPath = join(paseoHome, "config.json");
  if (!existsSync(configPath)) return null;
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const plugin = config.plugins?.["paseo-workflow"];
  if (!plugin || config.pluginsEnabled !== true || plugin.enabled === false) return null;

  const source = join(paseoHome, "plugins/paseo-workflow-local");
  if (
    plugin.source !== "directory" ||
    typeof plugin.path !== "string" ||
    resolve(plugin.path) !== source
  ) {
    throw new Error(`paseo-workflow is configured outside the expected source: ${plugin.path}`);
  }
  return { source, backup: `${source}.before-workflow-releases`, workflowReleases };
}

function workflowSnapshot(checkout, releases, commit, env) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error(`Invalid successful build commit: ${commit}`);
  execute("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: checkout, env });
  mkdirSync(releases, { recursive: true });
  const snapshot = join(releases, commit);
  if (!existsSync(snapshot)) {
    const temporary = mkdtempSync(join(releases, `.${commit}.`));
    try {
      const archive = spawnSync(
        "git",
        ["archive", "--format=tar", commit, "plugins/paseo-workflow"],
        {
          cwd: checkout,
          env,
        },
      );
      if (archive.status !== 0) {
        throw new Error(
          `git archive ${commit} failed: ${(archive.stderr || "").toString().trim()}`,
        );
      }
      const extracted = spawnSync("tar", ["-xf", "-", "-C", temporary, "--strip-components=2"], {
        input: archive.stdout,
        encoding: "utf8",
        env,
      });
      if (extracted.status !== 0) {
        throw new Error(`tar extraction failed: ${(extracted.stderr || "").trim()}`);
      }
      if (!existsSync(join(temporary, "paseo-plugin.json"))) {
        throw new Error(`Commit ${commit} has no plugins/paseo-workflow plugin manifest`);
      }
      renameSync(temporary, snapshot);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  const info = lstatSync(snapshot);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    !existsSync(join(snapshot, "paseo-plugin.json"))
  ) {
    throw new Error(`Invalid workflow snapshot: ${snapshot}`);
  }
  return snapshot;
}

function currentWorkflowTarget(source, releases) {
  if (!existsSync(source) && !lstatSync(source, { throwIfNoEntry: false })) return null;
  const info = lstatSync(source);
  if (!info.isSymbolicLink()) return null;
  const target = resolve(dirname(source), readlinkSync(source));
  const fromReleases = relative(releases, target);
  if (fromReleases === "" || fromReleases.startsWith("..") || fromReleases.includes("/")) {
    throw new Error(`Unexpected paseo-workflow symlink: ${source} -> ${target}`);
  }
  if (!lstatSync(target, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Workflow snapshot target is missing: ${target}`);
  }
  return target;
}

function pointWorkflowSource(source, backup, releases, snapshot, previousTarget) {
  if (!existsSync(source) && !lstatSync(source, { throwIfNoEntry: false }) && existsSync(backup)) {
    renameSync(backup, source);
  }
  const info = lstatSync(source, { throwIfNoEntry: false });
  if (!info) throw new Error(`Configured workflow source is missing: ${source}`);

  if (!info.isSymbolicLink()) {
    if (!info.isDirectory())
      throw new Error(`Configured workflow source is not a directory: ${source}`);
    if (existsSync(backup)) throw new Error(`Workflow backup already exists: ${backup}`);
    renameSync(source, backup);
  }

  const temporaryLink = `${source}.${process.pid}.tmp`;
  try {
    symlinkSync(snapshot, temporaryLink, "dir");
    renameSync(temporaryLink, source);
  } catch (error) {
    rmSync(temporaryLink, { force: true });
    if (!info.isSymbolicLink() && existsSync(backup) && !existsSync(source))
      renameSync(backup, source);
    throw error;
  }

  return () => {
    if (previousTarget) {
      const rollbackLink = `${source}.${process.pid}.rollback`;
      symlinkSync(previousTarget, rollbackLink, "dir");
      renameSync(rollbackLink, source);
    } else {
      rmSync(source, { force: true });
      if (existsSync(backup)) renameSync(backup, source);
    }
  };
}

function daemonStatus(checkout, paseoHome, env) {
  const cliArgs = ["run", "--silent", "cli", "--"];
  return JSON.parse(
    execute("npm", [...cliArgs, "daemon", "status", "--home", paseoHome, "--json"], {
      cwd: checkout,
      env,
    }),
  );
}

function reloadWorkflow(checkout, env) {
  const cliArgs = ["run", "--silent", "cli", "--"];
  const item = JSON.parse(
    execute(
      "npm",
      [...cliArgs, "plugin", "reload", "paseo-workflow", "--host", "127.0.0.1:6767", "--json"],
      { cwd: checkout, env },
    ),
  );
  if (item.status !== "running") {
    throw new Error(
      `paseo-workflow reload did not reach running status: ${item.status ?? "unknown"}`,
    );
  }
}

function syncWorkflowCommit(env, commit, currentDaemon = null) {
  const { checkout, paseoHome, workflowActivationMarker } = paths(env);
  const configured = workflowSource(env);
  if (!configured) {
    log("paseo-workflow is absent or disabled; skipping sync");
    return 0;
  }

  const snapshot = workflowSnapshot(checkout, configured.workflowReleases, commit, env);
  const currentTarget = currentWorkflowTarget(configured.source, configured.workflowReleases);
  const activatedCommit = existsSync(workflowActivationMarker)
    ? readFileSync(workflowActivationMarker, "utf8").trim()
    : "";
  if (activatedCommit && !/^[a-f0-9]{40}$/.test(activatedCommit)) {
    throw new Error(`Invalid workflow activation commit: ${activatedCommit}`);
  }
  const alreadyActivated = activatedCommit === commit && currentTarget === snapshot;
  if (alreadyActivated) return 0;

  let previousTarget = currentTarget;
  if (activatedCommit) previousTarget = join(configured.workflowReleases, activatedCommit);
  else if (existsSync(configured.backup)) previousTarget = null;
  if (previousTarget && !lstatSync(previousTarget, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Previously activated workflow snapshot is missing: ${previousTarget}`);
  }
  let reloadAttempted = false;
  let restore = null;
  try {
    const daemon = currentDaemon ?? daemonStatus(checkout, paseoHome, env);
    if (daemon.localDaemon !== "running") {
      log(`Published paseo-workflow ${commit}; activation pending because the daemon is stopped`);
      return 0;
    }
    restore = pointWorkflowSource(
      configured.source,
      configured.backup,
      configured.workflowReleases,
      snapshot,
      previousTarget,
    );
    reloadAttempted = true;
    reloadWorkflow(checkout, env);
    writeMarker(workflowActivationMarker, commit);
    log(`Activated paseo-workflow ${commit}`);
    return 0;
  } catch (error) {
    if (restore) {
      try {
        restore();
      } catch (restoreError) {
        throw new Error(
          `Workflow sync failed: ${error.message}; restoring the previous source failed: ${restoreError.message}`,
          { cause: restoreError },
        );
      }
    }
    if (reloadAttempted) {
      try {
        reloadWorkflow(checkout, env);
      } catch (reloadError) {
        throw new Error(
          `Workflow sync failed: ${error.message}; previous source was restored but its reload failed: ${reloadError.message}`,
          { cause: reloadError },
        );
      }
    }
    throw error;
  }
}

function syncWorkflowLocked(env) {
  const { marker } = paths(env);
  if (!existsSync(marker)) throw new Error("No successful Paseo Local build is recorded yet");
  return syncWorkflowCommit(env, readFileSync(marker, "utf8").trim());
}

function xml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function launchctl(env, args, allowMissing = false) {
  const command = env.PASEO_LOCAL_BUILDER_LAUNCHCTL ?? "/bin/launchctl";
  const result = spawnSync(command, args, { encoding: "utf8", env });
  const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim();
  if (
    result.status !== 0 &&
    !(allowMissing && result.status === 3 && /No such process/i.test(detail))
  ) {
    throw new Error(`${command} ${args.join(" ")} failed: ${detail}`);
  }
  return result;
}

function launchDomain() {
  return `gui/${process.getuid()}`;
}

function syncCheckout(checkout, env) {
  if (!existsSync(join(checkout, ".git"))) {
    throw new Error(`Dedicated checkout is missing: ${checkout}. Run the install command first.`);
  }
  if (execute("git", ["branch", "--show-current"], { cwd: checkout, env }) !== "main") {
    throw new Error("Dedicated checkout is not on main");
  }
  if (execute("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: checkout, env })) {
    throw new Error("Dedicated checkout has tracked changes");
  }

  execute("git", ["fetch", "origin", "refs/heads/main:refs/remotes/origin/main"], {
    cwd: checkout,
    env,
  });
  const remoteCommit = execute("git", ["rev-parse", "origin/main"], {
    cwd: checkout,
    env,
  });
  execute("git", ["merge", "--ff-only", "origin/main"], { cwd: checkout, env });
  const commit = execute("git", ["rev-parse", "HEAD"], { cwd: checkout, env });
  if (commit !== remoteCommit) {
    throw new Error("Dedicated checkout does not exactly match origin/main");
  }
  return commit;
}

function plistContents({ checkout, log: logPath, state }, env) {
  const values = [process.execPath, join(checkout, "scripts/paseo-local-auto-build.mjs"), "run"];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${values.map((value) => `    <string>${xml(value)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(checkout)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(env.PATH ?? "")}</string>
    <key>PASEO_LOCAL_BUILDER_HOME</key>
    <string>${xml(state)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>300</integer>
  <key>StandardOutPath</key>
  <string>${xml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logPath)}</string>
</dict>
</plist>
`;
}

function installLocked(env) {
  const builderPaths = paths(env);
  mkdirSync(builderPaths.state, { recursive: true });
  mkdirSync(builderPaths.launchAgents, { recursive: true });
  mkdirSync(resolve(join(builderPaths.log, "..")), { recursive: true });

  const source = resolve(env.PASEO_LOCAL_BUILDER_SOURCE ?? repositoryRoot);
  const repositoryUrl = execute("git", ["remote", "get-url", "origin"], { cwd: source, env });
  let createdCheckout = false;
  if (!existsSync(join(builderPaths.checkout, ".git"))) {
    execute(
      "git",
      ["clone", "--branch", "main", "--single-branch", repositoryUrl, builderPaths.checkout],
      { env },
    );
    createdCheckout = true;
  } else {
    const branch = execute("git", ["branch", "--show-current"], {
      cwd: builderPaths.checkout,
      env,
    });
    const existingUrl = execute("git", ["remote", "get-url", "origin"], {
      cwd: builderPaths.checkout,
      env,
    });
    if (branch !== "main" || existingUrl !== repositoryUrl) {
      throw new Error("Existing dedicated checkout does not match origin/main");
    }
  }

  syncCheckout(builderPaths.checkout, env);

  if (!existsSync(join(builderPaths.checkout, "scripts/paseo-local-auto-build.mjs"))) {
    if (createdCheckout) rmSync(builderPaths.checkout, { recursive: true, force: true });
    throw new Error("origin/main does not contain scripts/paseo-local-auto-build.mjs");
  }

  const sourcesPath = join(builderPaths.state, "source-repositories.json");
  const previous = existsSync(sourcesPath)
    ? JSON.parse(readFileSync(sourcesPath, "utf8"))
    : { repositories: [] };
  const primary = execute("git", ["worktree", "list", "--porcelain"], { cwd: source, env })
    .split("\n")[0]
    .slice(9);
  if (resolve(primary) === resolve(builderPaths.checkout) && previous.repositories.length === 0)
    throw new Error("Declare the development repository with PASEO_LOCAL_BUILDER_SOURCE first");
  const repositories = [...new Set([...previous.repositories, primary])];
  writeFileSync(`${sourcesPath}.tmp`, JSON.stringify({ repositories }, null, 2) + "\n");
  renameSync(`${sourcesPath}.tmp`, sourcesPath);

  const domain = launchDomain();
  launchctl(env, ["bootout", `${domain}/${label}`], true);
  const temporaryPlist = `${builderPaths.plist}.${process.pid}.tmp`;
  writeFileSync(temporaryPlist, plistContents(builderPaths, env));
  renameSync(temporaryPlist, builderPaths.plist);
  launchctl(env, ["bootstrap", domain, builderPaths.plist]);
  log(`Installed ${builderPaths.plist}`);
  return 0;
}

function uninstall(env) {
  const builderPaths = paths(env);
  launchctl(env, ["bootout", `${launchDomain()}/${label}`], true);
  rmSync(builderPaths.plist, { force: true });
  log(`Uninstalled ${builderPaths.plist}`);
  return 0;
}

function verifyLaunchd(env) {
  const verifyRoot = resolve(env.PASEO_LOCAL_BUILDER_VERIFY_DIR ?? tmpdir());
  mkdirSync(verifyRoot, { recursive: true });
  const verifyDirectory = mkdtempSync(join(verifyRoot, "paseo-local-launchd-verification-"));
  const verifyLabel = `${label}.verify.${process.pid}`;
  const completed = join(verifyDirectory, "completed");
  const plist = join(verifyDirectory, `${verifyLabel}.plist`);
  const output = join(verifyDirectory, "launchd.log");
  const domain = launchDomain();
  const verifyEnv = { ...env, PASEO_LOCAL_BUILDER_PROBE_PATH: completed };

  writeFileSync(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${verifyLabel}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(scriptPath)}</string>
    <string>probe</string>
    <string>${xml(completed)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(output)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(output)}</string>
</dict>
</plist>
`,
  );

  try {
    launchctl(verifyEnv, ["bootout", `${domain}/${verifyLabel}`], true);
    launchctl(verifyEnv, ["bootstrap", domain, plist]);
    for (let attempt = 0; attempt < 100 && !existsSync(completed); attempt += 1) {
      spawnSync("/bin/sleep", ["0.05"]);
    }
    if (!existsSync(completed) || readFileSync(completed, "utf8") !== "ok\n") {
      const diagnostic = existsSync(output) ? readFileSync(output, "utf8").trim() : "no output";
      throw new Error(`LaunchAgent verification timed out: ${diagnostic}`);
    }
    launchctl(verifyEnv, ["print", `${domain}/${verifyLabel}`]);
    log("LaunchAgent verification succeeded");
    return 0;
  } finally {
    launchctl(verifyEnv, ["bootout", `${domain}/${verifyLabel}`], true);
    rmSync(verifyDirectory, { recursive: true, force: true });
  }
}

function runLocked(env) {
  const { checkout, marker } = paths(env);
  const commit = syncCheckout(checkout, env);
  assertReleaseInventory({ root: checkout, commit, state: paths(env).state });
  const successfulCommit = existsSync(marker) ? readFileSync(marker, "utf8").trim() : "";
  if (successfulCommit !== commit) {
    log(`Building ${commit}`);
    executeStreaming("npm", ["ci"], {
      cwd: checkout,
      env: { ...env, OPENUI_TELEMETRY_DISABLED: "1" },
    });
    executeStreaming("npm", ["run", "build"], { cwd: checkout, env });
    writeMarker(marker, commit);
    log(`Built ${commit}`);
  } else {
    log(`Already built ${commit}`);
  }

  // Installation does not authorize interrupting agents. The desktop activates its UI at idle.
  const { activeMarker, desktopStatus } = paths(env);
  let active = false;
  try {
    const status = JSON.parse(readFileSync(desktopStatus, "utf8"));
    if (status.verified && status.active === commit && Number.isInteger(status.pid)) {
      process.kill(status.pid, 0);
      active = true;
    }
  } catch {
    /* Closed or unverified desktop: installation is still pending activation. */
  }
  if (active) {
    writeMarker(activeMarker, commit);
    log(`Active ${commit}`);
  } else {
    log(`Installed ${commit}; waiting for desktop activation confirmation`);
  }
  return syncWorkflowCommit(env, commit, null);
}

function withLock(command, env, busyExitCode) {
  const { state, lock } = paths(env);
  mkdirSync(state, { recursive: true });
  const result = spawnSync(
    "/usr/bin/lockf",
    ["-k", "-s", "-t", "0", lock, process.execPath, scriptPath, command],
    { env, stdio: "inherit" },
  );
  if (result.status === 75) {
    log("Another builder operation is already running");
    return busyExitCode;
  }
  return result.status ?? 1;
}

function run(env) {
  return withLock("run-locked", env, 0);
}

function syncWorkflow(env) {
  return withLock("sync-workflow-locked", env, 1);
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const [command, argument] = argv;
  if (command === "run") return run(env);
  if (command === "run-locked") return runLocked(env);
  if (command === "sync-workflow") return syncWorkflow(env);
  if (command === "sync-workflow-locked") return syncWorkflowLocked(env);
  if (command === "install") return withLock("install-locked", env, 1);
  if (command === "install-locked") return installLocked(env);
  if (command === "uninstall") return uninstall(env);
  if (command === "verify-launchd") return verifyLaunchd(env);
  if (command === "probe" && argument) {
    mkdirSync(dirname(argument), { recursive: true });
    writeFileSync(argument, "ok\n");
    return 0;
  }
  throw new Error(`Unknown command: ${command ?? ""}`);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
