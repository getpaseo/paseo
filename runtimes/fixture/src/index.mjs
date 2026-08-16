#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { watch } from "node:fs";
import { chmod, cp, copyFile, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Socket } from "node:net";
import { createInterface } from "node:readline";
import * as pty from "node-pty";

const workspaceHelper = fileURLToPath(new URL("../dist/paseo-workspace-helper", import.meta.url));
import {
  COMMAND_RUNTIME_PROTOCOL_VERSION,
  CommandRuntimeControlSchema,
  CommandRuntimeDescribeResponseSchema,
  CommandRuntimeLifecycleRequestSchema,
  CommandRuntimeLifecycleResponseSchema,
  CommandRuntimeProcessEventSchema,
  encodeCommandRuntimeMessage,
} from "@getpaseo/workspace-runtime-contract";

const operation = process.argv
  .slice(2)
  .find((value) =>
    ["describe", "create", "inspect", "exec", "signal", "pause", "resume", "destroy"].includes(
      value,
    ),
  );
const workspaceId = argument("--workspace-id");
let pipeChild = null;
let forwardedPipeSignal = null;
const pipeSignalHandlers = new Map();
if (operation === "exec") {
  for (const signalName of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const handler = () => {
      forwardedPipeSignal = signalName;
      if (pipeChild) killGroup(pipeChild.pid, signalName);
    };
    pipeSignalHandlers.set(signalName, handler);
    process.on(signalName, handler);
  }
}

