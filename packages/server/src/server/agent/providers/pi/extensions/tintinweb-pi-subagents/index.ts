import { z } from "zod";
import { extractTextFromToolResult } from "../../tool-call-mapper.js";
import { outputFileFromToolResult } from "../child-session.js";
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
  })
  .passthrough();
const NotificationEntry = z
  .object({
    id: z.string().trim().min(1),
    status: z.string(),
    description: z.string().optional(),
    outputFile: z.string().trim().min(1).optional(),
  })
  .passthrough();
// Completions that land close together arrive as one notification: the first
// agent at the top level and the rest in `others`.
const Notification = NotificationEntry.extend({
  others: z.array(NotificationEntry).optional(),
});
// get_subagent_result returns only text, opening with this header, and cancels the completion
// notification. For a collected child it is the only record of the outcome.
const RESULT_HEADER = /^Agent: (\S+)\nType: .*?\| Status: (\w+)/;
// The `<status>` label of a `<task-notification>`, mapped back to the record status it reports.
const statusFromLabel = (label: string): string => {
  if (label === "Wrapped up (turn limit)") return "steered";
  if (label.startsWith("Error:")) return "error";
  if (label.startsWith("Aborted")) return "aborted";
  if (label === "Stopped") return "stopped";
  return "completed";
};
const unescapeXml = (value: string) =>
  value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const tag = (block: string, name: string) => {
  const value = new RegExp(`^<${name}>(.*)</${name}>$`, "m").exec(block)?.[1];
  return value === undefined ? undefined : unescapeXml(value);
};
interface TaskNotification {
  id: string;
  status: string;
  description?: string;
  toolUseId?: string;
  outputFile?: string;
}
// Each finished agent is one `<task-notification>` block in the message content; a grouped
// notification holds several. The block's `<tool-use-id>` names the spawn or resume call
// whose run finished. `details` never carries that id, and some messages have no `details`.
const parseTaskNotifications = (content: string): TaskNotification[] =>
  [...content.matchAll(/<task-notification>\n([\s\S]*?)\n<\/task-notification>/g)].flatMap(
    ([, block]) => {
      const id = tag(block, "task-id");
      const label = tag(block, "status");
      if (!id || label === undefined) return [];
      return [
        {
          id,
          status: statusFromLabel(label),
          toolUseId: tag(block, "tool-use-id"),
          outputFile: tag(block, "output-file"),
        },
      ];
    },
  );
const status = (value: string): "running" | "completed" | "failed" | "canceled" => {
  // A soft turn-limit wrap-up has finished; it is not an in-flight steering request.
  if (value === "completed" || value === "steered") return "completed";
  if (value === "error") return "failed";
  if (value === "aborted" || value === "stopped") return "canceled";
  return "running";
};

export const tintinwebPiSubagents: PiExtension = {
  id: "@tintinweb/pi-subagents",
  createSession: () => {
    /** A resume is a new call, so this names each agent's latest spawn or resume. */
    const callsByAgent = new Map<string, string>();
    const calls = new Set<string>();
    /** Follow-ups report on the attempt that was latest when they started. */
    const followupTargets = new Map<string, string>();
    const readSessions = new Set<string>();
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
        // COMPAT(subagent-log): remove after 2027-04-30.
        log: "",
      };
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
        };
      if (!details.success)
        return call.status === "failed"
          ? {
              detail,
              subagents: [{ type: "upsert" as const, id: call.callId, status: "failed" as const }],
            }
          : { detail };
      callsByAgent.set(details.data.agentId, call.callId);
      calls.add(call.callId);
      const file = outputFileFromToolResult(call.result);
      const childSessions = file && !readSessions.has(file) ? [{ id: call.callId, file }] : [];
      if (file) readSessions.add(file);
      const childStatus = status(details.data.status);
      // A foreground child has no session file; its answer is the tool result.
      const answer =
        !file && childStatus !== "running" ? extractTextFromToolResult(call.result)?.trim() : "";
      return {
        detail,
        subagents: [
          {
            type: "upsert" as const,
            id: call.callId,
            title,
            description,
            toolCallId: call.callId,
            status: childStatus,
          },
          ...(answer
            ? [
                {
                  type: "timeline" as const,
                  id: call.callId,
                  item: { type: "assistant_message" as const, text: answer },
                },
              ]
            : []),
        ],
        childSessions,
      };
    };
    const mapFollowup = (call: PiExtensionToolCall) => {
      const args = FollowupArgs.safeParse(call.args);
      if (!args.success) return undefined;
      const details = Details.safeParse(
        typeof call.result === "object" ? call.result?.details : null,
      );
      const text = extractTextFromToolResult(call.result)?.trim() ?? "";
      const header = call.toolName === "get_subagent_result" ? RESULT_HEADER.exec(text) : null;
      if (call.status === "running" && !followupTargets.has(call.callId)) {
        const target = callsByAgent.get(args.data.agent_id);
        if (target) followupTargets.set(call.callId, target);
      }
      // `agent_id` may be a handle such as the agent's name; the header names the real id.
      const id =
        followupTargets.get(call.callId) ?? callsByAgent.get(header?.[1] ?? args.data.agent_id);
      if (call.status !== "running") followupTargets.delete(call.callId);
      if (!id) return undefined;
      const detail = {
        type: "sub_agent" as const,
        description: details.success ? details.data.description : undefined,
        // COMPAT(subagent-log): remove after 2027-04-30.
        log: "",
      };
      const reported = details.success ? details.data.status : header?.[2];
      if (call.status === "running" || !reported) return { detail };
      return {
        detail,
        subagents: [{ type: "upsert" as const, id, status: status(reported) }],
      };
    };
    return {
      mapToolCall(call) {
        if (call.toolName === "Agent") return mapSpawn(call);
        if (call.toolName === "get_subagent_result" || call.toolName === "steer_subagent")
          return mapFollowup(call);
        return undefined;
      },
      mapCustomMessage(message) {
        if (
          message.customType !== "subagent-notification" &&
          message.customType !== "subagent-update"
        )
          return undefined;
        const content =
          typeof message.content === "string"
            ? message.content
            : (extractTextFromToolResult({ content: message.content }) ?? "");
        const blocks = parseTaskNotifications(content);
        const details = Notification.safeParse(message.details);
        const entries = details.success ? [details.data, ...(details.data.others ?? [])] : blocks;
        const subagents = [];
        const childSessions = [];
        for (const entry of entries) {
          // A result built before a resume must not finish the resumed run.
          const toolUseId = blocks.find((block) => block.id === entry.id)?.toolUseId;
          const id = toolUseId && calls.has(toolUseId) ? toolUseId : callsByAgent.get(entry.id);
          if (!id) continue;
          const file = entry.outputFile;
          if (file && !readSessions.has(file)) {
            readSessions.add(file);
            childSessions.push({ id, file });
          }
          subagents.push({
            type: "upsert" as const,
            id,
            description: entry.description,
            status: status(entry.status),
          });
        }
        if (subagents.length === 0) return undefined;
        return { subagents, childSessions };
      },
    };
  },
};
