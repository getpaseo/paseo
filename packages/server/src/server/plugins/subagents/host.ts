import type { PluginSubagentReporter } from "@getpaseo/plugin/server";
import { parseSubagentEvent, type PluginSubagentRequest } from "./protocol.js";

export interface PluginSubagentHost {
  open(pluginId: string, parentAgentId: string): PluginSubagentReporter;
}

interface ReportReceipt {
  sequence: number;
  encoded: string;
  error: string | null;
}

interface Reporter {
  reporter: PluginSubagentReporter;
  tail: Promise<void>;
  receipt: ReportReceipt | null;
  closed: boolean;
}

/** One instance per subprocess. Never reuse it for a replacement installation. */
export class PluginSubagentRequests {
  private readonly reporters = new Map<string, Reporter>();
  private stopped = false;

  constructor(
    private readonly pluginId: string,
    private readonly host: PluginSubagentHost | null,
  ) {}

  async receive(request: PluginSubagentRequest): Promise<void> {
    const { reporterId, operation } = request;
    if (operation.type === "close") {
      const state = this.reporters.get(reporterId);
      if (!state) return;
      this.reporters.delete(reporterId);
      state.closed = true;
      await state.reporter.close();
      return;
    }
    if (this.stopped) throw new Error("Plugin subagent reporting is stopped");
    if (operation.type === "open") {
      if (!this.host) throw new Error("Plugin subagent reporting is unavailable");
      if (this.reporters.has(reporterId)) throw new Error("Duplicate subagent reporter");
      if (this.reporters.size >= 128) throw new Error("Plugin subagent reporter limit reached");
      const reporter = this.host.open(this.pluginId, operation.parentAgentId);
      this.reporters.set(reporterId, {
        reporter,
        tail: Promise.resolve(),
        receipt: null,
        closed: false,
      });
      return;
    }
    const state = this.reporters.get(reporterId);
    if (!state) throw new Error("Subagent reporter is closed");
    const result = state.tail.then(async () => {
      if (this.stopped || state.closed) throw new Error("Subagent reporter is closed");
      const event = parseSubagentEvent(operation.event);
      const encoded = JSON.stringify(event);
      const previous = state.receipt;
      if (previous?.sequence === operation.sequence) {
        if (previous.encoded !== encoded)
          throw new Error("Subagent sequence reused with different data");
        if (previous.error !== null) throw new Error(previous.error);
        return;
      }
      if (operation.sequence !== (previous?.sequence ?? 0) + 1) {
        throw new Error("Subagent report sequence is out of order");
      }
      const receipt: ReportReceipt = { sequence: operation.sequence, encoded, error: null };
      state.receipt = receipt;
      try {
        await state.reporter.report(event);
      } catch (error) {
        receipt.error = error instanceof Error ? error.message : String(error);
        throw error;
      }
      return;
    });
    state.tail = result.catch(() => undefined);
    await result;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const states = [...this.reporters.values()];
    this.reporters.clear();
    for (const state of states) state.closed = true;
    await Promise.all(states.map((state) => state.reporter.close()));
  }
}
