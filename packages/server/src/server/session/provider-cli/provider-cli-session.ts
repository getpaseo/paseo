import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { ProviderCliService } from "../../agent/provider-cli/provider-cli-service.js";

type ProviderCliRuntime = Pick<
  ProviderCliService,
  "listStatus" | "startUpdate" | "startLogin" | "sendLoginInput" | "cancelLogin"
>;

export interface ProviderCliSessionOptions {
  emit(message: SessionOutboundMessage): void;
  // Absent on daemons embedded without provider CLI management.
  runtime?: ProviderCliRuntime | null;
}

type AckResponseType =
  | "provider.cli.update.start.response"
  | "provider.cli.login.start.response"
  | "provider.cli.login.input.response"
  | "provider.cli.login.cancel.response";

export class ProviderCliSession {
  constructor(private readonly options: ProviderCliSessionOptions) {}

  // Handles the provider.cli.* requests; returns undefined for any other message.
  dispatch(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "provider.cli.status.list.request":
        return this.handleList(msg);
      case "provider.cli.update.start.request":
        return this.ack(msg.requestId, "provider.cli.update.start.response", () =>
          this.requireRuntime().startUpdate(msg.provider),
        );
      case "provider.cli.login.start.request":
        return this.ack(msg.requestId, "provider.cli.login.start.response", () =>
          this.requireRuntime().startLogin(msg.provider),
        );
      case "provider.cli.login.input.request":
        return this.ack(msg.requestId, "provider.cli.login.input.response", () =>
          this.requireRuntime().sendLoginInput(msg.provider, msg.text),
        );
      case "provider.cli.login.cancel.request":
        return this.ack(msg.requestId, "provider.cli.login.cancel.response", () =>
          this.requireRuntime().cancelLogin(msg.provider),
        );
      default:
        return undefined;
    }
  }

  private async handleList(
    msg: Extract<SessionInboundMessage, { type: "provider.cli.status.list.request" }>,
  ): Promise<void> {
    try {
      const providers = await this.requireRuntime().listStatus({ refresh: msg.refresh });
      this.options.emit({
        type: "provider.cli.status.list.response",
        payload: { requestId: msg.requestId, providers, error: null },
      });
    } catch (error) {
      this.options.emit({
        type: "provider.cli.status.list.response",
        payload: { requestId: msg.requestId, providers: [], error: describeError(error) },
      });
    }
  }

  private async ack(
    requestId: string,
    type: AckResponseType,
    run: () => void | Promise<void>,
  ): Promise<void> {
    try {
      await run();
      this.options.emit({ type, payload: { requestId, error: null } });
    } catch (error) {
      this.options.emit({ type, payload: { requestId, error: describeError(error) } });
    }
  }

  private requireRuntime(): ProviderCliRuntime {
    if (!this.options.runtime) {
      throw new Error("Provider CLI management is unavailable on this daemon");
    }
    return this.options.runtime;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
