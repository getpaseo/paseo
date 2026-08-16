import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:os";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

import {
  COMMAND_RUNTIME_PROTOCOL_VERSION,
  CommandRuntimeControlSchema,
  CommandRuntimeDescribeResponseSchema,
  CommandRuntimeLifecycleRequestSchema,
  CommandRuntimeLifecycleResponseSchema,
  createCommandRuntimeProcessEventDecoder,
  encodeCommandRuntimeMessage,
  type CommandRuntimeProcessEvent,
} from "@getpaseo/workspace-runtime-contract";

import type {
  WorkspaceDriverCreateInput,
  WorkspaceDriverInspection,
  WorkspaceDriverState,
  WorkspaceDriverSpawnInput,
  WorkspacePipeProcess,
  WorkspacePtyProcess,
  WorkspaceRuntimeDriver,
} from "../../drivers/index.js";
import type { WorkspaceRuntimeJsonValue } from "../../index.js";
const COMMAND_RUNTIME_CLEANUP_TIMEOUT_MS = 750;

export interface CommandRuntimeConfig {
  command: readonly [string, ...string[]];
  options?: Readonly<Record<string, WorkspaceRuntimeJsonValue>>;
}

export function createCommandRuntime(
  runtimeId: string,
  config: CommandRuntimeConfig,
  runtimeInstanceId: string,
  packageResolutionBase: string,
  pathResolutionBase: string,
): WorkspaceRuntimeDriver {
  const command = resolveRuntimeCommand(config.command, packageResolutionBase, pathResolutionBase);
  let described: Promise<ReadonlySet<"pipes" | "pty">> | null = null;
  let supportsReconciliation = false;

  function describe(): Promise<ReadonlySet<"pipes" | "pty">> {
    described ??= runCommand(["describe"], undefined).then((output) => {
      const value: unknown = JSON.parse(output);
      assertProtocolVersion(runtimeId, value);
      const description = CommandRuntimeDescribeResponseSchema.parse(value);
      if (!description.modes.includes("pipes")) {
        throw new Error(`Workspace runtime ${runtimeId} does not support pipes`);
      }
      supportsReconciliation = description.reconcile;
      return new Set(description.modes);
    });
    return described;
  }

  async function lifecycle(
    operation: "create" | "inspect" | "pause" | "resume" | "destroy",
    workspaceId: string,
    input?: WorkspaceDriverCreateInput,
  ) {
    await describe();
    const output = await runCommand(
      [operation, "--workspace-id", workspaceId],
      encodeCommandRuntimeMessage(CommandRuntimeLifecycleRequestSchema, {
        protocolVersion: COMMAND_RUNTIME_PROTOCOL_VERSION,
        runtimeInstanceId,
        input: input ? commandCreateInput(input) : undefined,
        options: config.options ?? {},
      }),
    );
    const value: unknown = JSON.parse(output);
    assertProtocolVersion(runtimeId, value);
    return CommandRuntimeLifecycleResponseSchema.parse(value);
  }

  return {
    id: runtimeId,
    requiresGitProject: true,
    reconciliationDomainId: JSON.stringify({ command, options: config.options }),
    workspaceHelper: {
      command: ["paseo-workspace-helper"],
      env: {},
    },
    scriptTerminal: { kind: "direct-command", command: "/bin/sh", argsPrefix: ["-lc"] },
    provider: { environment: "isolated", sharedHostProviders: new Set() },
    async create(input) {
      const response = await lifecycle("create", input.workspaceId, input);
      if (response.type !== "state") throw new Error(`Invalid create response from ${runtimeId}`);
      if (response.materializedFreshContent === undefined) {
        throw new Error(
          `Workspace runtime ${runtimeId} create response is missing materializedFreshContent`,
        );
      }
      return {
        ...commandReady(response.state, response.placement),
        materializedFreshContent: response.materializedFreshContent,
      };
    },
    async inspect(workspaceId): Promise<WorkspaceDriverInspection> {
      const response = await lifecycle("inspect", workspaceId);
      if (response.type !== "inspection") {
        throw new Error(`Invalid inspect response from ${runtimeId}`);
      }
      if (response.inspection.status === "ready" || response.inspection.status === "paused") {
        return {
          ...response.inspection,
          ...commandReady(response.inspection.state, response.inspection.placement),
        };
      }
      return response.inspection as WorkspaceDriverInspection;
    },
    async spawn(input) {
      const modes = await describe();
      if (input.stdio.kind === "pty") {
        if (!modes.has("pty")) {
          throw new Error(`Workspace runtime ${runtimeId} does not support PTY mode`);
        }
        return spawnCommandPty(runtimeId, command, input, config.options ?? {}, runtimeInstanceId);
      }
      return spawnCommandProcess(
        runtimeId,
        command,
        input,
        config.options ?? {},
        runtimeInstanceId,
      );
    },
    async pause(workspaceId) {
      const response = await lifecycle("pause", workspaceId);
      if (response.type !== "ok") throw new Error(`Invalid pause response from ${runtimeId}`);
    },
    async resume(workspaceId) {
      const response = await lifecycle("resume", workspaceId);
      if (response.type !== "state") throw new Error(`Invalid resume response from ${runtimeId}`);
      return commandReady(response.state, response.placement);
    },
    async destroy(workspaceId) {
      const response = await lifecycle("destroy", workspaceId);
      if (response.type !== "ok") throw new Error(`Invalid destroy response from ${runtimeId}`);
    },
    async reconcile(workspaceIds) {
      await describe();
      if (!supportsReconciliation) return;
      const output = await runCommand(
        ["reconcile"],
        encodeCommandRuntimeMessage(CommandRuntimeLifecycleRequestSchema, {
          protocolVersion: COMMAND_RUNTIME_PROTOCOL_VERSION,
          runtimeInstanceId,
          workspaceIds,
          options: config.options ?? {},
        }),
      );
      const value: unknown = JSON.parse(output);
      assertProtocolVersion(runtimeId, value);
      const response = CommandRuntimeLifecycleResponseSchema.parse(value);
      if (response.type !== "ok") throw new Error(`Invalid reconcile response from ${runtimeId}`);
    },
  };

  async function runCommand(args: string[], stdin: string | undefined): Promise<string> {
    const child = spawn(command[0], [...command.slice(1), ...args], {
      env: commandEnvironment(),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (stdin === undefined) child.stdin.end();
    else child.stdin.end(stdin);
    const [stdout, stderr, exit] = await Promise.all([
      collect(child.stdout),
      collect(child.stderr),
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      }),
    ]);
    if (exit.code !== 0) {
      throw new Error(
        `Workspace runtime ${runtimeId} ${args[0]} failed (${exit.code ?? exit.signal}): ${stderr.trim()}`,
      );
    }
    return stdout;
  }
}

