import { z } from "zod";
import {
  AgentListItemPayloadSchema,
  AgentSnapshotPayloadSchema,
  AgentTimelineCursorSchema,
} from "@getpaseo/protocol/messages";
import type { AgentTimelineFetchResult } from "../agent-timeline-store-types.js";
import { curateAgentActivity } from "../activity-curator.js";

export const AgentToolDetailSchema = z.enum(["compact", "full"]);
export const CompactAgentStatusSchema = AgentSnapshotPayloadSchema.pick({
  id: true,
  title: true,
  provider: true,
  model: true,
  cwd: true,
  workspaceId: true,
  status: true,
  currentModeId: true,
  activeTurn: true,
  lastUsage: true,
  lastError: true,
  pendingPermissions: true,
  requiresAttention: true,
  attentionReason: true,
  archivedAt: true,
  providerUnavailable: true,
  labels: true,
});

export const CompactAgentListItemSchema = AgentListItemPayloadSchema.pick({
  id: true,
  shortId: true,
  title: true,
  provider: true,
  model: true,
  status: true,
  cwd: true,
  labels: true,
  requiresAttention: true,
  attentionReason: true,
  archivedAt: true,
  providerUnavailable: true,
});

export const AgentActivityPageSchema = z.object({
  startCursor: AgentTimelineCursorSchema.nullable(),
  endCursor: AgentTimelineCursorSchema.nullable(),
  hasOlder: z.boolean(),
  hasNewer: z.boolean(),
});

const MAX_ACTIVITY_PREVIEW_CHARS = 4000;

export function formatAgentActivityPage(input: {
  agentId: string;
  page: AgentTimelineFetchResult;
  detail: z.infer<typeof AgentToolDetailSchema>;
  limit: number;
}) {
  const { agentId, page, detail } = input;
  const body = curateAgentActivity(page.rows.map((row) => row.item));
  const truncated = detail === "compact" && body.length > MAX_ACTIVITY_PREVIEW_CHARS;
  const preview = truncated ? body.slice(-MAX_ACTIVITY_PREVIEW_CHARS) : body;
  const header = `Showing ${page.rows.length} activities from the selected timeline page.`;
  const truncationNotice = truncated
    ? `\nPreview truncated to the last ${MAX_ACTIVITY_PREVIEW_CHARS} characters. Use fullDetailRequest for complete text.`
    : "";
  const startCursor = page.startSeq === null ? null : { epoch: page.epoch, seq: page.startSeq };
  const endCursor = page.endSeq === null ? null : { epoch: page.epoch, seq: page.endSeq };

  return {
    content: `${header}${truncationNotice}\n\n${preview}`,
    truncated,
    page: {
      startCursor,
      endCursor,
      hasOlder: page.hasOlder,
      hasNewer: page.hasNewer,
    },
    ...(truncated && page.startSeq !== null && page.endSeq !== null
      ? {
          fullDetailRequest: {
            agentId,
            direction: page.direction === "after" ? "after" : "before",
            cursor: {
              epoch: page.epoch,
              seq: page.direction === "after" ? page.startSeq - 1 : page.endSeq + 1,
            },
            limit: input.limit,
            detail: "full",
          },
        }
      : {}),
  };
}
