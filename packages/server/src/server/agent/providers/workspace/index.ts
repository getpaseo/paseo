import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import nodePath from "node:path";
import { PassThrough } from "node:stream";

import type { ProcessEnvRecord } from "../../../paseo-env.js";
import { createProviderEnv } from "../../provider-launch-config.js";
import type {
  BoundWorkspaceRuntime,
  WorkspaceProcess,
  WorkspaceProcessPurpose,
  WorkspaceRuntimeProviderCapability,
} from "../../../workspace-runtime/index.js";
import type { WorkspaceDirectory } from "@getpaseo/workspace-helper";

export interface ProviderPlacementPolicy {
  environment:
    | { type: "inherit-sanitized-host"; hostEnvironment: ProcessEnvRecord }
    | { type: "isolated" };
  sharedHostProviders: ReadonlySet<string>;
}

export function resolveProviderPlacementPolicy(input: {
  capability: WorkspaceRuntimeProviderCapability;
  hostEnvironment: ProcessEnvRecord;
}): ProviderPlacementPolicy {
  return {
    environment:
      input.capability.environment === "inherit-sanitized-host"
        ? { type: "inherit-sanitized-host", hostEnvironment: input.hostEnvironment }
        : { type: "isolated" },
    sharedHostProviders: input.capability.sharedHostProviders,
  };
}

export interface ProviderWorkspaceLaunchInput {
  argv: readonly [string, ...string[]];
  cwd?: string;
  environment?: readonly (ProcessEnvRecord | undefined)[];
  purpose: WorkspaceProcessPurpose;
  signal?: AbortSignal;
}

export class ProviderStateNotFoundError extends Error {
  constructor(readonly statePath: string) {
    super(`Provider state was not found: ${statePath}`);
    this.name = "ProviderStateNotFoundError";
  }
}

export function isProviderStateNotFoundError(error: unknown): error is ProviderStateNotFoundError {
  return error instanceof ProviderStateNotFoundError;
}

/** Preserve legacy fallbacks while preventing selected workspace capability failures from hiding. */
export function rejectSelectedProviderWorkspaceFailure(
  workspace: ProviderWorkspace | undefined,
  error: unknown,
  options: { allowMissingState?: boolean } = {},
): void {
  if (!workspace) return;
  if (options.allowMissingState && isProviderStateNotFoundError(error)) return;
  throw error;
}

export interface MaterializedProviderStateFile {
  /** Workspace-relative path passed only to the provider process. */
  readonly path: string;
  /** Root-relative state path retained by the provider workspace authority. */
  readonly statePath: string;
  remove(): Promise<void>;
}

/** Provider-owned placement capability. Adapters never receive a workspace runtime or its root. */
export interface ProviderWorkspace {
  readonly cwd: string;
  resolveExecutable(command: string): Promise<string>;
  launch(input: ProviderWorkspaceLaunchInput): Promise<ChildProcessWithoutNullStreams>;
  launchDeferred(
    input: ProviderWorkspaceLaunchInput | Promise<ProviderWorkspaceLaunchInput>,
  ): ChildProcessWithoutNullStreams;
  runProbe(input: {
    argv: readonly [string, ...string[]];
    environment?: readonly (ProcessEnvRecord | undefined)[];
    provider: string;
  }): Promise<{ stdout: string; stderr: string }>;
  readWorkspaceText(path: string): Promise<string>;
  writeWorkspaceText(path: string, content: string): Promise<void>;
  listState(path: string): Promise<WorkspaceDirectory>;
  readStateText(path: string): Promise<string>;
  findStateFile(root: string, fileName: string): Promise<string | null>;
  materializeStateFile(input: {
    name: string;
    content: string | Uint8Array | AsyncIterable<Uint8Array>;
    encoding?: "utf8" | "base64";
  }): Promise<MaterializedProviderStateFile>;
  removeStateFile(path: string): Promise<void>;
  allowsHostService(provider: string): boolean;
}

