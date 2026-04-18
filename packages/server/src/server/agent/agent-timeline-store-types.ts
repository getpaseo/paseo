import type { AgentTimelineItem } from "./agent-sdk-types.js";

export type AgentTimelineRow = {
  seq: number;
  timestamp: string;
  item: AgentTimelineItem;
};

export type AgentTimelineCursor = {
  epoch: string;
  seq: number;
};

export type AgentTimelineFetchDirection = "tail" | "before" | "after";

export type AgentTimelineFetchOptions = {
  direction?: AgentTimelineFetchDirection;
  cursor?: AgentTimelineCursor;
  /**
   * Number of canonical rows to return.
   * - undefined: store default
   * - 0: all rows in the selected window
   */
  limit?: number;
};

export type AgentTimelineWindow = {
  minSeq: number;
  maxSeq: number;
  nextSeq: number;
};

export type AgentTimelineFetchResult = {
  epoch: string;
  direction: AgentTimelineFetchDirection;
  reset: boolean;
  staleCursor: boolean;
  gap: boolean;
  window: AgentTimelineWindow;
  hasOlder: boolean;
  hasNewer: boolean;
  rows: AgentTimelineRow[];
};

export interface AgentTimelineStore {
  appendCommitted(
    agentId: string,
    item: AgentTimelineItem,
    options?: { timestamp?: string },
  ): Promise<AgentTimelineRow>;
  fetchCommitted(
    agentId: string,
    options?: AgentTimelineFetchOptions,
  ): Promise<AgentTimelineFetchResult>;
  getLatestCommittedSeq(agentId: string): Promise<number>;
  getCommittedRows(agentId: string): Promise<AgentTimelineRow[]>;
  getLastItem(agentId: string): Promise<AgentTimelineItem | null>;
  getLastAssistantMessage(agentId: string): Promise<string | null>;
  hasCommittedUserMessage(
    agentId: string,
    options: { messageId: string; text: string },
  ): Promise<boolean>;
  deleteAgent(agentId: string): Promise<void>;
  bulkInsert(agentId: string, rows: readonly AgentTimelineRow[]): Promise<void>;
}
