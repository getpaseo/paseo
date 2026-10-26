import { parentPort, workerData } from "node:worker_threads";
import type { ZodIssue } from "zod";
import { compilePlugin, compileDirectoryPlugin } from "./compiler-build.js";
import { runPluginBuild } from "./preparation-build.js";
import type { CompilerTask } from "./compiler.js";

export type CompilerReply =
  | { kind: "log"; data: Record<string, unknown>; message: string }
  | { kind: "result"; value: unknown }
  | {
      kind: "error";
      error: Error;
      issues?: ZodIssue[];
      errors?: unknown[];
      warnings?: unknown[];
    };

const port = parentPort!;
const task = workerData as CompilerTask;

try {
  let value: unknown;
  switch (task.kind) {
    case "entries":
      value = await compilePlugin(task.entries);
      break;
    case "directory":
      value = await compileDirectoryPlugin(task.directory, task.version, task.builtinId);
      break;
    case "prepare":
      await runPluginBuild(task.directory, task.commands, {
        info: (data, message) =>
          port.postMessage({ kind: "log", data, message } satisfies CompilerReply),
      });
      break;
  }
  port.postMessage({ kind: "result", value } satisfies CompilerReply);
} catch (cause) {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  port.postMessage({
    kind: "error",
    error,
    ...("issues" in error ? { issues: error.issues as ZodIssue[] } : {}),
    ...("errors" in error ? { errors: error.errors as unknown[] } : {}),
    ...("warnings" in error ? { warnings: error.warnings as unknown[] } : {}),
  } satisfies CompilerReply);
}
