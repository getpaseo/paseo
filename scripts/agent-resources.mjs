#!/usr/bin/env node
import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isMainModule } from "./is-main-module.mjs";

const exec = promisify(execFile);
const SLICE = "agent-workloads.slice";
const OWNED_UNIT = /^paseo-agent-[a-zA-Z0-9_-]+\.scope$/;
const OWNER_IDENTITY = /^paseo-agent-.+-(\d+)-(\d+)-[0-9a-f-]{36}\.scope$/;
const LEGACY_UNIT = /^(codex|claude)-\d+-\d+\.scope$/;
const FIELDS = [
  "Id",
  "ActiveState",
  "ControlGroup",
  "MemoryCurrent",
  "MemoryPeak",
  "MemoryHigh",
  "MemoryMax",
  "MemorySwapCurrent",
  "MemorySwapMax",
  "CPUUsageNSec",
  "TasksCurrent",
  "TasksMax",
  "CPUQuotaPerSecUSec",
  "Result",
];

function positiveInteger(text, name) {
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer`);
  return value;
}

export function parseRun(args) {
  let timeoutSeconds = null;
  let index = 0;
  while (args[index] !== "--") {
    if (args[index] !== "--timeout" || !args[index + 1]) {
      throw new Error("Usage: run [--timeout seconds] -- command [args...]");
    }
    timeoutSeconds = positiveInteger(args[index + 1], "timeout");
    index += 2;
  }
  const command = args.slice(index + 1);
  if (command.length === 0) throw new Error("A command is required after --");
  return { command, timeoutSeconds };
}

export function scopeArguments({
  unit,
  command,
  timeoutSeconds,
  memoryHigh = "6G",
  memoryMax = "8G",
}) {
  for (const limit of [memoryHigh, memoryMax]) {
    if (!/^[1-9]\d*[KMGT]?$/.test(limit)) throw new Error("Invalid memory limit");
  }
  if (!OWNED_UNIT.test(unit)) throw new Error("Invalid owned scope name");
  const args = [
    "--user",
    "--scope",
    "--quiet",
    "--collect",
    "--expand-environment=no",
    `--slice=${SLICE}`,
    `--unit=${unit}`,
    "--description=Paseo agent workload",
    `--property=MemoryHigh=${memoryHigh}`,
    `--property=MemoryMax=${memoryMax}`,
    "--property=MemorySwapMax=768M",
    "--property=TasksMax=600",
    "--property=CPUQuota=300%",
    "--property=CPUWeight=50",
    "--property=IOWeight=50",
    "--property=TimeoutStopSec=5s",
  ];
  if (timeoutSeconds !== null) args.push(`--property=RuntimeMaxSec=${timeoutSeconds}s`);
  return [...args, "--", ...command];
}

export function assertAggregateLimits(properties) {
  for (const field of ["MemoryMax", "MemorySwapMax", "TasksMax", "CPUQuotaPerSecUSec"]) {
    if (!properties[field] || properties[field] === "infinity") {
      throw new Error(`Configure a finite ${field} on ${SLICE} before launching workloads`);
    }
  }
}

export function parseProperties(output) {
  return Object.fromEntries(
    output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const equals = line.indexOf("=");
        if (equals < 1) throw new Error("Malformed systemd property");
        return [line.slice(0, equals), line.slice(equals + 1)];
      }),
  );
}

export function assertStoppable({ unit, properties, selfCgroup }) {
  if (!OWNED_UNIT.test(unit) && !LEGACY_UNIT.test(unit)) throw new Error("Not an agent scope");
  const group = properties.ControlGroup;
  if (properties.Id !== unit || !group || !group.endsWith(`/${SLICE}/${unit}`)) {
    throw new Error("Scope is not owned by the agent workload slice");
  }
  const ownGroups = selfCgroup
    .trim()
    .split("\n")
    .map((line) => line.slice(line.indexOf(":", line.indexOf(":") + 1) + 1));
  if (ownGroups.some((own) => own === group || own.startsWith(`${group}/`))) {
    throw new Error("Cannot stop this session's own scope");
  }
}

async function systemctl(args) {
  const result = await exec("systemctl", ["--user", ...args], {
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  return result.stdout;
}

async function inspect(unit) {
  return parseProperties(
    await systemctl(["show", unit, ...FIELDS.map((field) => `--property=${field}`)]),
  );
}

/** Both natural exit and an interrupted wrapper release detached descendants. */
export async function superviseScope({ launch, stop, watchParent, signals }) {
  const child = launch();
  let interrupted = false;
  let stopPromise = null;
  function release() {
    stopPromise ??= stop();
    return stopPromise;
  }
  function interrupt() {
    interrupted = true;
    void release().catch(() => {});
  }
  const unwatch = watchParent(interrupt);
  const unsubscribe = signals(interrupt);
  try {
    const code = await child;
    return interrupted ? 143 : code;
  } finally {
    unwatch();
    unsubscribe();
    await release();
  }
}

function launchCommand(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : 143)));
  });
}

function watchParentProcess(parent, interrupt) {
  const timer = setInterval(() => {
    if (process.ppid !== parent) interrupt();
  }, 1000);
  timer.unref();
  return () => clearInterval(timer);
}

function interruptSignals(interrupt) {
  process.on("SIGTERM", interrupt);
  process.on("SIGINT", interrupt);
  return () => {
    process.off("SIGTERM", interrupt);
    process.off("SIGINT", interrupt);
  };
}

export function processStartTicks(stat) {
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
}

export async function ownerIsAlive(unit, read = readFile) {
  const owner = OWNER_IDENTITY.exec(unit);
  if (!owner) return true; // Legacy scopes have no verifiable wrapper identity.
  try {
    const stat = await read(`/proc/${owner[1]}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
    // An unreaped zombie retains its stat file and matching birth time.
    if (state === "Z" || state === "X") return false;
    return processStartTicks(stat) === owner[2];
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ESRCH") return false;
    throw error;
  }
}

