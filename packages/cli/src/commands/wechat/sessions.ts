import type { Command } from "commander";

import type { CommandOptions, ListResult, OutputSchema } from "../../output/index.js";
import { getDaemonHost } from "../../utils/client.js";
import { getDaemonJson } from "./http.js";

interface WeChatSessionItem {
  accountId: string;
  accountUserId?: string | null;
  peerId: string;
  agentId: string;
  agentTitle?: string | null;
  agentStatus?: string | null;
  contextTokenPresent: boolean;
  createdAt: string;
  updatedAt: string;
}

interface WeChatSessionsResponse {
  sessions?: WeChatSessionItem[];
}

interface WeChatSessionRow {
  agentId: string;
  account: string;
  peer: string;
  title: string;
  status: string;
  context: string;
  updatedAt: string;
}

function formatValue(value?: string | null): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "-";
}

function toSessionRows(sessions: WeChatSessionItem[]): WeChatSessionRow[] {
  return sessions.map((session) => ({
    agentId: session.agentId,
    account: session.accountUserId?.trim() || session.accountId,
    peer: session.peerId,
    title: formatValue(session.agentTitle),
    status: formatValue(session.agentStatus),
    context: session.contextTokenPresent ? "yes" : "no",
    updatedAt: formatValue(session.updatedAt),
  }));
}

function createSessionsSchema(sessions: WeChatSessionItem[]): OutputSchema<WeChatSessionRow> {
  return {
    idField: "agentId",
    columns: [
      { header: "AGENT", field: "agentId" },
      { header: "ACCOUNT", field: "account" },
      { header: "PEER", field: "peer" },
      { header: "TITLE", field: "title" },
      {
        header: "STATUS",
        field: "status",
        color: (value) => {
          if (value === "idle") return "green";
          if (value === "running" || value === "initializing") return "yellow";
          if (value === "error") return "red";
          return undefined;
        },
      },
      { header: "CTX", field: "context" },
      { header: "UPDATED", field: "updatedAt" },
    ],
    serialize: () => ({ sessions }),
  };
}

export type WeChatSessionsResult = ListResult<WeChatSessionRow>;

export async function runWeChatSessionsCommand(
  options: CommandOptions,
  _command: Command,
): Promise<WeChatSessionsResult> {
  const host = getDaemonHost({ host: typeof options.host === "string" ? options.host : undefined });
  const response = await getDaemonJson<WeChatSessionsResponse>(host, "/api/wechat/sessions");
  const sessions = Array.isArray(response.sessions) ? response.sessions : [];

  return {
    type: "list",
    data: toSessionRows(sessions),
    schema: createSessionsSchema(sessions),
  };
}
