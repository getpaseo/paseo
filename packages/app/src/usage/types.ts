import type {
  ProviderUsageTone,
  UsageReportEntry as WireUsageReportEntry,
} from "@getpaseo/protocol/messages";

export interface UsageReportEntry extends WireUsageReportEntry {
  /** A refresh failed while this reading was cached. */
  forecastStale?: true;
}
export type UsageReport = UsageReportEntry["report"];
export type UsageTone = ProviderUsageTone;
export type AvailableUsageReport = Extract<UsageReport, { status: "available" }>;
export type UsageWindow = AvailableUsageReport["windows"][number];
export type UsageBalance = NonNullable<AvailableUsageReport["balances"]>[number];
export type UsageBalanceUnit = UsageBalance["unit"];

/** What a host's usage surface shows. `unavailable` is a host state, not a failed request. */
export type UsageView =
  | { kind: "off"; message: string }
  | { kind: "unavailable"; message: string }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; reports: UsageReportEntry[]; isRefreshing: boolean; refreshFailed: boolean };