function commandReady(state: WorkspaceDriverState, placement: { cwd: string } | undefined) {
  if (!placement) {
    throw new Error("Workspace runtime did not return public placement");
  }
  return { state, placement };
}

function commandCreateInput(input: WorkspaceDriverCreateInput) {
  return {
    ...input,
    project: {
      ...input.project,
      source:
        input.project.source.kind === "host-directory"
          ? { kind: "directory" as const, path: input.project.source.path }
          : input.project.source,
    },
    purpose: input.purpose === "provider-probe" ? ("discovery" as const) : undefined,
  };
}

function commandPurpose(input: WorkspaceDriverSpawnInput["purpose"]) {
  switch (input.kind) {
    case "provider-probe":
      return { kind: "discovery" as const };
    case "agent":
    case "terminal":
    case "workspace-script":
      return { kind: input.kind };
    default:
      return input;
  }
}

function assertProtocolVersion(runtimeId: string, value: unknown): void {
  const version =
    typeof value === "object" && value !== null && "protocolVersion" in value
      ? value.protocolVersion
      : undefined;
  if (version === COMMAND_RUNTIME_PROTOCOL_VERSION) return;
  throw new Error(
    `Workspace runtime ${runtimeId} uses unsupported command protocol version ${String(version)}; expected ${COMMAND_RUNTIME_PROTOCOL_VERSION}`,
  );
}