export function bindProviderWorkspace(input: {
  runtime: BoundWorkspaceRuntime;
  cwd: string;
  policy: ProviderPlacementPolicy;
}): ProviderWorkspace {
  const environment = (
    overlays: readonly (ProcessEnvRecord | undefined)[] = [],
  ): Record<string, string> => {
    const baseEnv =
      input.policy.environment.type === "inherit-sanitized-host"
        ? input.policy.environment.hostEnvironment
        : {};
    return createProviderEnv({ baseEnv, overlays: [...overlays] }) as Record<string, string>;
  };
  const run = (launch: ProviderWorkspaceLaunchInput): Promise<WorkspaceProcess> =>
    input.runtime.run({
      cwd: launch.cwd ?? (input.cwd === "." ? undefined : input.cwd),
      argv: launch.argv,
      env: environment(launch.environment),
      purpose: launch.purpose,
    });

  return {
    cwd: input.cwd,
    async resolveExecutable(command) {
      const resolved = await input.runtime.resolveCommand(command);
      if (!resolved)
        throw new Error(`Provider command '${command}' was not found in the workspace`);
      return resolved;
    },
    async launch(launch) {
      return wrapWorkspaceProcess(await run(launch), launch.signal);
    },
    launchDeferred(launch) {
      return wrapDeferredWorkspaceProcess(
        Promise.resolve(launch).then(async (resolved) => ({
          process: await run(resolved),
          signal: resolved.signal,
        })),
      );
    },
    async runProbe(probe) {
      const process = await run({
        argv: probe.argv,
        environment: probe.environment,
        purpose: { kind: "provider-probe", provider: probe.provider },
      });
      process.stdin.end();
      const [stdout, stderr, exit] = await Promise.all([
        collect(process.stdout),
        collect(process.stderr),
        process.exited,
      ]);
      if (exit.code !== 0 || exit.signal !== null) {
        throw new Error(`${probe.provider} probe failed: ${stderr || exit.code || exit.signal}`);
      }
      return { stdout, stderr };
    },
    async readWorkspaceText(path) {
      return collect((await input.runtime.files.read(path)).chunks);
    },
    async writeWorkspaceText(path, content) {
      const result = await input.runtime.files.write({ path, contents: Buffer.from(content) });
      if (result.status !== "written") {
        throw new Error(
          result.status === "error" ? result.error : `Workspace file write conflicted: ${path}`,
        );
      }
    },
    async listState(statePath) {
      const relativePath = requireRelativeStatePath(statePath);
      const node = await this.resolveExecutable("node");
      const script = [
        'const f=require("fs/promises"),o=require("os"),p=require("path");',
        "(async()=>{const root=await f.realpath(o.homedir()),relative=process.argv[1],target=p.resolve(root,relative),lexical=p.relative(root,target);",
        'if(lexical.startsWith("..")||p.isAbsolute(lexical))throw new Error("Provider state path escapes its root");',
        'let canonical;try{canonical=await f.realpath(target);}catch(error){if(error?.code==="ENOENT"){process.exitCode=44;return;}throw error;}const confined=p.relative(root,canonical);if(confined.startsWith("..")||p.isAbsolute(confined))throw new Error("Provider state symlink escapes its root");',
        'const entries=[];for(const name of await f.readdir(canonical)){const absolute=p.join(canonical,name),info=await f.stat(absolute);if(!info.isFile()&&!info.isDirectory())continue;entries.push({name,path:p.posix.join(relative.split(p.sep).join("/"),name),kind:info.isDirectory()?"directory":"file",size:info.size,modifiedAt:info.mtime.toISOString()});}process.stdout.write(JSON.stringify({path:relative,entries}));})().catch(error=>{process.stderr.write(String(error));process.exitCode=1});',
      ].join("");
      const result = await runProviderStateCommand(run, node, script, relativePath);
      if (result.exit.code === 44) throw new ProviderStateNotFoundError(relativePath);
      if (result.exit.code !== 0 || result.exit.signal !== null) {
        throw new Error(`Provider state listing failed: ${result.stderr || result.exit.signal}`);
      }
      return JSON.parse(result.stdout) as WorkspaceDirectory;
    },
    async readStateText(path) {
      const statePath = requireRelativeStatePath(path);
      const node = await this.resolveExecutable("node");
      const script = [
        'const f=require("fs/promises"),o=require("os"),p=require("path");',
        "(async()=>{const root=await f.realpath(o.homedir()),relative=process.argv[1],target=p.resolve(root,relative),lexical=p.relative(root,target);",
        'if(lexical.startsWith("..")||p.isAbsolute(lexical))throw new Error("Provider state path escapes its root");',
        'let canonical;try{canonical=await f.realpath(target);}catch(error){if(error?.code==="ENOENT"){process.exitCode=44;return;}throw error;}const confined=p.relative(root,canonical);if(confined.startsWith("..")||p.isAbsolute(confined))throw new Error("Provider state symlink escapes its root");process.stdout.write(await f.readFile(canonical));})().catch(error=>{process.stderr.write(String(error));process.exitCode=1});',
      ].join("");
      const result = await runProviderStateCommand(run, node, script, statePath);
      if (result.exit.code === 44) throw new ProviderStateNotFoundError(statePath);
      if (result.exit.code !== 0 || result.exit.signal !== null) {
        throw new Error(`Provider state read failed: ${result.stderr || result.exit.signal}`);
      }
      return result.stdout;
    },
    async findStateFile(root, fileName) {
      const stateRoot = requireRelativeStatePath(root);
      const pending = [stateRoot];
      while (pending.length > 0) {
        const directory = pending.shift()!;
        let listing;
        try {
          listing = await this.listState(directory);
        } catch (error) {
          if (!isProviderStateNotFoundError(error)) throw error;
          continue;
        }
        for (const entry of listing.entries) {
          if (entry.kind === "file" && entry.name === fileName) return entry.path;
          if (entry.kind === "directory") pending.push(entry.path);
        }
      }
      return null;
    },
    async materializeStateFile(stateFile) {
      const node = await this.resolveExecutable("node");
      const safeName = stateFile.name.replace(/[^A-Za-z0-9._-]/g, "-");
      const relativePath = `.paseo/provider-state/${randomUUID()}-${safeName}`;
      const script = [
        'const fs=require("fs"),fsp=require("fs/promises"),path=require("path"),stream=require("stream/promises");',
        "(async()=>{const root=await fsp.realpath('.'),relative=process.argv[1],target=path.resolve(root,relative),parent=path.dirname(target);",
        'if(path.isAbsolute(relative)||relative.split(/[\\\\/]+/u).includes(".."))throw new Error("Provider state path must be root-relative");',
        'await fsp.mkdir(parent,{recursive:true});const canonicalParent=await fsp.realpath(parent),rel=path.relative(root,canonicalParent);if(rel.startsWith("..")||path.isAbsolute(rel))throw new Error("Provider state path escapes its root");',
        'const handle=await fsp.open(target,"wx",0o600);try{await stream.pipeline(process.stdin,fs.createWriteStream(target,{fd:handle.fd,autoClose:false}));await handle.sync();}catch(error){await fsp.unlink(target).catch(()=>{});throw error;}finally{await handle.close();}})().catch(error=>{process.stderr.write(String(error));process.exitCode=1});',
      ].join("");
      const process = await run({
        argv: [node, "-e", script, relativePath],
        purpose: { kind: "provider-probe", provider: "provider-state" },
      });
      const stdout = collect(process.stdout);
      const stderr = collect(process.stderr);
      try {
        await writeProcessInput(process, toStateContent(stateFile));
        const [, diagnostics, exit] = await Promise.all([stdout, stderr, process.exited]);
        if (exit.code !== 0 || exit.signal !== null) {
          throw new Error(
            `Provider state materialization failed: ${diagnostics || exit.code || exit.signal}`,
          );
        }
        return {
          path: relativePath,
          statePath: relativePath,
          remove: () => this.removeStateFile(relativePath),
        };
      } catch (error) {
        await terminateWorkspaceProcess(process, "SIGKILL").catch(() => undefined);
        throw error;
      }
    },
    async removeStateFile(path) {
      const statePath = requireRelativeStatePath(path);
      const node = await this.resolveExecutable("node");
      const script = [
        'const f=require("fs/promises"),p=require("path");',
        "(async()=>{const root=await f.realpath('.'),relative=process.argv[1],target=p.resolve(root,relative),lexical=p.relative(root,target);",
        'if(lexical.startsWith("..")||p.isAbsolute(lexical))throw new Error("Provider state path escapes its root");',
        'let canonical;try{canonical=await f.realpath(target);}catch(error){if(error?.code==="ENOENT")return;throw error;}const resolved=p.relative(root,canonical);if(resolved.startsWith("..")||p.isAbsolute(resolved))throw new Error("Provider state symlink escapes its root");const info=await f.lstat(target);if(!info.isFile()&&!info.isSymbolicLink())throw new Error("Provider state removal requires a file");await f.unlink(target);})().catch(error=>{process.stderr.write(String(error));process.exitCode=1});',
      ].join("");
      const child = await run({
        argv: [node, "-e", script, statePath],
        purpose: { kind: "provider-probe", provider: "provider-state" },
      });
      child.stdin.end();
      const [, stderr, exit] = await Promise.all([
        collect(child.stdout),
        collect(child.stderr),
        child.exited,
      ]);
      if (exit.code !== 0 || exit.signal !== null) {
        throw new Error(`Provider state removal failed: ${stderr || exit.code || exit.signal}`);
      }
    },
    allowsHostService(provider) {
      return input.policy.sharedHostProviders.has(provider);
    },
  };
}

