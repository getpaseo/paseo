import { z } from "zod";
import type { AgentTimelineItem } from "../../../../agent-sdk-types.js";
import { extractTextFromToolResult } from "../../tool-call-mapper.js";
import type { PiExtension, PiExtensionToolCall } from "../contract.js";

const SpawnArgs = z
  .object({
    subagent_type: z.string().trim().min(1),
    prompt: z.string().trim().min(1),
    description: z.string().optional(),
  })
  .passthrough();
const FollowupArgs = z.object({ agent_id: z.string().trim().min(1) }).passthrough();
const Details = z
  .object({
    agentId: z.string().trim().min(1),
    status: z.string(),
    displayName: z.string().optional(),
    description: z.string().optional(),
    transcriptPath: z.string().trim().min(1).optional(),
  })
  .passthrough();
const Notification = z
  .object({
    id: z.string().trim().min(1),
    status: z.string(),
    description: z.string().optional(),
    outputFile: z.string().trim().min(1).optional(),
  })
  .passthrough();
/** Progress a still-running child sent its parent. Carries neither a status nor a transcript path. */
const Update = z
  .object({
    id: z.string().trim().min(1),
    description: z.string().optional(),
    message: z.string(),
  })
  .passthrough();

/**
 * An admitted background run names its transcript in the spawn result text. The spawn result
 * `details` carry display metadata only, so this text is the only place the path appears before the
 * child ends.
 */
const OUTPUT_FILE_PATTERN = /^Output file: (.+)$/m;

const status = (value: string): "running" | "completed" | "failed" | "canceled" => {
  if (value === "completed") return "completed";
  if (value === "error") return "failed";
  if (value === "aborted" || value === "stopped") return "canceled";
  return "running";
};

function spawnOutputFile(call: PiExtensionToolCall): string | undefined {
  return extractTextFromToolResult(call.result)?.match(OUTPUT_FILE_PATTERN)?.[1]?.trim();
}

export const gotgenesPiSubagents: PiExtension = {
  id: "@gotgenes/pi-subagents",
  createSession: () => {
    const callsByAgent = new Map<string, string>();
    const readSessions = new Set<string>();
    /**
     * Hands a transcript file over once, as soon as it is named.
     *
     * Whether the child is still running is not this adapter's question: the follower keeps reading
     * a file that is still growing, and a second handoff of the same path would only duplicate rows.
     */
    const takeChildSession = (
      id: string,
      file: string | undefined,
    ): Array<{ id: string; file: string }> => {
      if (!file || readSessions.has(file)) return [];
      readSessions.add(file);
      return [{ id, file }];
    };
    const mapSpawn = (call: PiExtensionToolCall) => {
      const args = SpawnArgs.safeParse(call.args);
      if (!args.success) return undefined;
      const details = Details.safeParse(
        typeof call.result === "object" ? call.result?.details : null,
      );
      const title = args.data.subagent_type;
      const description = args.data.description ?? args.data.prompt;
      const detail = {
        type: "sub_agent" as const,
        subAgentType: title,
        description,
        log: extractTextFromToolResult(call.result)?.trim() ?? "",
      };
      const childSessions = takeChildSession(call.callId, spawnOutputFile(call));
      if (call.status === "running")
        return {
          detail,
          subagents: [
            {
              type: "upsert" as const,
              id: call.callId,
              title,
              description,
              toolCallId: call.callId,
              status: "running" as const,
            },
          ],
          childSessions,
        };
      if (!details.success)
        return call.status === "failed"
          ? {
              detail,
              subagents: [{ type: "upsert" as const, id: call.callId, status: "failed" as const }],
            }
          : { detail };
      callsByAgent.set(details.data.agentId, call.callId);
      return {
        detail,
        subagents: [
          {
            type: "upsert" as const,
            id: call.callId,
            title,
            description,
            toolCallId: call.callId,
            status: status(details.data.status),
          },
        ],
        childSessions,
      };
    };
    const mapFollowup = (call: PiExtensionToolCall) => {
      const args = FollowupArgs.safeParse(call.args);
      if (!args.success) return undefined;
      const id = callsByAgent.get(args.data.agent_id);
      if (!id) return undefined;
      const details = Details.safeParse(
        typeof call.result === "object" ? call.result?.details : null,
      );
      const detail = {
        type: "sub_agent" as const,
        description: details.success ? details.data.description : undefined,
        log: extractTextFromToolResult(call.result)?.trim() ?? "",
      };
      if (call.status === "running" || !details.success) return { detail };
      return {
        detail,
        subagents: [{ type: "upsert" as const, id, status: status(details.data.status) }],
        // `get_subagent_result` reports the transcript for a running child too, which is what lets a
        // parent that polls its children get a live pane.
        childSessions: takeChildSession(id, details.data.transcriptPath),
      };
    };
    return {
      mapToolCall(call) {
        // This fork's result details resemble tintinweb's, but its spawn tool is `subagent` and its
        // follow-up result shape differs. Keep each parser at its own package boundary.
        if (call.toolName === "subagent") return mapSpawn(call);
        if (call.toolName === "get_subagent_result" || call.toolName === "steer_subagent")
          return mapFollowup(call);
        return undefined;
      },
      mapCustomMessage(message) {
        if (message.customType === "subagent-update") {
          const update = Update.safeParse(message.details);
          if (!update.success) return undefined;
          const id = callsByAgent.get(update.data.id);
          if (!id) return undefined;
          const timeline: AgentTimelineItem[] = [
            { type: "notification", level: "info", message: update.data.message },
          ];
          return {
            subagents: [{ type: "upsert", id, description: update.data.description }],
            timeline,
          };
        }
        if (message.customType !== "subagent-notification") return undefined;
        const details = Notification.safeParse(message.details);
        if (!details.success) return undefined;
        const id = callsByAgent.get(details.data.id);
        if (!id) return undefined;
        return {
          subagents: [
            {
              type: "upsert",
              id,
              description: details.data.description,
              status: status(details.data.status),
            },
          ],
          childSessions: takeChildSession(id, details.data.outputFile),
        };
      },
    };
  },
};
