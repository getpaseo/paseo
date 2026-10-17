import { randomUUID } from "node:crypto";
import type {
  DesktopCommand,
  DesktopExecuteRequest,
  DesktopExecuteResponse,
} from "@getpaseo/protocol/desktop-capture";
interface AgentAccess {
  deviceId: string;
  observationOnly: boolean;
}
interface Host {
  source: string;
  send(
    message: DesktopExecuteRequest | { type: "desktop.control.revoked"; sessionId: string },
  ): void;
}
interface Control {
  id: string;
  agentId: string;
  deviceId: string;
  host: Host;
  idle: ReturnType<typeof setTimeout>;
}
interface Pending {
  control: Control;
  resolve(result: Record<string, unknown>): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
interface Waiter {
  agentId: string;
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class DesktopToolsBroker {
  private readonly hosts = new Map<string, Host>();
  private readonly revoked = new Set<string>();
  private readonly pending = new Map<string, Pending>();
  private readonly waiting = new Set<Waiter>();
  private control: Control | null = null;
  private lane: Promise<unknown> = Promise.resolve();
  constructor(private readonly access: (agentId: string) => AgentAccess | null) {}

  available() {
    return this.hosts.size > 0;
  }
  registerHost(source: string, deviceId: string, send: Host["send"]) {
    if (this.hosts.has(deviceId)) throw new Error("This Mac already has a desktop host.");
    const host = { source, send };
    this.hosts.set(deviceId, host);
    return () => {
      if (this.hosts.get(deviceId) !== host) return;
      this.stop(source, deviceId);
      this.hosts.delete(deviceId);
    };
  }
  stop(source: string, deviceId: string) {
    const control = this.control;
    if (this.hosts.get(deviceId)?.source !== source) return;
    for (const waiter of this.waiting) {
      if (this.access(waiter.agentId)?.deviceId !== deviceId) continue;
      this.revoked.add(waiter.agentId);
      this.waiting.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Desktop control revoked."));
    }
    if (control?.host.source === source && control.deviceId === deviceId)
      this.release(control.agentId, true);
  }
  release(agentId: string, revoke = false) {
    if (revoke) this.revoked.add(agentId);
    const control = this.control;
    if (control?.agentId !== agentId) return;
    this.control = null;
    clearTimeout(control.idle);
    for (const [id, request] of this.pending) {
      if (request.control !== control) continue;
      clearTimeout(request.timer);
      this.pending.delete(id);
      request.reject(
        new Error(
          "Desktop control revoked; the last action may have completed. Never replay it automatically.",
        ),
      );
    }
    try {
      control.host.send({ type: "desktop.control.revoked", sessionId: control.id });
    } catch {
      /* The disconnected host is already revoked. */
    } finally {
      for (const waiter of this.waiting) {
        clearTimeout(waiter.timer);
        waiter.resolve();
      }
      this.waiting.clear();
    }
  }
  private async acquire(agentId: string): Promise<Control> {
    if (this.revoked.has(agentId)) throw new Error("Desktop control revoked.");
    const access = this.access(agentId);
    if (!access) throw new Error("This agent has no desktop session.");
    const host = this.hosts.get(access.deviceId);
    if (!host) throw new Error("The Mac is disconnected.");
    if (this.control && this.control.agentId !== agentId) {
      await new Promise<void>((resolve, reject) => {
        const waiter: Waiter = {
          agentId,
          resolve,
          reject,
          timer: setTimeout(() => {
            this.waiting.delete(waiter);
            reject(new Error("The Mac is busy. No action was sent."));
          }, 60000),
        };
        this.waiting.add(waiter);
      });
      return this.acquire(agentId);
    }
    if (!this.control)
      this.control = {
        id: randomUUID(),
        agentId,
        deviceId: access.deviceId,
        host,
        idle: setTimeout(() => this.release(agentId, true), 60000),
      };
    return this.control;
  }
  async execute(agentId: string, command: DesktopCommand) {
    const access = this.access(agentId);
    if (!access) throw new Error("This agent has no desktop session.");
    const observation = command.command === "screenshot" || command.command === "accessibility";
    if (access.observationOnly && !observation)
      throw new Error("Plan mode permits observation only.");
    const control = await this.acquire(agentId);
    const operation = this.lane.then(async () => {
      if (this.control !== control || this.revoked.has(agentId))
        throw new Error("Desktop control revoked.");
      const latest = this.access(agentId);
      if (!latest || (latest.observationOnly && !observation))
        throw new Error("Plan mode permits observation only.");
      clearTimeout(control.idle);
      control.idle = setTimeout(() => this.release(agentId, true), 60000);
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const requestId = randomUUID();
        const timer = setTimeout(() => this.release(agentId, true), 15000);
        this.pending.set(requestId, { control, resolve, reject, timer });
        try {
          control.host.send({
            type: "desktop.control.execute.request",
            requestId,
            sessionId: control.id,
            deviceId: control.deviceId,
            agentId,
            command,
          });
        } catch {
          this.release(agentId, true);
        }
      });
    });
    this.lane = operation.catch(() => {});
    return operation;
  }
  respond(source: string, response: DesktopExecuteResponse) {
    const { requestId, sessionId, ok, result, error } = response.payload;
    const pending = this.pending.get(requestId);
    if (!pending || pending.control.host.source !== source || pending.control.id !== sessionId)
      return false;
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    if (ok) pending.resolve(result ?? {});
    else {
      pending.reject(
        new Error(error ?? "Desktop action failed; do not replay an uncertain action."),
      );
      this.release(pending.control.agentId, true);
    }
    return true;
  }
}
