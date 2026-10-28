import { spawn } from "node:child_process";
import { z } from "zod";
import { variableName } from "../shared/environment";
import type { EnvironmentStore, ProjectScope } from "./store";

export const executionInput = z
  .object({
    command: z.string().min(1).max(32768),
    variables: z.array(variableName).min(1).max(256),
    timeoutMs: z.number().int().min(100).max(120000).default(30000),
  })
  .strict();
export type ExecutionInput = z.input<typeof executionInput>;
export interface ExecutionResult {
  output: string;
  exitCode: number | null;
  signal: string | null;
  stopped: "timeout" | "output_limit" | "canceled" | null;
}
export interface ExecutionOptions {
  store: EnvironmentStore;
  scope: ProjectScope;
  input: ExecutionInput;
  signal?: AbortSignal;
}
const OUTPUT_LIMIT = 1024 * 1024;
const BASE_ENVIRONMENT = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "TZ",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "SYSTEMROOT",
  "WINDIR",
];

export function redact(text: string, secrets: string[]): string {
  const ordered = [...new Set(secrets)].filter(Boolean).sort((a, b) => b.length - a.length);
  let result = text;
  for (const secret of ordered) result = result.split(secret).join("[REDACTED]");
  return result;
}

export async function execute(options: ExecutionOptions): Promise<ExecutionResult> {
  const input = executionInput.parse(options.input);
  if (options.signal?.aborted) throw new Error("Environment command canceled");
  const variables = await options.store.read(options.scope);
  const env: NodeJS.ProcessEnv = {};
  for (const name of BASE_ENVIRONMENT) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  for (const name of input.variables) {
    const variable = variables.find((entry) => entry.name === name);
    if (!variable)
      throw new Error(`Variable ${name} is unavailable. List available variables first.`);
    env[name] = variable.value;
  }
  // Redact all project values, including a value read by the command from a local file.
  const secrets = variables.map((entry) => entry.value);
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", input.command], {
      cwd: options.scope.cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let stopped: ExecutionResult["stopped"] = null;
    function stop(reason: NonNullable<ExecutionResult["stopped"]>) {
      if (stopped) return;
      stopped = reason;
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
            reject(new Error("Cannot stop environment command"));
        }
      }
    }
    function collect(chunks: Buffer[], chunk: Buffer) {
      bytes += chunk.length;
      // Withhold an over-limit output completely; truncation could expose part of a secret.
      if (bytes > OUTPUT_LIMIT) {
        stdout.length = 0;
        stderr.length = 0;
        stop("output_limit");
        return;
      }
      if (!stopped) chunks.push(chunk);
    }
    function cancel() {
      stop("canceled");
    }
    const timer = setTimeout(() => stop("timeout"), input.timeoutMs);
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
    function cleanup() {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
    }
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("error", () => {
      cleanup();
      reject(new Error("Cannot start environment command"));
    });
    child.on("close", (exitCode, signal) => {
      cleanup();
      // A killed command may have printed only a prefix of a credential.
      const output = stopped
        ? "Command stopped; output withheld."
        : [stdout, stderr]
            .map((chunks) => redact(Buffer.concat(chunks).toString("utf8"), secrets))
            .join("");
      resolve({ output, exitCode, signal, stopped });
    });
  });
}
