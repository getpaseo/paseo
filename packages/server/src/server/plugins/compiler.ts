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
  | { kind: "prepare"; directory: string; commands: PluginManifest["build"] };

interface TaskResult {
  entries: Awaited<ReturnType<typeof build.compilePlugin>>;
  directory: Awaited<ReturnType<typeof build.compileDirectoryPlugin>>;
  prepare: void;
}

// One active build per daemon, including preparation. A fresh isolate per task
// releases TypeScript's ASTs and caches and inherits current command environment.
const compileQueue = pLimit(1);

export function runCompilerTask<T extends CompilerTask>(
  task: T,
  onLog?: (data: Record<string, unknown>, message: string) => void,
): Promise<TaskResult[T["kind"]]> {
  return compileQueue(async () => {
    const source = import.meta.url.endsWith(".ts");
    const url = new URL(source ? "./compiler-worker.ts" : "./compiler-worker.js", import.meta.url);
    // Node workers do not inherit tsx's in-process loader registration. Register
    // it inside development/test isolates; dist workers execute ordinary JS.
    const worker = source
      ? new Worker(
          `import(${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm/api")).href)}).then(({ register }) => { register(); return import(${JSON.stringify(url.href)}); });`,
          { eval: true, execArgv: [], workerData: task },
        )
      : new Worker(url, { execArgv: [], workerData: task });
    try {
      return await new Promise<TaskResult[T["kind"]]>((resolve, reject) => {
        worker.on("error", reject);
        worker.on("exit", (code) =>
          reject(new Error(`Plugin compiler worker exited (code ${code})`)),
        );
        worker.on("message", (reply: CompilerReply) => {
          if (reply.kind === "log") {
            onLog?.(reply.data, reply.message);
          } else if (reply.kind === "result") {
            resolve(reply.value as TaskResult[T["kind"]]);
          } else {
            const error = reply.issues ? new ZodError(reply.issues) : reply.error;
            if (reply.errors) Object.assign(error, { errors: reply.errors });
            if (reply.warnings) Object.assign(error, { warnings: reply.warnings });
            reject(error);
          }
        });
      });
    } finally {
      // A crash rejects only its task. The queue always advances and the next
      // caller gets a new worker; no retries of author build commands.
      await worker.terminate();
    }
  });
}

export function compilePlugin(entries: Parameters<typeof build.compilePlugin>[0]) {
  return runCompilerTask({ kind: "entries", entries });
}

export function compileDirectoryPlugin(directory: string, version: string, builtinId?: string) {
  return runCompilerTask({ kind: "directory", directory, version, builtinId });
}