async function run(args) {
  const parent = process.ppid;
  const parsed = parseRun(args);
  assertAggregateLimits(await inspect(SLICE));
  const agent = (process.env.PASEO_AGENT_ID ?? "manual")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 70);
  const ticks = processStartTicks(await readFile("/proc/self/stat", "utf8"));
  const unit = `paseo-agent-${agent}-${process.pid}-${ticks}-${randomUUID()}.scope`;
  let exited = false;
  const workload = launchCommand(
    "systemd-run",
    scopeArguments({
      unit,
      ...parsed,
      memoryHigh: process.env.PASEO_RESOURCE_MEMORY_HIGH ?? "6G",
      memoryMax: process.env.PASEO_RESOURCE_MEMORY_MAX ?? "8G",
    }),
    { ...process.env, PASEO_RESOURCE_SCOPE: unit },
  ).finally(() => {
    exited = true;
  });
  return superviseScope({
    launch: () => workload,
    stop: async () => {
      // A collected unit has already disappeared. No other stop failure is ignored.
      // A signal can arrive before systemd has admitted the scope. Keep waiting
      // for admission while the launcher lives, so the first stop cannot miss it.
      while (true) {
        try {
          await exec("systemctl", ["--user", "stop", unit], { timeout: 15_000 });
          return;
        } catch (error) {
          const state = await systemctl(["show", unit, "--property=LoadState", "--value"]);
          if (state.trim() !== "not-found") throw error;
          if (exited) return;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    },
    watchParent: (interrupt) => watchParentProcess(parent, interrupt),
    signals: interruptSignals,
  });
}

// flock is held by the supervising shell for the complete scope lifetime. Kernel
// locks release on crashes; there are no stale lock files to guess about or reap.
export const JOB_SHELL = `
set -eu
owner=$2
owner_start=$3
workload=

owner_alive() {
  local stat tail
  local -a fields
  IFS= read -r stat 2>/dev/null < "/proc/$owner/stat" || return 1
  tail=\${stat##*) }
  read -r -a fields <<< "$tail"
  [[ \${fields[19]:-} == "$owner_start" && \${fields[0]:-} != Z && \${fields[0]:-} != X ]]
}

cancel() {
  trap '' TERM INT
  if [[ -n "$workload" ]]; then
    kill -TERM "$workload" 2>/dev/null || true
    wait "$workload" 2>/dev/null || true
  fi
  exit 143
}
trap cancel TERM INT

exec 8>"$1/slot-1"
exec 9>"$1/slot-2"
shift 3
deadline=$((SECONDS + 600))
while true; do
  owner_alive || cancel
  if flock --nonblock 8; then break; fi
  if flock --nonblock 9; then break; fi
  if (( SECONDS >= deadline )); then echo "Heavy-job queue timed out after 600 seconds" >&2; exit 124; fi
  sleep 1
done
# SIGKILL cannot be forwarded by Node. Check its birth identity again after
# admission, then keep watching it while run supervises the eventual scope.
owner_alive || cancel
"$@" <&0 &
workload=$!
while kill -0 "$workload" 2>/dev/null; do
  owner_alive || cancel
  sleep 1
done
status=0
wait "$workload" || status=$?
exit "$status"
`;

async function job(args) {
  const parsed = parseRun(args);
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  if (!runtimeDir) throw new Error("XDG_RUNTIME_DIR is required for per-user heavy-job slots");
  const slots = path.join(runtimeDir, "paseo-heavy-jobs");
  await mkdir(slots, { recursive: true, mode: 0o700 });
  const command = [
    process.execPath,
    fileURLToPath(import.meta.url),
    "run",
    "--timeout",
    String(parsed.timeoutSeconds ?? 1800),
    "--",
    ...parsed.command,
  ];
  return launchQueuedCommand({ slots, command });
}

export async function launchQueuedCommand({ slots, command }) {
  const parent = process.ppid;
  const ticks = processStartTicks(await readFile("/proc/self/stat", "utf8"));
  // A private process group lets cancellation reach the polling sleep and the
  // run supervisor without signalling the caller's session or other jobs.
  const child = spawn(
    "bash",
    ["-c", JOB_SHELL, "paseo-heavy-job", slots, String(process.pid), ticks, ...command],
    { stdio: "inherit", detached: true },
  );
  const workload = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : 143)));
  });
  return superviseScope({
    launch: () => workload,
    stop: async () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    },
    watchParent: (interrupt) => watchParentProcess(parent, interrupt),
    signals: interruptSignals,
  });
}