export function providerWorkspaceFromCatalogOptions(options: {
  scope: "global" | "workspace";
  workspaceId?: string;
  workspace?: ProviderWorkspace;
}): ProviderWorkspace | undefined {
  if (options.scope !== "workspace") return undefined;
  if (options.workspaceId && !options.workspace) {
    throw new Error(`workspace runtime capability is unavailable: ${options.workspaceId}`);
  }
  return options.workspace;
}

/** Merge explicit provider overlays. Runtime-specific inheritance is applied by the bound capability. */
export function providerWorkspaceEnvironment(
  overlays: readonly (ProcessEnvRecord | undefined)[],
): ProcessEnvRecord {
  return Object.assign({}, ...overlays.filter((value): value is ProcessEnvRecord => !!value));
}

export function resolveWorkspaceCommand(
  workspace: ProviderWorkspace,
  command: string,
): Promise<string> {
  return workspace.resolveExecutable(command);
}

export function spawnWorkspaceProviderProcess(input: {
  workspace: ProviderWorkspace;
  argv: readonly [string, ...string[]];
  env?: ProcessEnvRecord;
  purpose: WorkspaceProcessPurpose;
}): Promise<ChildProcessWithoutNullStreams> {
  return input.workspace.launch({
    argv: input.argv,
    environment: [input.env],
    purpose: input.purpose,
  });
}