function spawnCommandPty(
  runtimeId: string,
  command: readonly [string, ...string[]],
  input: WorkspaceDriverSpawnInput,
  options: Readonly<Record<string, unknown>>,
  runtimeInstanceId: string,
): WorkspacePtyProcess {
  if (input.stdio.kind !== "pty") throw new Error("PTY spawn requires PTY stdio");
  const execId = randomBytes(16).toString("hex");
  const child = spawn(
    command[0],
    [...command.slice(1), "exec", "--workspace-id", input.workspaceId],
    {
      env: commandEnvironment(),
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
    },
  );
  const control = child.stdio[3] as Writable;
  const events = child.stdio[4] as Readable;
  const listeners = new Set<(data: string) => void>();
  let pendingData = "";
  const decoder = new StringDecoder("utf8");
  let stderr = "";
  let resizeId = 0;
  let pendingResizeId: number | null = null;
  let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
  let pendingWrites = "";
  let settled = false;
  let workloadExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  let eventsEnded = false;
  let wrapperClosed = false;
  let resolveWrapperClosed!: () => void;
  const wrapperClosedPromise = new Promise<void>((resolve) => {
    resolveWrapperClosed = resolve;
  });
  let wrapperExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  let failureCleanup: Promise<void> | null = null;
  let resolveExit!: (exit: { code: number | null; signal: NodeJS.Signals | null }) => void;
  let rejectExit!: (error: Error) => void;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      resolveExit = resolve;
      rejectExit = reject;
    },
  );
  exited.catch(() => undefined);

  child.stdout.on("data", (chunk: Buffer) => emitData(decoder.write(chunk)));
  child.stdout.once("end", () => emitData(decoder.end()));
  child.stderr.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });
  void readProcessEvents(events, "pty", (event) => {
    if (event.type === "started") {
      return;
    }
    if (event.type === "eof") {
      return;
    }
    if (event.type === "resized") {
      if (event.id !== pendingResizeId) return;
      pendingResizeId = null;
      if (resizeTimeout) clearTimeout(resizeTimeout);
      resizeTimeout = null;
      if (pendingWrites) {
        child.stdin.write(pendingWrites);
        pendingWrites = "";
      }
      return;
    }
    if (event.type === "error") {
      failPty(new Error(`Workspace runtime ${runtimeId} PTY failed: ${event.message}`));
      return;
    }
    workloadExit = { code: event.code, signal: parseSignal(runtimeId, event.signal) };
    child.stdin.end();
    control.end();
  }).then(
    () => {
      eventsEnded = true;
      finishFromAuthoritativeExit();
      return undefined;
    },
    (error) => {
      failPty(error);
      return undefined;
    },
  );
  control.once("error", failPty);
  child.stdin.once("error", failPty);
  child.once("error", (error) => {
    failPty(new Error(`Workspace runtime ${runtimeId} PTY failed: ${error.message}`));
  });
  child.once("close", (code, signal) => {
    wrapperClosed = true;
    wrapperExit = { code, signal };
    resolveWrapperClosed();
    finishFromAuthoritativeExit();
  });
  writeControl(
    CommandRuntimeControlSchema.parse({
      type: "spawn",
      protocolVersion: COMMAND_RUNTIME_PROTOCOL_VERSION,
      argv: input.argv,
      cwd: input.cwd,
      env: input.env,
      purpose: commandPurpose(input.purpose),
      options,
      runtimeInstanceId,
      execId,
      stdio: input.stdio,
    }),
  );

  return {
    kind: "pty",
    onData(listener) {
      listeners.add(listener);
      if (pendingData) {
        const data = pendingData;
        pendingData = "";
        listener(data);
      }
      return () => listeners.delete(listener);
    },
    write(data) {
      if (pendingResizeId === null) child.stdin.write(data);
      else pendingWrites += data;
    },
    resize(cols, rows) {
      const controlValue = CommandRuntimeControlSchema.parse({
        type: "resize",
        protocolVersion: COMMAND_RUNTIME_PROTOCOL_VERSION,
        id: resizeId + 1,
        cols,
        rows,
      });
      resizeId += 1;
      pendingResizeId = resizeId;
      writeControl(controlValue);
      if (resizeTimeout) clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(
        () => failPty(new Error("PTY resize acknowledgement timed out")),
        1000,
      );
    },
    exited,
    kill(signal = "SIGTERM") {
      if (settled || failureCleanup) return;
      writeControl(
        CommandRuntimeControlSchema.parse({
          type: "signal",
          protocolVersion: COMMAND_RUNTIME_PROTOCOL_VERSION,
          signal,
        }),
      );
    },
  };

  function emitData(data: string): void {
    if (!data) return;
    if (listeners.size === 0) {
      pendingData += data;
      return;
    }
    for (const listener of listeners) listener(data);
  }

  function writeControl(value: unknown): void {
    try {
      control.write(encodeCommandRuntimeMessage(CommandRuntimeControlSchema, value));
    } catch (error) {
      failPty(error);
    }
  }

  function finishFromAuthoritativeExit(): void {
    if (settled || failureCleanup || !eventsEnded || !wrapperClosed) return;
    if (!workloadExit) {
      const detail = stderr.trim() || wrapperExit?.signal || wrapperExit?.code || "unknown";
      failPty(
        new Error(
          `Workspace runtime ${runtimeId} PTY wrapper ended without a valid fd4 exit event (${detail})`,
        ),
      );
      return;
    }
    settled = true;
    resolveExit(workloadExit);
  }

  function failPty(error: unknown): void {
    if (settled || failureCleanup) return;
    if (resizeTimeout) clearTimeout(resizeTimeout);
    resizeTimeout = null;
    control.destroy();
    events.destroy();
    child.stdin.destroy();
    const failure = error instanceof Error ? error : new Error(String(error));
    failureCleanup = (async () => {
      let cleanupError: unknown;
      try {
        await forceKillCommandRuntime(
          command,
          input.workspaceId,
          execId,
          options,
          runtimeInstanceId,
          child,
          wrapperClosedPromise,
        );
      } catch (cleanupFailure) {
        cleanupError = cleanupFailure;
      }
      settled = true;
      const cleanupDetail =
        cleanupError instanceof Error ? `; cleanup failed: ${cleanupError.message}` : "";
      const wrapperDetail = stderr.trim() ? `; wrapper: ${stderr.trim()}` : "";
      rejectExit(
        new Error(
          `Workspace runtime ${runtimeId} PTY failed: ${failure.message}${wrapperDetail}${cleanupDetail}`,
        ),
      );
    })();
  }
}