try {
  if (operation === "describe") {
    const protocolVersion = Number(
      argument("--protocol-version") ?? COMMAND_RUNTIME_PROTOCOL_VERSION,
    );
    const response = {
      protocolVersion,
      modes: argument("--modes") === "pipes" ? ["pipes"] : ["pipes", "pty"],
    };
    if (protocolVersion === COMMAND_RUNTIME_PROTOCOL_VERSION) {
      writeJson(CommandRuntimeDescribeResponseSchema, response);
    } else {
      process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  } else if (!workspaceId) {
    throw new Error("--workspace-id is required");
  } else if (operation === "exec") {
    await execute(workspaceId);
  } else if (operation === "signal") {
    await signal(workspaceId, requireArgument("--exec-id"), requireArgument("--signal"));
  } else {
    const request = CommandRuntimeLifecycleRequestSchema.parse(
      JSON.parse(await readStream(process.stdin)),
    );
    switch (operation) {
      case "create":
        {
          const result = await create(workspaceId, request);
          writeJson(CommandRuntimeLifecycleResponseSchema, {
            protocolVersion: COMMAND_RUNTIME_PROTOCOL_VERSION,
            type: "state",
            state: publicState(result.state),
            placement: publicPlacement(result.state),
            materializedFreshContent: result.materializedFreshContent,
          });
        }
        break;
      case "inspect":
        writeJson(CommandRuntimeLifecycleResponseSchema, {
          protocolVersion: COMMAND_RUNTIME_PROTOCOL_VERSION,
          type: "inspection",
          inspection: await inspect(workspaceId, request.options),
        });
        break;
      case "pause":
        await setLifecycle(workspaceId, request.options, "paused");
        writeJson(CommandRuntimeLifecycleResponseSchema, {
          protocolVersion: COMMAND_RUNTIME_PROTOCOL_VERSION,
          type: "ok",
        });
        break;
      case "resume":
        {
          const state = await setLifecycle(workspaceId, request.options, "ready");
          writeJson(CommandRuntimeLifecycleResponseSchema, {
            protocolVersion: COMMAND_RUNTIME_PROTOCOL_VERSION,
            type: "state",
            state: publicState(state),
            placement: publicPlacement(state),
          });
        }
        break;
      case "destroy":
        await destroy(workspaceId, request.options);
        writeJson(CommandRuntimeLifecycleResponseSchema, {
          protocolVersion: COMMAND_RUNTIME_PROTOCOL_VERSION,
          type: "ok",
        });
        break;
      default:
        throw new Error(`Unknown operation: ${operation}`);
    }
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

async function create(id, request) {
  const existing = await readState(id, request.options);
  if (existing) return { state: existing, materializedFreshContent: false };
  if (request.options.failCreate === true) {
    throw new Error(String(request.options.createError ?? "Fixture workspace creation failed"));
  }
  const sourceRoot = request.input.project.source.path;
  const ownedRoot = request.options.materializeRoot
    ? path.join(request.options.materializeRoot, id)
    : null;
  const root = ownedRoot ?? sourceRoot;
  if (ownedRoot) {
    await rm(ownedRoot, { recursive: true, force: true });
    await mkdir(path.dirname(ownedRoot), { recursive: true });
    await cp(sourceRoot, ownedRoot, { recursive: true });
  }
  if (request.options.fixtureProviderSource) {
    const providerPath = path.join(root, ".paseo-fixture-agent.mjs");
    await copyFile(request.options.fixtureProviderSource, providerPath);
    await chmod(providerPath, 0o755);
  }
  const state = {
    workspaceId: id,
    root,
    displayCwd: request.options.preserveSourceDisplayCwd
      ? sourceRoot
      : (request.options.displayCwd ?? root),
    lifecycle: "ready",
    lifecycleEnvironment: request.options.lifecycleEnvironment,
    ownedRoot,
    createInput: request.input,
  };
  await mkdir(request.options.stateDirectory, { recursive: true });
  await writeFile(stateFile(id, request.options), JSON.stringify(state));
  return { state, materializedFreshContent: true };
}

async function destroy(id, options) {
  const state = await readState(id, options);
  if (state?.ownedRoot) await rm(state.ownedRoot, { recursive: true, force: true });
  await rm(stateFile(id, options), { force: true });
}

async function inspect(id, options) {
  await applyInspectBarrier(options);
  const state = await readState(id, options);
  return state
    ? { status: state.lifecycle, state: publicState(state), placement: publicPlacement(state) }
    : { status: "missing" };
}

function publicState(state) {
  return {
    workspaceId: state.workspaceId,
    lifecycle: state.lifecycle,
    ...(state.lifecycleEnvironment ? { lifecycleEnvironment: state.lifecycleEnvironment } : {}),
  };
}

function publicPlacement(state) {
  return { cwd: state.displayCwd };
}

async function setLifecycle(id, options, lifecycle) {
  const state = await readState(id, options);
  if (!state) throw new Error(`Fixture workspace is missing: ${id}`);
  const updated = { ...state, lifecycle };
  await writeFile(stateFile(id, options), JSON.stringify(updated));
  return updated;
}

async function execute(id) {
  const control = new Socket({ fd: 3, readable: true, writable: false });
  const lines = createInterface({ input: control, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done) throw new Error("spawn control is required");
  const envelope = CommandRuntimeControlSchema.parse(JSON.parse(first.value));
  if (envelope.type !== "spawn") throw new Error("spawn control is required");
  const state = await readState(id, envelope.options);
  if (!state) throw new Error(`Fixture workspace is missing: ${id}`);
  if (envelope.options.recordLaunchInWorkspace !== false) {
    await writeFile(
      path.join(state.root, ".runtime-launch.json"),
      JSON.stringify({ argv: process.argv, purpose: envelope.purpose }),
    );
  }
  if (envelope.stdio.kind === "pty") {
    for (const [signalName, handler] of pipeSignalHandlers) process.off(signalName, handler);
    await executePty(id, envelope, iterator, control);
    control.destroy();
    return;
  }
  const events = new Socket({ fd: 4, readable: false, writable: true });
  const argv = resolveFixtureCommand(envelope);
  pipeChild = spawn(argv[0], argv.slice(1), {
    cwd: await resolveCwd(state.root, envelope.cwd),
    env: envelope.env,
    detached: true,
    stdio: ["inherit", "inherit", "inherit"],
  });
  const exitPromise = new Promise((resolve, reject) => {
    pipeChild.once("error", reject);
    pipeChild.once("exit", (code, signalName) => resolve({ code, signal: signalName }));
  });
  await writeFile(execFile(id, envelope.execId, envelope.options), String(pipeChild.pid));
  if (
    envelope.options.recordWorkloadPidAt &&
    envelope.options.processEventPurposeKind === envelope.purpose.kind
  ) {
    await writeFile(envelope.options.recordWorkloadPidAt, String(pipeChild.pid));
  }
  if (await emitConfiguredProcessEvents(events, envelope.options, envelope.purpose)) {
    await exitPromise;
    await rm(execFile(id, envelope.execId, envelope.options), { force: true });
    return;
  }
  events.write(
    encodeCommandRuntimeMessage(CommandRuntimeProcessEventSchema, {
      protocolVersion: COMMAND_RUNTIME_PROTOCOL_VERSION,
      type: "started",
    }),
  );
  if (forwardedPipeSignal) killGroup(pipeChild.pid, forwardedPipeSignal);
  if (
    envelope.options.crashPipeWrapper &&
    envelope.purpose.kind === "workspace-script" &&
    (await consumePipeWrapperCrash(id, envelope.options))
  ) {
    process.exit(47);
  }
  const exit = await exitPromise;
  await rm(execFile(id, envelope.execId, envelope.options), { force: true });
  for (const [signalName, handler] of pipeSignalHandlers) process.off(signalName, handler);
  const signalName = exit.signal ?? forwardedPipeSignal;
  events.write(
    encodeCommandRuntimeMessage(CommandRuntimeProcessEventSchema, {
      protocolVersion: COMMAND_RUNTIME_PROTOCOL_VERSION,
      type: "eof",
    }),
  );
  await new Promise((resolve, reject) =>
    events
      .end(
        encodeCommandRuntimeMessage(CommandRuntimeProcessEventSchema, {
          protocolVersion: COMMAND_RUNTIME_PROTOCOL_VERSION,
          type: "exit",
          code: signalName ? null : exit.code,
          signal: signalName,
        }),
        resolve,
      )
      .once("error", reject),
  );
  if (signalName) {
    process.removeAllListeners(signalName);
    process.kill(process.pid, signalName);
  } else {
    process.exitCode = exit.code ?? 1;
  }
}

function resolveFixtureCommand(envelope) {
  if (envelope.purpose.kind !== "workspace-helper") return envelope.argv;
  const configured = envelope.options.fixtureHelperCommand;
  if (Array.isArray(configured) && configured.every((value) => typeof value === "string")) {
    return [...configured, ...envelope.argv.slice(1)];
  }
  return [process.execPath, workspaceHelper, ...envelope.argv.slice(1)];
}

async function executePty(id, envelope, controls, controlStream) {
  const events = new Socket({ fd: 4, readable: false, writable: true });
  const child = pty.spawn(envelope.argv[0], envelope.argv.slice(1), {
    cwd: await resolveCwd((await readState(id, envelope.options)).root, envelope.cwd),
    env: envelope.env,
    name: envelope.stdio.term ?? "xterm-256color",
    cols: envelope.stdio.cols,
    rows: envelope.stdio.rows,
  });
  await writeFile(execFile(id, envelope.execId, envelope.options), String(child.pid));
  if (
    envelope.options.recordWorkloadPidAt &&
    envelope.options.processEventPurposeKind === envelope.purpose.kind
  ) {
    await writeFile(envelope.options.recordWorkloadPidAt, String(child.pid));
  }
  if (await emitConfiguredProcessEvents(events, envelope.options, envelope.purpose)) {
    await new Promise((resolve) => child.onExit(resolve));
    await rm(execFile(id, envelope.execId, envelope.options), { force: true });
    return;
  }
  events.write(
    encodeCommandRuntimeMessage(CommandRuntimeProcessEventSchema, {
      protocolVersion: COMMAND_RUNTIME_PROTOCOL_VERSION,
      type: "started",
    }),
  );
  if (envelope.options.closePtyControl) setTimeout(() => controlStream.destroy(), 100);
  process.stdin.on("data", (data) => child.write(data.toString()));
  child.onData((data) => process.stdout.write(data));
  if (envelope.options.invalidPtyEvent) {
    setTimeout(
      () =>
        events.end(
          `${JSON.stringify({ protocolVersion: COMMAND_RUNTIME_PROTOCOL_VERSION, type: "invalid" })}\n`,
        ),
      100,
    );
  }
  let requestedSignal = null;
  void (async () => {
    while (true) {
      const next = await controls.next();
      if (next.done) return;
      const control = CommandRuntimeControlSchema.parse(JSON.parse(next.value));
      if (control.type === "resize") {
        child.resize(control.cols, control.rows);
        events.write(
          `${JSON.stringify({ protocolVersion: COMMAND_RUNTIME_PROTOCOL_VERSION, type: "resized", id: control.id })}\n`,
        );
      } else if (control.type === "signal") {
        requestedSignal = control.signal;
        child.kill(control.signal);
      } else throw new Error(`Unexpected PTY control: ${control.type}`);
    }
  })().catch((error) => {
    events.write(
      `${JSON.stringify({ protocolVersion: COMMAND_RUNTIME_PROTOCOL_VERSION, type: "error", message: error.message })}\n`,
    );
    child.kill("SIGKILL");
  });
  const exit = await new Promise((resolve) =>
    child.onExit(({ exitCode, signal: signalNumber }) =>
      resolve({ exitCode, signal: signalNumber }),
    ),
  );
  await rm(execFile(id, envelope.execId, envelope.options), { force: true });
  process.stdin.destroy();
  if (envelope.options.invalidPtyEvent) return;
  events.write(
    `${JSON.stringify({ protocolVersion: COMMAND_RUNTIME_PROTOCOL_VERSION, type: "eof" })}\n`,
  );
  if (envelope.options.omitPtyExitEvent) {
    events.end();
    return;
  }
  const exitEvent = `${JSON.stringify({
    protocolVersion: COMMAND_RUNTIME_PROTOCOL_VERSION,
    type: "exit",
    code: requestedSignal || exit.signal ? null : exit.exitCode,
    signal: requestedSignal,
  })}\n`;
  if (envelope.options.delayedPtyExitEvent) {
    const writer = spawn(
      process.execPath,
      [
        "-e",
        `setTimeout(()=>{require('node:fs').writeSync(4,${JSON.stringify(exitEvent)});},1000)`,
      ],
      { detached: true, stdio: ["ignore", "ignore", "ignore", "ignore", events] },
    );
    writer.unref();
    events.destroy();
    return;
  }
  events.end(exitEvent);
}

async function emitConfiguredProcessEvents(events, options, purpose) {
  if (!Array.isArray(options.processEventSequence)) return false;
  if (options.processEventPurposeKind !== purpose.kind) return false;
  if (options.processEventBarrierPath) await waitForFile(options.processEventBarrierPath);
  const values = options.processEventSequence.map((type) => {
    if (type === "exit") {
      return { type, protocolVersion: COMMAND_RUNTIME_PROTOCOL_VERSION, code: 0, signal: null };
    }
    if (type === "resized") {
      return { type, protocolVersion: COMMAND_RUNTIME_PROTOCOL_VERSION, id: 1 };
    }
    return { type, protocolVersion: COMMAND_RUNTIME_PROTOCOL_VERSION };
  });
  await new Promise((resolve, reject) => {
    events
      .end(
        values
          .map((value) => encodeCommandRuntimeMessage(CommandRuntimeProcessEventSchema, value))
          .join(""),
        resolve,
      )
      .once("error", reject);
  });
  return true;
}

async function waitForFile(file) {
  try {
    await readFile(file);
    return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await new Promise((resolve, reject) => {
    const watcher = watch(path.dirname(file), (event, name) => {
      if (name?.toString() !== path.basename(file)) return;
      watcher.close();
      resolve();
    });
    watcher.once("error", reject);
    void readFile(file).then(
      () => {
        watcher.close();
        resolve();
        return undefined;
      },
      (error) => {
        if (error.code !== "ENOENT") {
          watcher.close();
          reject(error);
        }
        return undefined;
      },
    );
  });
}

async function signal(id, execId, signalName) {
  const { options } = CommandRuntimeLifecycleRequestSchema.parse(
    JSON.parse(await readStream(process.stdin)),
  );
  let pid;
  try {
    pid = Number(await readFile(execFile(id, execId, options), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  killGroup(pid, signalName);
  await waitForProcessExit(pid);
  await rm(execFile(id, execId, options), { force: true });
  if (options.signalHelperFailure === "error") throw new Error("fixture signal helper failed");
  if (options.signalHelperFailure === "hang") {
    if (options.signalHelperDescendantPidFileName) {
      const state = await readState(id, options);
      const descendant = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
        stdio: "ignore",
      });
      await writeFile(
        path.join(state.root, options.signalHelperDescendantPidFileName),
        String(descendant.pid),
      );
    }
    await new Promise(() => setInterval(() => {}, 1_000));
  }
}

async function waitForProcessExit(pid) {
  const deadline = Date.now() + 1_000;
  while (processExists(pid)) {
    if (Date.now() >= deadline) throw new Error(`Fixture workload remained alive: ${pid}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

async function applyInspectBarrier(options) {
  if (!options.inspectBarrierDirectory) return;
  const next = path.join(options.inspectBarrierDirectory, "block-next-inspect");
  try {
    await rm(next);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  await writeFile(path.join(options.inspectBarrierDirectory, "inspect-entered"), "entered");
  const release = path.join(options.inspectBarrierDirectory, "release-inspect");
  while (true) {
    try {
      await readFile(release);
      return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

async function readState(id, options) {
  try {
    return JSON.parse(await readFile(stateFile(id, options), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function consumePipeWrapperCrash(id, options) {
  const state = await readState(id, options);
  if (!state || state.pipeWrapperCrashConsumed) return false;
  await writeFile(
    stateFile(id, options),
    JSON.stringify({ ...state, pipeWrapperCrashConsumed: true }),
  );
  return true;
}

function stateFile(id, options) {
  return path.join(options.stateDirectory, `${key(id)}.json`);
}

function execFile(id, execId, options) {
  return path.join(options.stateDirectory, `${key(id)}-${execId}.pid`);
}

function key(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function resolveCwd(root, relativeCwd) {
  const canonicalRoot = await realpath(root);
  const canonicalCwd = await realpath(path.resolve(canonicalRoot, relativeCwd ?? "."));
  const relative = path.relative(canonicalRoot, canonicalCwd);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Workspace cwd escapes its runtime root");
  }
  return canonicalCwd;
}

function killGroup(pid, signalName) {
  try {
    process.kill(-pid, signalName);
  } catch {
    process.kill(pid, signalName);
  }
}

function argument(flag) {
  const index = process.argv.indexOf(flag, 2);
  return index < 0 ? undefined : process.argv[index + 1];
}

function requireArgument(flag) {
  const value = argument(flag);
  if (!value) throw new Error(`${flag} is required`);
  return value;
}

async function readStream(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function writeJson(schema, value) {
  process.stdout.write(encodeCommandRuntimeMessage(schema, value));
}