export function runWorkspaceProviderCommand(input: {
  workspace: ProviderWorkspace;
  argv: readonly [string, ...string[]];
  env?: ProcessEnvRecord;
  provider: string;
}): Promise<{ stdout: string; stderr: string }> {
  return input.workspace.runProbe({
    argv: input.argv,
    environment: [input.env],
    provider: input.provider,
  });
}

function wrapWorkspaceProcess(
  process: WorkspaceProcess,
  signal?: AbortSignal,
): ChildProcessWithoutNullStreams {
  const child = createChildShell(process.stdin, process.stdout, process.stderr, (killSignal) =>
    process.kill(killSignal),
  );
  const unbindAbort = bindAbortSignal(process, child, signal);
  forwardExit(process, child, undefined, unbindAbort);
  return child;
}

function wrapDeferredWorkspaceProcess(
  processPromise: Promise<{ process: WorkspaceProcess; signal?: AbortSignal }>,
): ChildProcessWithoutNullStreams {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let process: WorkspaceProcess | null = null;
  let pendingSignal: NodeJS.Signals | undefined;
  const child = createChildShell(stdin, stdout, stderr, (signal) => {
    pendingSignal = signal;
    process?.kill(signal);
  });
  void processPromise.then(
    ({ process: launched, signal }) => {
      process = launched;
      stdin.pipe(launched.stdin);
      launched.stdout.pipe(stdout);
      launched.stderr.pipe(stderr);
      if (pendingSignal) launched.kill(pendingSignal);
      const unbindAbort = bindAbortSignal(launched, child, signal);
      child.emit("spawn");
      forwardExit(
        launched,
        child,
        () => {
          stdout.end();
          stderr.end();
        },
        unbindAbort,
      );
      return undefined;
    },
    (error) => {
      stdin.destroy(error instanceof Error ? error : new Error(String(error)));
      stdout.end();
      stderr.end();
      child.emit("error", error);
      return undefined;
    },
  );
  return child;
}

