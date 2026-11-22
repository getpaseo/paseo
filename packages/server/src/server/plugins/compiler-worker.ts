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
      properties: Record<string, unknown>;
      issues?: ZodIssue[];
      errors?: unknown[];
      warnings?: unknown[];
    };

// The compiler owner serializes requests. IPC holds the process open between
// tasks and lets it exit when the daemon retires it or exits.
process.on("message", (task: CompilerTask) => {
  void run(task);
});

function reply(message: CompilerReply): void {
  if (process.connected) process.send!(message);
}

async function run(task: CompilerTask): Promise<void> {
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
        await runPluginBuild(
          task.directory,
          task.commands,
          {
            info: (data, message) => reply({ kind: "log", data, message }),
          },
          task.environment,
        );
        break;
    }
    reply({ kind: "result", value });
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    reply({
      kind: "error",
      error,
      // Error cloning drops own metadata such as filesystem code/path. Zod's
      // readonly issues are reconstructed separately by the compiler owner.
      properties: Object.fromEntries(Object.entries(error).filter(([key]) => key !== "issues")),
      ...("issues" in error ? { issues: error.issues as ZodIssue[] } : {}),
      ...("errors" in error ? { errors: error.errors as unknown[] } : {}),
      ...("warnings" in error ? { warnings: error.warnings as unknown[] } : {}),
    });
  }
}
