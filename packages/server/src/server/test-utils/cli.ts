import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { TestPaseoDaemon } from "./paseo-daemon.js";

interface CliOptions {
  daemon: Pick<TestPaseoDaemon, "port" | "paseoHome">;
  args: string[];
}

interface CliResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export function runPaseoCli({ daemon, args }: CliOptions): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--no-warnings",
        "--conditions=source",
        "--import",
        "tsx",
        fileURLToPath(new URL("../../../../cli/src/index.ts", import.meta.url)),
        "--host",
        `127.0.0.1:${daemon.port}`,
        ...args,
      ],
      {
        env: { ...process.env, PASEO_HOME: daemon.paseoHome },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}
