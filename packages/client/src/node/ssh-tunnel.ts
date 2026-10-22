import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import { buildSshTunnelArgs, type SshTransportTarget } from "@getpaseo/protocol/ssh-transport";

const SSH_STDERR_LIMIT = 8192;

export interface SshTunnel {
  endpoint: string;
  close(): void;
  failureDetail(): string | null;
}

function formatSshFailure(
  stderr: string,
  code: number | null,
  signal: NodeJS.Signals | null,
): string {
  const detail = stderr.trim();
  if (detail) return detail;
  if (signal) return `ssh exited with signal ${signal}`;
  return `ssh exited with code ${code ?? "unknown"}`;
}

export function resolveSshFailureDetail(failure: string | null, stderr: string): string | null {
  return failure ?? (stderr.trim() || null);
}

export function createSshTunnel(target: SshTransportTarget): Promise<SshTunnel> {
  let server: Server | null = null;
  let socket: Socket | null = null;
  let child: ChildProcessWithoutNullStreams | null = null;
  let stderr = "";
  let failure: string | null = null;

  function close(): void {
    server?.close();
    server = null;
    socket?.destroy();
    socket = null;
    if (child && !child.killed) child.kill();
    child = null;
  }

  return new Promise((resolve, reject) => {
    server = createServer((acceptedSocket) => {
      socket = acceptedSocket;
      server?.close();
      server = null;

      child = spawn("ssh", buildSshTunnelArgs(target), {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        stderr = `${stderr}${chunk.toString()}`.slice(-SSH_STDERR_LIMIT);
      });
      child.on("error", (error) => {
        failure = error.message;
        acceptedSocket.destroy(error);
      });
      child.on("exit", (code, signal) => {
        if (code !== 0 || signal) failure = formatSshFailure(stderr, code, signal);
        acceptedSocket.destroy(failure ? new Error(failure) : undefined);
      });
      acceptedSocket.on("error", () => undefined);
      acceptedSocket.on("close", () => {
        if (child && !child.killed) child.kill();
      });
      acceptedSocket.pipe(child.stdin);
      child.stdout.pipe(acceptedSocket);
    });
    server.once("error", (error) => {
      close();
      reject(error);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server?.address();
      if (!address || typeof address === "string") {
        close();
        reject(new Error("Failed to allocate the SSH tunnel port"));
        return;
      }
      resolve({
        endpoint: `127.0.0.1:${address.port}`,
        close,
        failureDetail: () => resolveSshFailureDetail(failure, stderr),
      });
    });
  });
}
