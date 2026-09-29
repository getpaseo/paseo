import type pino from "pino";
import type { ProviderUsage, UsageReportEntry } from "@getpaseo/protocol/messages";
import type { AgentSession, UsageReference } from "../../agent/agent-sdk-types.js";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";

interface UsageAgent {
  session: AgentSession | null;
}

export interface UsageSessionOptions {
  emit(message: SessionOutboundMessage): void;
  listAgents(): UsageAgent[];
  getAgent(agentId: string): UsageAgent | null;
  runtime?: {
    listUsageReports(options: {
      forceRefresh?: boolean;
      reportIds?: string[];
      references: UsageReference[];
    }): Promise<UsageReportEntry[]>;
    resolveUsageReference(reference: UsageReference): Promise<string | null>;
    listLegacyUsage(): Promise<{ fetchedAt: string; providers: ProviderUsage[] }>;
  };
  logger: pino.Logger;
}

export class UsageSession {
  constructor(private readonly options: UsageSessionOptions) {}

  async handleListReports(
    msg: Extract<SessionInboundMessage, { type: "usage.list_reports.request" }>,
  ): Promise<void> {
    try {
      if (!this.options.runtime) throw new Error("Plugin runtime is unavailable");
      const references =
        msg.reportIds === undefined
          ? (
              await Promise.all(
                this.options
                  .listAgents()
                  .map(
                    async (agent) => agent.session?.getUsageReference?.().catch(() => null) ?? null,
                  ),
              )
            ).filter((reference): reference is UsageReference => reference !== null)
          : [];
      const reports = await this.options.runtime.listUsageReports({
        forceRefresh: msg.forceRefresh,
        reportIds: msg.reportIds,
        references,
      });
      this.options.emit({
        type: "usage.list_reports.response",
        payload: { requestId: msg.requestId, reports },
      });
    } catch (error) {
      this.emitError(msg, error, "usage_list_reports_failed");
    }
  }

  async handleResolveAgentReport(
    msg: Extract<SessionInboundMessage, { type: "agent.resolve_usage_report.request" }>,
  ): Promise<void> {
    try {
      if (!this.options.runtime) throw new Error("Plugin runtime is unavailable");
      const agent = this.options.getAgent(msg.agentId);
      if (!agent) {
        this.emitError(msg, new Error(`Agent not found: ${msg.agentId}`), "agent_not_found");
        return;
      }
      const reference = (await agent.session?.getUsageReference?.()) ?? null;
      const reportId = reference
        ? await this.options.runtime.resolveUsageReference(reference)
        : null;
      this.options.emit({
        type: "agent.resolve_usage_report.response",
        payload: { requestId: msg.requestId, reportId },
      });
    } catch (error) {
      this.emitError(msg, error, "agent_resolve_usage_report_failed");
    }
  }

  // COMPAT(providerUsageList): added in v0.9.3, remove after 2027-03-26.
  async handleLegacyList(
    msg: Extract<SessionInboundMessage, { type: "provider.usage.list.request" }>,
  ): Promise<void> {
    try {
      if (!this.options.runtime) throw new Error("Plugin runtime is unavailable");
      const usage = await this.options.runtime.listLegacyUsage();
      this.options.emit({
        type: "provider.usage.list.response",
        payload: {
          requestId: msg.requestId,
          fetchedAt: usage.fetchedAt,
          providers: usage.providers,
        },
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.options.logger.error({ err }, "Failed to list provider usage");
      this.options.emit({
        type: "rpc_error",
        payload: {
          requestId: msg.requestId,
          requestType: msg.type,
          error: `Failed to list provider usage: ${err.message}`,
          code: "provider_usage_list_failed",
        },
      });
    }
  }

  private emitError(
    msg: Extract<
      SessionInboundMessage,
      { type: "usage.list_reports.request" | "agent.resolve_usage_report.request" }
    >,
    error: unknown,
    code: string,
  ): void {
    this.options.emit({
      type: "rpc_error",
      payload: {
        requestId: msg.requestId,
        requestType: msg.type,
        error: error instanceof Error ? error.message : String(error),
        code,
      },
    });
  }
}