function createChildShell(
  stdin: NodeJS.WritableStream,
  stdout: NodeJS.ReadableStream,
  stderr: NodeJS.ReadableStream,
  kill: (signal?: NodeJS.Signals) => void,
): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  Object.assign(child, {
    stdin,
    stdout,
    stderr,
    pid: undefined,
    exitCode: null,
    signalCode: null,
    killed: false,
    kill(signal?: NodeJS.Signals) {
      (child as unknown as { killed: boolean }).killed = true;
      kill(signal);
      return true;
    },
  });
  return child;
}

function forwardExit(
  process: WorkspaceProcess,
  child: ChildProcessWithoutNullStreams,
  beforeEmit?: () => void,
  beforeExit?: () => void,
): void {
  void process.exited.then(
    ({ code, signal }) => {
      const mutableChild = child as unknown as {
        exitCode: number | null;
        signalCode: NodeJS.Signals | null;
      };
      mutableChild.exitCode = code;
      mutableChild.signalCode = signal;
      beforeEmit?.();
      beforeExit?.();
      child.emit("exit", code, signal);
      child.emit("close", code, signal);
      return undefined;
    },
    (error) => child.emit("error", error),
  );
}

function bindAbortSignal(
  process: WorkspaceProcess,
  child: ChildProcessWithoutNullStreams,
  signal: AbortSignal | undefined,
): () => void {
  if (!signal) return () => undefined;
  let handled = false;
  const onAbort = () => {
    if (handled) return;
    handled = true;
    (child as unknown as { killed: boolean }).killed = true;
    void terminateWorkspaceProcess(process, "SIGTERM").catch(() => undefined);
    const error = new Error("The operation was aborted") as Error & { code: string };
    error.name = "AbortError";
    error.code = "ABORT_ERR";
    child.emit("error", error);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) queueMicrotask(onAbort);
  return () => signal.removeEventListener("abort", onAbort);
}

async function terminateWorkspaceProcess(
  process: WorkspaceProcess,
  initialSignal: NodeJS.Signals,
): Promise<void> {
  process.kill(initialSignal);
  if (await exitsWithin(process, 1_000)) return;
  if (initialSignal !== "SIGKILL") process.kill("SIGKILL");
  if (!(await exitsWithin(process, 1_000))) {
    throw new Error("Workspace provider process did not terminate after SIGKILL");
  }
}

async function exitsWithin(process: WorkspaceProcess, timeoutMs: number): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      process.exited.then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function runProviderStateCommand(
  launch: (input: ProviderWorkspaceLaunchInput) => Promise<WorkspaceProcess>,
  node: string,
  script: string,
  relativePath: string,
): Promise<{
  stdout: string;
  stderr: string;
  exit: { code: number | null; signal: NodeJS.Signals | null };
}> {
  const process = await launch({
    argv: [node, "-e", script, relativePath],
    purpose: { kind: "provider-probe", provider: "provider-state" },
  });
  process.stdin.end();
  const [stdout, stderr, exit] = await Promise.all([
    collect(process.stdout),
    collect(process.stderr),
    process.exited,
  ]);
  return { stdout, stderr, exit };
}

function requireRelativeStatePath(statePath: string): string {
  if (
    !statePath ||
    nodePath.posix.isAbsolute(statePath) ||
    nodePath.win32.isAbsolute(statePath) ||
    statePath.includes("\\") ||
    statePath.split("/").includes("..")
  ) {
    throw new Error(`Provider state path must be root-relative: ${statePath}`);
  }
  return nodePath.posix.normalize(statePath);
}

function toStateContent(input: {
  content: string | Uint8Array | AsyncIterable<Uint8Array>;
  encoding?: "utf8" | "base64";
}): Uint8Array | AsyncIterable<Uint8Array> {
  if (typeof input.content !== "string") return input.content;
  return Buffer.from(input.content, input.encoding ?? "utf8");
}

async function writeProcessInput(
  process: WorkspaceProcess,
  contents: Uint8Array | AsyncIterable<Uint8Array>,
): Promise<void> {
  if (contents instanceof Uint8Array) {
    process.stdin.end(contents);
    return;
  }
  for await (const chunk of contents) {
    if (!process.stdin.write(chunk)) await onceDrain(process.stdin);
  }
  process.stdin.end();
}

function onceDrain(stream: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once("drain", resolve);
    stream.once("error", reject);
  });
}

async function collect(stream: NodeJS.ReadableStream | AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