export async function main(args) {
  if (process.platform !== "linux")
    throw new Error("Agent scopes require Linux with a systemd user manager");
  const [action, ...rest] = args;
  if (action === "run") return run(rest);
  if (action === "job") return job(rest);
  if ((action === "list" || action === "reap") && rest.length === 0) {
    const output = await systemctl([
      "list-units",
      "--type=scope",
      "--all",
      "--output=json",
      "--no-pager",
    ]);
    const units = JSON.parse(output)
      .map((unit) => unit.unit)
      .filter((unit) => OWNED_UNIT.test(unit) || LEGACY_UNIT.test(unit));
    const rows = [];
    for (const unit of units) {
      const properties = await inspect(unit);
      const alive = await ownerIsAlive(unit);
      if (action === "reap" && !alive && properties.ControlGroup) {
        assertStoppable({
          unit,
          properties,
          selfCgroup: await readFile("/proc/self/cgroup", "utf8"),
        });
        await systemctl(["stop", unit]);
        process.stdout.write(`Reaped orphaned scope ${unit}\n`);
      }
      rows.push({ ...properties, wrapperAlive: alive });
    }
    if (action === "reap") return 0;
    process.stdout.write(
      `${JSON.stringify({ aggregate: await inspect(SLICE), scopes: rows }, null, 2)}\n`,
    );
    return 0;
  }
  if (action === "stop" && rest.length === 1) {
    const unit = rest[0];
    const properties = await inspect(unit);
    assertStoppable({ unit, properties, selfCgroup: await readFile("/proc/self/cgroup", "utf8") });
    await systemctl(["stop", unit]);
    process.stdout.write(`Stopped ${unit} and its descendants\n`);
    return 0;
  }
  throw new Error(
    "Usage: agent-resources.mjs list | reap | stop <scope> | run [--timeout seconds] -- <command> | job [--timeout seconds] -- <command>",
  );
}

if (isMainModule(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`Agent resource management failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
