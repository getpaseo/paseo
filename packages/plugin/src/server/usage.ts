import type { ZodType } from "zod";
import type { JsonValue } from "@getpaseo/protocol/agent-types";

export interface UsageWindow {
  id: string;
  label: string;
  usedPct?: number | null;
  remainingPct?: number | null;
  resetsAt?: string | null;
  runsOutAt?: string | null;
  shortfallPct?: number | null;
  tone?: "default" | "ok" | "warning" | "danger";
  headline?: boolean;
}

export interface UsageBalance {
  id: string;
  label: string;
  used?: number | null;
  remaining?: number | null;
  limit?: number | null;
  unit: "usd" | "credits" | "requests" | "tokens";
  resetsAt?: string | null;
  tone?: UsageWindow["tone"];
}

export interface UsageDetail {
  id: string;
  label: string;
  value: string;
  tone?: UsageWindow["tone"];
}

export interface UsageReport {
  account: { key: string; label?: string };
  status: "available" | "unavailable" | "error";
  planLabel?: string;
  windows: UsageWindow[];
  balances?: UsageBalance[];
  details?: UsageDetail[];
  error?: string;
}

export interface UsageSourceRegistration {
  id: string;
  label: string;
  icon?: string;
  input: ZodType;
  fetch(input: unknown): Promise<UsageReport>;
  discover?(): Promise<JsonValue[]>;
}
