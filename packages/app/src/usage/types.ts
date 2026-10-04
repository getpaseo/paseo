import type { ProviderUsageTone, UsageReportEntry } from "@getpaseo/protocol/messages";

export type { UsageReportEntry };
export type UsageReport = UsageReportEntry["report"];
export type UsageTone = ProviderUsageTone;
export type AvailableUsageReport = Extract<UsageReport, { status: "available" }>;
export type UsageWindow = AvailableUsageReport["windows"][number];
export type UsageBalance = NonNullable<AvailableUsageReport["balances"]>[number];
export type UsageBalanceUnit = UsageBalance["unit"];

/** What a host's usage surface shows. `unavailable` is a host state, not a failed request. */
export type UsageView =
  | { kind: "unavailable"; message: string }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; reports: UsageReportEntry[]; isRefreshing: boolean };