async function forceKillCommandRuntime(
  command: readonly [string, ...string[]],
  workspaceId: string,
  execId: string,
  options: Readonly<Record<string, unknown>>,
  runtimeInstanceId: string,
  wrapper: { pid?: number; kill(signal?: NodeJS.Signals): boolean },
  wrapperClosed: Promise<void>,
): Promise<void> {
  const signalCommand = spawn(
    command[0],
    [
      ...command.slice(1),
      "signal",
      "--workspace-id",
      workspaceId,
      "--exec-id",
      execId,
      "--signal",
      "SIGKILL",
    ],
    {
      env: commandEnvironment(),
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["pipe", "ignore", "pipe"],
    },
  );
  let signalStderr = "";
  signalCommand.stderr.on("data", (chunk: Buffer | string) => {
    signalStderr += chunk.toString();
  });
  const signalResult = new Promise<Error | null>((resolve) => {
    let finished = false;
    const finish = (error: Error | null) => {
      if (finished) return;
      finished = true;
      resolve(error);
    };
    signalCommand.once("error", (error) => finish(error));
    signalCommand.stdin.once("error", (error) => finish(error));
    signalCommand.once("close", (code, signal) =>
      finish(
        code === 0
          ? null
          : new Error(
              `signal helper failed (${code ?? signal ?? "unknown"})${signalStderr.trim() ? `: ${signalStderr.trim()}` : ""}`,
            ),
      ),
    );
  });
  signalCommand.stdin.end(
    encodeCommandRuntimeMessage(CommandRuntimeLifecycleRequestSchema, {
      protocolVersion: COMMAND_RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId,
      options,
    }),
  );
  const helper = await waitBounded(signalResult, COMMAND_RUNTIME_CLEANUP_TIMEOUT_MS);
  let cleanupError: Error | null = null;
  if (helper.timedOut) {
    cleanupError = new Error("signal helper timed out");
    killOwnedProcessGroup(signalCommand, "SIGKILL");
  } else {
    cleanupError = helper.value;
    if (cleanupError) killOwnedProcessGroup(signalCommand, "SIGKILL");
  }
  killOwnedProcessGroup(wrapper, "SIGKILL");
  const wrapperResult = await waitBounded(wrapperClosed, COMMAND_RUNTIME_CLEANUP_TIMEOUT_MS);
  if (wrapperResult.timedOut) {
    const wrapperError = new Error("wrapper remained alive after SIGKILL");
    throw cleanupError ? new AggregateError([cleanupError, wrapperError]) : wrapperError;
  }
  if (cleanupError) throw cleanupError;
}

