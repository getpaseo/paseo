import { spawnProcess } from "@getpaseo/plugin/server";
import { createInterface } from "node:readline";
import { ZCodeRpcClient } from "./rpc.js";

export interface ZCodeProcessOptions {
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  cwd?: string;
}

export interface ZCodeProcess {
  rpc: ZCodeRpcClient;
  /** Resolves once the child answered its first request. Rejects on startup failure. */
  ready: Promise<void>;
  stderr(): string;
  exit(): Promise<void>;
}

class ProcessRpcClient extends ZCodeRpcClient {
  constructor(private readonly writeLine: (line: string) => void) {
    super();
  }

  protected override write(line: string): void {
    this.writeLine(line);
  }
}

export function startZCodeProcess(options: ZCodeProcessOptions): ZCodeProcess {
  const child = spawnProcess(options.command, [...options.args], {
    cwd: options.cwd,
    env: { ...options.env },
    stdio: "pipe",
    detached: process.platform !== "win32",
  });

  let stderrText = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderrText += chunk;
  });

  const rpc = new ProcessRpcClient((line) => {
    child.stdin?.write(line);
  });

  const reader = createInterface({ input: child.stdout });
  reader.on("line", (line) => {
    rpc.receive(line);
  });

  let resolveReady: () => void;
  let rejectReady: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  ready.catch(() => undefined);

  child.on("exit", (code) => {
    const error = new Error(
      `ZCode exited with code ${code ?? "unknown"}.${stderrText ? ` ${stderrText.trim()}` : ""}`,
    );
    rejectReady(error);
    rpc.close();
  });
  child.on("error", (error) => {
    rejectReady(error instanceof Error ? error : new Error(String(error)));
  });

  // The child is ready once it answers a request.
  void rpc
    .call("runtime/capabilities", {})
    .then(() => resolveReady())
    .catch((error) => rejectReady(error instanceof Error ? error : new Error(String(error))));

  return {
    rpc,
    ready,
    stderr: () => stderrText,
    async exit() {
      rpc.close();
      child.stdin?.end();
      child.kill();
    },
  };
}
