import type {
  UsageReportEntry,
  UsageReport,
  UsageProblem,
  ProviderUsageWindow,
  ProviderUsageBalance,
} from "@getpaseo/protocol/messages";
import { renderTable, type OutputSchema } from "../../output/index.js";

function value(input: string | number | null | undefined): string {
  return input == null ? "-" : String(input);
}

function percent(input: number | null | undefined): string {
  return input == null ? "-" : `${input}%`;
}

function problemText(problem: UsageProblem): string {
  if (problem.kind === "no_quota") return problem.detail;
  const remedy = problem.refreshedBy
    ? `Run ${problem.refreshedBy} to refresh login.`
    : "Sign in again.";
  if (problem.kind === "expired") return `Login expired at ${problem.expiresAt}. ${remedy}`;
  return `Login rejected (HTTP ${problem.status}). ${remedy}`;
}

function failureText(report: UsageReport): string {
  if (report.status === "error") return report.error;
  if (report.status === "unavailable") return problemText(report.problem);
  return "-";
}

function windowText(window: ProviderUsageWindow): string {
  return `${window.label}: ${percent(window.usedPct)} used, ${percent(window.remainingPct)} remaining`;
}

function balanceText(balance: ProviderUsageBalance): string {
  return `${balance.label}: ${value(balance.used)} used, ${value(balance.remaining)} remaining, ${value(balance.limit)} limit (${balance.unit})`;
}

function summary(entry: UsageReportEntry): string[] {
  const { report } = entry;
  if (report.status !== "available") {
    const lines = [failureText(report)];
    for (const login of entry.loginErrors ?? [])
      lines.push(`${login.harness}: ${failureText(login.report)}`);
    return lines;
  }
  const lines = report.windows.map(windowText);
  lines.push(...(report.balances ?? []).map(balanceText));
  return lines.length ? lines : ["-"];
}

interface SummaryRow {
  id: string;
  source: string;
  account: string;
  status: string;
  usage: string;
  fetched: string;
}

const summarySchema: OutputSchema<SummaryRow> = {
  idField: "id",
  columns: [
    { header: "REPORT ID", field: "id" },
    { header: "SOURCE", field: "source" },
    { header: "ACCOUNT", field: "account" },
    { header: "STATUS", field: "status" },
    { header: "USAGE", field: "usage" },
    { header: "FETCHED", field: "fetched" },
  ],
};

function inspect(entry: UsageReportEntry): string {
  const lines = [
    `Report ID: ${entry.id}`,
    `Source: ${entry.sourceLabel}`,
    `Source ID: ${entry.sourceId}`,
    `Account: ${value(entry.account.label)}`,
    `Status: ${entry.report.status}`,
    `Fetched: ${value(entry.fetchedAt)}`,
  ];
  const { report } = entry;
  if (report.status === "available") {
    lines.push(`Plan: ${value(report.planLabel)}`, "Windows:");
    if (!report.windows.length) lines.push("  -");
    for (const window of report.windows) {
      lines.push(`  ${windowText(window)} [${window.id}]`, `    Resets: ${value(window.resetsAt)}`);
      if (window.runsOutAt != null) lines.push(`    Runs out: ${window.runsOutAt}`);
      if (window.shortfallPct != null) lines.push(`    Shortfall: ${percent(window.shortfallPct)}`);
    }
    lines.push("Balances:");
    if (!report.balances?.length) lines.push("  -");
    for (const balance of report.balances ?? []) {
      lines.push(
        `  ${balanceText(balance)} [${balance.id}]`,
        `    Resets: ${value(balance.resetsAt)}`,
      );
    }
    lines.push("Details:");
    if (!report.details?.length) lines.push("  -");
    for (const detail of report.details ?? []) lines.push(`  ${detail.label}: ${detail.value}`);
  } else {
    lines.push(`Reason: ${failureText(report)}`);
  }
  if (entry.loginErrors?.length) {
    lines.push("Login failures:");
    for (const login of entry.loginErrors)
      lines.push(`  ${login.harness}: ${failureText(login.report)}`);
  }
  return lines.join("\n");
}

export const usageSchema: OutputSchema<UsageReportEntry> = {
  idField: "id",
  columns: [],
  renderHuman(result, options) {
    if (result.type === "single") return inspect(result.data);
    if (!result.data.length) return "No usage reports returned";
    const rows: SummaryRow[] = [];
    for (const entry of result.data) {
      for (const [index, usage] of summary(entry).entries()) {
        const first = index === 0;
        rows.push({
          id: first ? entry.id : "",
          source: first ? entry.sourceLabel : "",
          account: first ? value(entry.account.label) : "",
          status: first ? entry.report.status : "",
          usage,
          fetched: first ? value(entry.fetchedAt) : "",
        });
      }
    }
    return renderTable<SummaryRow>({ type: "list", data: rows, schema: summarySchema }, options);
  },
};
