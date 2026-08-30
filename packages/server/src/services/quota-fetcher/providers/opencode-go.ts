import type { Logger } from "pino";
import type { ProviderUsage } from "../../../server/messages.js";
import type { ProviderUsageFetcher } from "../provider.js";
import { unavailableUsage } from "../usage.js";
import { OmpUsageRunner, providerUsageFromOmpReport, type OmpUsageExec } from "./omp-usage.js";

interface OpencodeGoQuotaProviderOptions {
  logger: Logger;
  exec?: OmpUsageExec;
  ompCommand?: [string, ...string[]];
}

/** OpenCode Go plan usage. Data comes from OMP, which owns the plan's auth. */
export class OpencodeGoQuotaProvider implements ProviderUsageFetcher {
  readonly providerId = "opencode-go";
  readonly displayName = "OpenCode Go";

  private readonly omp: OmpUsageRunner;

  constructor(options: OpencodeGoQuotaProviderOptions) {
    this.omp = new OmpUsageRunner({
      logger: options.logger,
      command: options.ompCommand,
      exec: options.exec,
    });
  }

  async fetchUsage(): Promise<ProviderUsage> {
    const report = await this.omp.fetchReport(this.providerId);
    const usage = report
      ? providerUsageFromOmpReport({
          report,
          providerId: this.providerId,
          displayName: this.displayName,
        })
      : null;
    if (usage) return usage;

    return unavailableUsage(this);
  }
}
