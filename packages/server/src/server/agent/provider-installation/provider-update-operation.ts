import type {
  ProviderInstallationUpdate,
  ProviderInstallationUpdateOperation,
  ProviderInstallationUpdateOutput,
  ProviderInstallationUpdateProgress,
} from "@getpaseo/protocol/messages";
import type { ProviderUpdateResult } from "@getpaseo/plugin/server/provider";

interface ProviderUpdateOperationOptions {
  id: string;
  provider: string;
  startedAt: string;
  /** Characters of output text retained; the oldest output is dropped beyond it. */
  outputLimit: number;
  publish(progress: ProviderInstallationUpdateProgress): void;
}

/**
 * One provider update: its state and the output it reported, bounded to `outputLimit`
 * characters. Output reported after the update settles is ignored.
 */
export class ProviderUpdateOperation {
  private state: ProviderInstallationUpdateOperation;
  private readonly output: ProviderInstallationUpdateOutput[] = [];
  private outputLength = 0;
  private truncated = false;

  constructor(private readonly options: ProviderUpdateOperationOptions) {
    this.state = { status: "running", id: options.id, startedAt: options.startedAt };
    this.publish([]);
  }

  get running(): boolean {
    return this.state.status === "running";
  }

  append(entry: ProviderInstallationUpdateOutput): void {
    if (!this.running) return;
    const limit = this.options.outputLimit;
    const kept =
      entry.text.length > limit ? { type: entry.type, text: entry.text.slice(-limit) } : entry;
    if (kept !== entry) this.truncated = true;
    this.output.push(kept);
    this.outputLength += kept.text.length;
    while (this.outputLength > limit) {
      const dropped = this.output.shift()!;
      this.outputLength -= dropped.text.length;
      this.truncated = true;
    }
    this.publish([kept]);
  }

  settle(result: ProviderUpdateResult, finishedAt: string): void {
    if (!this.running) return;
    const { id, startedAt } = this.state;
    this.state =
      result.status === "succeeded"
        ? {
            status: "succeeded",
            id,
            startedAt,
            finishedAt,
            ...(result.message === undefined ? {} : { message: result.message }),
          }
        : { status: "failed", id, startedAt, finishedAt, message: result.message };
    this.publish([]);
  }

  snapshot(): ProviderInstallationUpdate {
    return {
      operation: this.state,
      output: [...this.output],
      ...(this.truncated ? { truncated: true } : {}),
    };
  }

  private publish(output: ProviderInstallationUpdateOutput[]): void {
    this.options.publish({ provider: this.options.provider, operation: this.state, output });
  }
}