async function waitBounded<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const result = await Promise.race([
    promise.then((value) => ({ timedOut: false as const, value })),
    new Promise<{ timedOut: true }>((resolve) => {
      timeout = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  return result;
}

function isNodeSignal(value: string): value is NodeJS.Signals {
  return value in constants.signals;
}

function parseSignal(runtimeId: string, signal: string | null): NodeJS.Signals | null {
  if (signal === null) return null;
  if (!isNodeSignal(signal)) {
    throw new Error(`Workspace runtime ${runtimeId} returned an invalid signal: ${signal}`);
  }
  return signal;
}

async function readProcessEvents(
  stream: Readable,
  mode: "pipes" | "pty",
  receive: (value: CommandRuntimeProcessEvent) => void,
): Promise<void> {
  const decoder = createCommandRuntimeProcessEventDecoder(mode);
  for await (const chunk of stream) {
    for (const value of decoder.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))) {
      receive(value);
    }
  }
  decoder.finish();
}

function spawnCommandProcess(
  runtimeId: string,
  command: readonly [string, ...string[]],
  input: WorkspaceDriverSpawnInput,
  options: Readonly<Record<string, unknown>>,
  runtimeInstanceId: string,
): WorkspacePipeProcess {
  const execId = randomBytes(16).toString("hex");
  const child = spawn(
    command[0],
    [...command.slice(1), "exec", "--workspace-id", input.workspaceId],
    {
      env: commandEnvironment(),
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
    },
  );
  const metadata = child.stdio[3] as Writable;
  const events = child.stdio[4] as Readable;
  let stderr = "";
  let signalable = false;
  let pendingSignal: NodeJS.Signals | null = null;
  let workloadExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  let eventsEnded = false;
  let wrapperClosed = false;
  let wrapperExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  let settled = false;
  let cleanup: Promise<void> | null = null;
  let resolveWrapperClosed!: () => void;
  const wrapperClosedPromise = new Promise<void>((resolve) => {
    resolveWrapperClosed = resolve;
  });
  let resolveExit!: (exit: { code: number | null; signal: NodeJS.Signals | null }) => void;
  let rejectExit!: (error: Error) => void;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      resolveExit = resolve;
      rejectExit = reject;
    },
  );
  exited.catch(() => undefined);
  child.stderr.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });
  void readProcessEvents(events, "pipes", (event) => {
    if (event.type === "started") {
      signalable = true;
      if (pendingSignal) deliverSignal(pendingSignal);
      return;
    }
    if (event.type === "eof") {
      return;
    }
    if (event.type === "error") {
      fail(new Error(event.message));
      return;
    }
    if (event.type === "resized") return;
    workloadExit = { code: event.code, signal: parseSignal(runtimeId, event.signal) };
  }).then(
    () => {
      eventsEnded = true;
      finish();
      return undefined;
    },
    (error) => {
      fail(error);
      return undefined;
    },
  );
  metadata.once("error", fail);
  child.once("error", (error) => fail(new Error(`exec failed: ${error.message}`)));
  child.once("exit", (code, signal) => {
    wrapperClosed = true;
    wrapperExit = { code, signal };
    resolveWrapperClosed();
    finish();
  });
  metadata.end(
    encodeCommandRuntimeMessage(CommandRuntimeControlSchema, {
      type: "spawn",
      protocolVersion: COMMAND_RUNTIME_PROTOCOL_VERSION,
      argv: input.argv,
      cwd: input.cwd,
      env: input.env,
      purpose: commandPurpose(input.purpose),
      options,
      runtimeInstanceId,
      execId,
      stdio: input.stdio,
    }),
  );

  return {
    kind: "pipes",
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    exited,
    kill(signal = "SIGTERM") {
      if (settled || cleanup) return;
      pendingSignal = signal;
      if (signalable) deliverSignal(signal);
    },
  };

  function deliverSignal(signal: NodeJS.Signals): void {
    pendingSignal = null;
    if (signal === "SIGKILL") {
      cleanup = (async () => {
        try {
          await forceKillCommandRuntime(
            command,
            input.workspaceId,
            execId,
            options,
            runtimeInstanceId,
            child,
            wrapperClosedPromise,
          );
          settled = true;
          resolveExit({ code: null, signal });
        } catch (error) {
          settled = true;
          const reason = error instanceof Error ? error.message : String(error);
          rejectExit(
            new Error(`Workspace runtime ${runtimeId} forced process cleanup failed: ${reason}`),
          );
        }
      })();
      return;
    }
    child.kill(signal);
  }

  function finish(): void {
    if (settled || cleanup || !eventsEnded || !wrapperClosed) return;
    if (!workloadExit) {
      const detail = stderr.trim() || wrapperExit?.signal || wrapperExit?.code || "unknown";
      fail(new Error(`pipes wrapper ended without a valid fd4 exit event (${String(detail)})`));
      return;
    }
    settled = true;
    resolveExit(workloadExit);
  }

  function fail(error: unknown): void {
    if (settled || cleanup) return;
    metadata.destroy();
    events.destroy();
    child.stdin.destroy();
    const failure = error instanceof Error ? error : new Error(String(error));
    cleanup = (async () => {
      let cleanupError: unknown;
      try {
        await forceKillCommandRuntime(
          command,
          input.workspaceId,
          execId,
          options,
          runtimeInstanceId,
          child,
          wrapperClosedPromise,
        );
      } catch (caught) {
        cleanupError = caught;
      }
      settled = true;
      const detail =
        cleanupError instanceof Error ? `; cleanup failed: ${cleanupError.message}` : "";
      const wrapperDetail = stderr.trim() ? `; wrapper: ${stderr.trim()}` : "";
      rejectExit(
        new Error(
          `Workspace runtime ${runtimeId} pipes failed: ${failure.message}${wrapperDetail}${detail}`,
        ),
      );
    })();
  }
}

