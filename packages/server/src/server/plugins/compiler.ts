import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
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
// Resolve the development loader once at module initialization, never during a
// compile request. Packaged workers execute ordinary JavaScript without tsx.
const workerEntrypoint = source
  ? `import(${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm/api")).href)}).then(({ register }) => { register(); return import(${JSON.stringify(workerUrl.href)}); });`
  : workerUrl;

// Reuse the isolate during a build batch (notably daemon bootstrap), then release
// TypeScript's heap when idle. Only this owner admits work or stops the worker.
class PluginCompiler {
  private readonly queue = pLimit(1);
  private worker: Worker | null = null;
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
      worker.ref();
      try {
        return await this.request<T>(worker, task, onLog);
      } finally {
        if (this.worker === worker) {
          worker.unref();
          this.idleTimer = setTimeout(() => this.stopWorker(worker), IDLE_TIMEOUT_MS);
          this.idleTimer.unref();
        } else {
          await this.stopping;
        }
      }
    });
  }

  private startWorker(): Worker {
    const worker = new Worker(workerEntrypoint, { eval: source, execArgv: [] });
    this.worker = worker;
    // Keep error/exit ownership while idle too. The next caller gets a fresh
    // isolate after a crash; author build commands are never retried.
    worker.on("error", () => this.stopWorker(worker));
    worker.on("exit", () => {
      if (this.worker === worker) this.stopWorker(worker);
    });
    return worker;
  }

  private stopWorker(worker: Worker): void {
    if (this.worker !== worker) return;
    this.worker = null;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.stopping = worker.terminate();
  }

  private async request<T extends CompilerTask>(
    worker: Worker,
    task: T,
    onLog?: (data: Record<string, unknown>, message: string) => void,
  ): Promise<TaskResult[T["kind"]]> {
    let onMessage: (reply: CompilerReply) => void;
    let onError: (error: Error) => void;
    let onExit: (code: number) => void;
    try {
      return await new Promise<TaskResult[T["kind"]]>((resolve, reject) => {
        onError = reject;
        onExit = (code) => reject(new Error(`Plugin compiler worker exited (code ${code})`));
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
            // Retire the isolate before another request can enter it.
            this.stopWorker(worker);
            reject(error);
          }
        };
        worker.on("error", onError);
        worker.on("exit", onExit);
        worker.on("message", onMessage);
        worker.postMessage(task, []);
      });
    } finally {
      worker.off("message", onMessage!);
      worker.off("error", onError!);
      worker.off("exit", onExit!);
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
