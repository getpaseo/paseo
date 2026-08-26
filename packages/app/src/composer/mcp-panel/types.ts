import type { AgentMcpServer, AgentMcpSource } from "@getpaseo/protocol/agent-types";

export type { AgentMcpSource };

export interface AgentMcpReport {
  servers: AgentMcpServer[];
  source: AgentMcpSource;
}

export type AgentMcpServersView =
  | { kind: "unsupported" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | {
      kind: "ready";
      servers: AgentMcpServer[];
      source: AgentMcpSource;
      isRefreshing: boolean;
    };
