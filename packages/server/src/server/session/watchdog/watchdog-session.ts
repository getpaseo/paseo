import type {
  SessionOutboundMessage,
  WatchdogCancelRequest,
  WatchdogInspectRequest,
  WatchdogListRequest,
  WatchdogStartRequest,
} from "@getpaseo/protocol/messages";
import type { Logger } from "pino";

import type { WatchdogService } from "../../watchdog/service.js";

interface WatchdogSessionHost {
  emit(message: SessionOutboundMessage): void;
}

export class WatchdogSession {
  constructor(
    private readonly host: WatchdogSessionHost,
    private readonly service: WatchdogService,
    private readonly logger: Logger,
  ) {}

  async handleStart(message: WatchdogStartRequest): Promise<void> {
    try {
      const job = await this.service.register({
        name: message.name,
        agentId: message.agentId,
        workspaceId: message.workspaceId,
        cwd: message.cwd,
        command: message.command,
        args: message.args ?? [],
        ...(message.timeoutMs === undefined ? {} : { timeoutMs: message.timeoutMs }),
      });
      this.host.emit({
        type: "watchdog.start.response",
        payload: { requestId: message.requestId, job, error: null },
      });
    } catch (error) {
      this.emitError("watchdog.start.response", message.requestId, error);
    }
  }

  async handleList(message: WatchdogListRequest): Promise<void> {
    try {
      const jobs = message.agentId
        ? await this.service.listForAgent(message.agentId)
        : await this.service.list();
      this.host.emit({
        type: "watchdog.list.response",
        payload: { requestId: message.requestId, jobs, error: null },
      });
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to list watchdog jobs");
      this.host.emit({
        type: "watchdog.list.response",
        payload: { requestId: message.requestId, jobs: [], error: toErrorMessage(error) },
      });
    }
  }

  async handleInspect(message: WatchdogInspectRequest): Promise<void> {
    try {
      const job = await this.service.inspect(message.jobId);
      this.host.emit({
        type: "watchdog.inspect.response",
        payload: { requestId: message.requestId, job, error: null },
      });
    } catch (error) {
      this.emitError("watchdog.inspect.response", message.requestId, error);
    }
  }

  async handleCancel(message: WatchdogCancelRequest): Promise<void> {
    try {
      const job = await this.service.cancel(message.jobId);
      this.host.emit({
        type: "watchdog.cancel.response",
        payload: { requestId: message.requestId, job, error: null },
      });
    } catch (error) {
      this.emitError("watchdog.cancel.response", message.requestId, error);
    }
  }

  private emitError(
    type: "watchdog.start.response" | "watchdog.inspect.response" | "watchdog.cancel.response",
    requestId: string,
    error: unknown,
  ): void {
    this.logger.warn({ err: error, type }, "Watchdog request failed");
    this.host.emit({
      type,
      payload: { requestId, job: null, error: toErrorMessage(error) },
    });
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
