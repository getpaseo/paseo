import type { Command } from "commander";

import type { CommandOptions, ListResult, OutputSchema } from "../../output/index.js";
import { getDaemonHost } from "../../utils/client.js";
import { getDaemonJson } from "./http.js";

interface WeChatAccountStatus {
  id: string;
  rawAccountId: string;
  userId?: string;
  baseUrl: string;
  enabled: boolean;
  running: boolean;
  createdAt: string;
  updatedAt: string;
  getUpdatesBuf?: string;
  lastInboundAt?: string;
  lastOutboundAt?: string;
  lastError?: string | null;
}

interface WeChatAccountsResponse {
  accounts?: WeChatAccountStatus[];
}

interface WeChatStatusRow {
  id: string;
  user: string;
  running: string;
  enabled: string;
  lastInbound: string;
  lastOutbound: string;
  error: string;
}

function formatTimestamp(value?: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value : "-";
}

function formatError(value?: string | null): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return "-";
  }
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= 96 ? normalized : `${normalized.slice(0, 93)}...`;
}

function toStatusRows(accounts: WeChatAccountStatus[]): WeChatStatusRow[] {
  return accounts.map((account) => ({
    id: account.id,
    user: account.userId?.trim() || account.rawAccountId,
    running: account.running ? "yes" : "no",
    enabled: account.enabled ? "yes" : "no",
    lastInbound: formatTimestamp(account.lastInboundAt),
    lastOutbound: formatTimestamp(account.lastOutboundAt),
    error: formatError(account.lastError),
  }));
}

function createStatusSchema(accounts: WeChatAccountStatus[]): OutputSchema<WeChatStatusRow> {
  return {
    idField: "id",
    columns: [
      { header: "ACCOUNT", field: "id" },
      { header: "USER", field: "user" },
      {
        header: "RUNNING",
        field: "running",
        color: (value) => (value === "yes" ? "green" : "red"),
      },
      {
        header: "ENABLED",
        field: "enabled",
        color: (value) => (value === "yes" ? "green" : "yellow"),
      },
      { header: "LAST IN", field: "lastInbound" },
      { header: "LAST OUT", field: "lastOutbound" },
      {
        header: "ERROR",
        field: "error",
        color: (value) => (value === "-" ? undefined : "red"),
      },
    ],
    serialize: () => ({ accounts }),
  };
}

export type WeChatStatusResult = ListResult<WeChatStatusRow>;

export async function runWeChatStatusCommand(
  options: CommandOptions,
  _command: Command,
): Promise<WeChatStatusResult> {
  const host = getDaemonHost({ host: typeof options.host === "string" ? options.host : undefined });
  const response = await getDaemonJson<WeChatAccountsResponse>(host, "/api/wechat/accounts");
  const accounts = Array.isArray(response.accounts) ? response.accounts : [];

  return {
    type: "list",
    data: toStatusRows(accounts),
    schema: createStatusSchema(accounts),
  };
}
