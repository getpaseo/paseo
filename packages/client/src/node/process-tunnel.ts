import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Socket } from "node:net";

const STDERR_LIMIT = 8192;

export interface ProcessTunnel {
  endpoint: string;
  close(): void;
  failureDetail(): string | null;
}

export interface ProcessTunnelOptions {
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

interface ProcessTunnelCommand {
  executable: "ssh" | "et";
  args: string[];
  options: ProcessTunnelOptions;
  describeStderr: (stderr: string) => string | null;
}

export function createProcessTunnel({
  executable,
  args,
  options,
  describeStderr,
}: ProcessTunnelCommand): Promise<ProcessTunnel> {
  let socket: Socket | null = null;
  let child: ChildProcessWithoutNullStreams | null = null;
  let closed = false;
  let stderr = "";
  let failure: string | null = null;

  function stopChild(): void {
    const process = child;
    child = null;
    if (process && process.exitCode === null && process.signalCode === null) process.kill();
  }

  function close(): void {
    if (closed) return;
    closed = true;
    server.close();
    socket?.destroy();
    stopChild();
  }

  const server = createServer((accepted) => {
    if (closed || socket) {
      accepted.destroy();
      return;
    }
    socket = accepted;
    server.close();
    accepted.on("error", () => undefined);
    accepted.once("close", stopChild);

    const process = spawn(executable, args, {
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child = process;
    process.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-STDERR_LIMIT);
    });
    process.on("error", (error) => {
      failure = executable === "ssh" ? error.message : "Could not start Eternal Terminal.";
      accepted.destroy();
    });
    const onStreamError = (error: Error) => {
      if (executable === "ssh") failure = describeStderr(stderr) ?? error.message;
      accepted.destroy();
    };
    process.stdin.on("error", onStreamError);
    process.stdout.on("error", onStreamError);
    process.once("exit", (code, signal) => {
      if (code !== 0 || signal) {
        failure =
          describeStderr(stderr) ??
          (signal
            ? `${executable} exited with signal ${signal}`
            : `${executable} exited with code ${code ?? "unknown"}`);
      }
      accepted.destroy();
    });
    accepted.pipe(process.stdin);
    process.stdout.pipe(accepted);
  });

  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(options.signal.reason);
      return;
    }
    const onAbort = () => {
      close();
      reject(options.signal?.reason);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    server.once("error", (error) => {
      options.signal?.removeEventListener("abort", onAbort);
      close();
      reject(error);
    });
    server.listen(0, "127.0.0.1", () => {
      options.signal?.removeEventListener("abort", onAbort);
      const address = server.address();
      if (!address || typeof address === "string") {
        close();
        reject(new Error(`Failed to allocate the ${executable} tunnel port`));
        return;
      }
      resolve({
        endpoint: `127.0.0.1:${address.port}`,
        close,
        failureDetail: () => failure ?? describeStderr(stderr),
      });
    });
  });
}
