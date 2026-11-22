import { type ChildProcess, fork } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import pLimit from "p-limit";
import { ZodError } from "zod";
import type * as build from "./compiler-build.js";
import type { PluginManifest } from "./manifest.js";
import type { CompilerReply } from "./compiler-worker.js";

export {
  SERVER_HOST_MODULES,
  resolveExistingAsarUnpackedEsbuildBinary,
  unpackedEsbuildBinaryFromPackageDir,
} from "./compiler-esbuild.js";

export type CompilerTask =
  | { kind: "entries"; entries: Parameters<typeof build.compilePlugin>[0] }
  | { kind: "directory"; directory: string; version: string; builtinId?: string }
  | {
      kind: "prepare";
      directory: string;
      commands: PluginManifest["build"];
      environment: NodeJS.ProcessEnv;
    };

interface TaskResult {
  entries: Awaited<ReturnType<typeof build.compilePlugin>>;
  directory: Awaited<ReturnType<typeof build.compileDirectoryPlugin>>;
  prepare: void;
}

const IDLE_TIMEOUT_MS = 1_000;
const source = import.meta.url.endsWith(".ts");
const workerUrl = new URL(
  source ? "./compiler-worker.ts" : "./compiler-worker.js",
  import.meta.url,
);
const workerExecArgv = source
  ? ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href]
  : [];

interface CompilerProcess {
  child: ChildProcess;
  exited: Promise<void>;
}

// Reuse the process during a build batch, then release TypeScript's heap.
// esbuild starts a native child. Terminating a worker thread closes its libuv
// loop before it can reap that child, leaving a zombie under the daemon PID.
class PluginCompiler {
  private readonly queue = pLimit(1);
  private worker: CompilerProcess | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping: Promise<unknown> = Promise.resolve();

  run<T extends CompilerTask>(
    task: T,
    onLog?: (data: Record<string, unknown>, message: string) => void,
  ): Promise<TaskResult[T["kind"]]> {
    return this.queue(async () => {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = null;
      await this.stopping;
      const worker = this.worker ?? this.startWorker();
      worker.child.ref();
      worker.child.channel?.ref();
      try {
        return await this.request<T>(worker, task, onLog);
      } finally {
        if (this.worker === worker) {
          worker.child.unref();
          worker.child.channel?.unref();
          this.idleTimer = setTimeout(() => this.stopWorker(worker), IDLE_TIMEOUT_MS);
          this.idleTimer.unref();
        } else {
          await this.stopping;
        }
      }
    });
  }

  private startWorker(): CompilerProcess {
    const child = fork(workerUrl, [], {
      execArgv: workerExecArgv,
      serialization: "advanced",
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.on("error", () => {
        if (child.pid === undefined) resolve();
      });
    });
    const worker = { child, exited };
    this.worker = worker;
    child.once("disconnect", () => this.stopWorker(worker));
    void exited.then(() => this.stopWorker(worker));
    return worker;
  }

  private stopWorker(worker: CompilerProcess): void {
    if (this.worker !== worker) return;
    this.worker = null;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.stopping = worker.exited;
    // Close IPC so the compiler can finish any in-flight work and exit. Its
    // pipes close with it, ending esbuild's service.
    if (worker.child.connected) worker.child.disconnect();
  }

  private async request<T extends CompilerTask>(
    worker: CompilerProcess,
    task: T,
    onLog?: (data: Record<string, unknown>, message: string) => void,
  ): Promise<TaskResult[T["kind"]]> {
    let onMessage: (reply: CompilerReply) => void;
    let onError: (error: Error) => void;
    let onExit: (code: number) => void;
    let onDisconnect: () => void;
    const { child } = worker;
    try {
      return await new Promise<TaskResult[T["kind"]]>((resolve, reject) => {
        onError = reject;
        onExit = (code) => reject(new Error(`Plugin compiler worker exited (code ${code})`));
        onDisconnect = () => reject(new Error("Plugin compiler worker disconnected"));
        onMessage = (reply) => {
          if (reply.kind === "log") {
            onLog?.(reply.data, reply.message);
          } else if (reply.kind === "result") {
            resolve(reply.value as TaskResult[T["kind"]]);
          } else {
            const error = reply.issues ? new ZodError(reply.issues) : reply.error;
            Object.assign(error, reply.properties);
            if (reply.errors) Object.assign(error, { errors: reply.errors });
            if (reply.warnings) Object.assign(error, { warnings: reply.warnings });
            // Promise.all can reject while the other target is still compiling.
            // Retire the compiler before another request can enter it.
            this.stopWorker(worker);
            reject(error);
          }
        };
        child.on("error", onError);
        child.on("exit", onExit);
        child.on("disconnect", onDisconnect);
        child.on("message", onMessage);
        child.send(task, (error) => {
          if (!error) return;
          this.stopWorker(worker);
          reject(error);
        });
      });
    } finally {
      child.off("message", onMessage!);
      child.off("error", onError!);
      child.off("exit", onExit!);
      child.off("disconnect", onDisconnect!);
    }
  }
}

const compiler = new PluginCompiler();

export function runCompilerTask<T extends CompilerTask>(
  task: T,
  onLog?: (data: Record<string, unknown>, message: string) => void,
): Promise<TaskResult[T["kind"]]> {
  return compiler.run(task, onLog);
}

export function compilePlugin(entries: Parameters<typeof build.compilePlugin>[0]) {
  return runCompilerTask({ kind: "entries", entries });
}

export function compileDirectoryPlugin(directory: string, version: string, builtinId?: string) {
  return runCompilerTask({ kind: "directory", directory, version, builtinId });
}