function killOwnedProcessGroup(
  child: { pid?: number; kill(signal?: NodeJS.Signals): boolean },
  signal: NodeJS.Signals,
): void {
  try {
    if (process.platform === "win32" || !child.pid) child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function collect(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function commandEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (env.FORCE_COLOR !== undefined) delete env.NO_COLOR;
  return env;
}

function resolveRuntimeCommand(
  command: readonly [string, ...string[]],
  packageResolutionBase: string,
  pathResolutionBase: string,
): readonly [string, ...string[]] {
  const executable = command[0];
  const moduleRequire = createRequire(path.join(packageResolutionBase, "package.json"));
  let resolved = executable;
  if (executable.startsWith("@")) {
    const packageJsonPath = moduleRequire.resolve(`${executable}/package.json`);
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      bin?: string | Record<string, string>;
    };
    const bin =
      typeof packageJson.bin === "string"
        ? packageJson.bin
        : packageJson.bin && Object.values(packageJson.bin)[0];
    if (!bin) throw new Error(`Workspace runtime package has no executable: ${executable}`);
    resolved = path.resolve(path.dirname(packageJsonPath), bin);
    if ([".js", ".cjs", ".mjs"].includes(path.extname(resolved))) {
      return [process.execPath, resolved, ...command.slice(1)];
    }
  } else if (path.isAbsolute(executable)) {
    resolved = path.normalize(executable);
  } else if (executable.startsWith(".")) {
    resolved = path.resolve(pathResolutionBase, executable);
  }
  return [resolved, ...command.slice(1)];
}
