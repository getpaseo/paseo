import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { access } from "node:fs/promises";
import path from "node:path";

type Json = Record<string, unknown>;

export class SpacedriveDaemon {
  private child?: ChildProcess;
  constructor(private readonly executable = process.env.SPACEDRIVE_DAEMON ?? "sd-daemon.exe", private readonly port = 6969) {}

  async ensureRunning(): Promise<{ running: boolean; managed: boolean; port: number }> {
    if (await this.canConnect()) return { running: true, managed: Boolean(this.child), port: this.port };
    await access(this.executable);
    this.child = spawn(this.executable, [], { detached: true, stdio: "ignore", windowsHide: true });
    this.child.unref();
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (await this.canConnect()) return { running: true, managed: true, port: this.port };
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Spacedrive daemon did not listen on 127.0.0.1:${this.port}`);
  }

  async stopManaged(): Promise<void> {
    if (this.child && !this.child.killed) this.child.kill();
    this.child = undefined;
  }

  async call(method: string, params: Json, libraryId?: string): Promise<unknown> {
    await this.ensureRunning();
    const socket = net.createConnection({ host: "127.0.0.1", port: this.port });
    socket.setTimeout(10_000);
    await once(socket, "connect");
    const [kind, rpcMethod] = method.includes(":") ? method.split(":", 2) : ["Query", method];
    socket.write(`${JSON.stringify({ [kind === "action" ? "Action" : "Query"]: { method: rpcMethod, library_id: libraryId ?? null, payload: params } })}\n`);
    let buffer = "";
    return await new Promise((resolve, reject) => {
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        socket.destroy();
        try {
          const response = JSON.parse(line) as Json;
          if (response.Error) reject(new Error(JSON.stringify(response.Error)));
          else if (response.JsonOk !== undefined) resolve(response.JsonOk);
          else resolve(response);
        } catch (error) {
          reject(error);
        }
      });
      socket.once("timeout", () => { socket.destroy(); reject(new Error("Spacedrive RPC timed out")); });
      socket.once("error", reject);
    });
  }

  private async canConnect(): Promise<boolean> {
    return await new Promise((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port: this.port });
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
      socket.setTimeout(250, () => { socket.destroy(); resolve(false); });
    });
  }
}

export function resolveDaemonPath(): string {
  return path.resolve(process.env.SPACEDRIVE_DAEMON ?? "sd-daemon.exe");
}
