import { z } from "zod";
import { extractTextFromToolResult } from "../../tool-call-mapper.js";
import type { PiExtension, PiExtensionToolCall, PiExtensionToolMapping } from "../contract.js";

const Args = z
  .object({
    agent: z.string().trim().min(1).optional(),
    task: z.string().trim().min(1).optional(),
    async: z.boolean().optional(),
    action: z.unknown().optional(),
  })
  .passthrough();
const Row = z
  .object({
    index: z.number().int().nonnegative().optional(),
    agent: z.string().trim().min(1),
    exitCode: z.number().optional(),
    success: z.boolean().optional(),
    sessionFile: z.string().trim().min(1).optional(),
  })
  .passthrough();
const Completion = z
  .object({ runId: z.string().trim().min(1), results: z.array(Row) })
  .passthrough();
const Details = z
  .object({
    mode: z.string(),
    runId: z.string().optional(),
    asyncId: z.string().optional(),
    results: z.array(Row),
    completions: z.array(Completion).optional(),
  })
  .passthrough();

export const piSubagents: PiExtension = {
  id: "pi-subagents",
  createSession: () => {
    const callsByRun = new Map<string, string>();
    const readSessions = new Set<string>();
    const collectRows = (
      owner: string,
      rows: z.infer<typeof Row>[],
      description?: string,
      failed = false,
    ) => {
      const subagents: NonNullable<PiExtensionToolMapping["subagents"]> = [];
      const childSessions: NonNullable<PiExtensionToolMapping["childSessions"]> = [];
      for (const [index, row] of rows.entries()) {
        const id = rows.length === 1 ? owner : `${owner}:${row.index ?? index}`;
        subagents.push({
          type: "upsert",
          id,
          title: row.agent,
          description,
          toolCallId: owner,
          status:
            failed || row.success === false || (row.success !== true && row.exitCode !== 0)
              ? "failed"
              : "completed",
        });
        if (row.sessionFile && !readSessions.has(row.sessionFile)) {
          readSessions.add(row.sessionFile);
          childSessions.push({ id, file: row.sessionFile });
        }
      }
      return { subagents, childSessions };
    };
    const mapWait = (call: PiExtensionToolCall) => {
      if (call.status === "running") return undefined;
      const details = Details.safeParse(
        typeof call.result === "object" ? call.result?.details : null,
      );
      if (!details.success || !details.data.completions) return undefined;
      const subagents: NonNullable<PiExtensionToolMapping["subagents"]> = [];
      const childSessions: NonNullable<PiExtensionToolMapping["childSessions"]> = [];
      for (const completion of details.data.completions) {
        const owner = callsByRun.get(completion.runId);
        if (!owner) continue;
        const mapped = collectRows(owner, completion.results);
        subagents.push(...mapped.subagents);
        childSessions.push(...mapped.childSessions);
      }
      return subagents.length ? { subagents, childSessions } : undefined;
    };
    const mapSpawn = (call: PiExtensionToolCall) => {
      const args = Args.safeParse(call.args);
      if (!args.success || args.data.action !== undefined || !args.data.agent || !args.data.task)
        return undefined;
      const detail = {
        type: "sub_agent" as const,
        subAgentType: args.data.agent,
        description: args.data.task,
        log: extractTextFromToolResult(call.result)?.trim() ?? "",
      };
      const base = {
        type: "upsert" as const,
        id: call.callId,
        title: args.data.agent,
        description: args.data.task,
        toolCallId: call.callId,
      };
      if (call.status === "running")
        return { detail, subagents: [{ ...base, status: "running" as const }] };
      const details = Details.safeParse(
        typeof call.result === "object" ? call.result?.details : null,
      );
      if (!details.success || details.data.mode === "management")
        return call.status === "failed"
          ? { detail, subagents: [{ ...base, status: "failed" as const }] }
          : { detail };
      if (details.data.runId) callsByRun.set(details.data.runId, call.callId);
      if (details.data.results.length === 0 && (details.data.asyncId || args.data.async))
        return {
          detail,
          subagents: [
            {
              ...base,
              status: call.status === "failed" ? ("failed" as const) : ("running" as const),
            },
          ],
        };
      if (details.data.results.length === 0 && call.status === "failed")
        return { detail, subagents: [{ ...base, status: "failed" as const }] };
      return {
        detail,
        ...collectRows(call.callId, details.data.results, args.data.task, call.status === "failed"),
      };
    };
    return {
      mapToolCall(call) {
        if (call.toolName === "bg_wait") return mapWait(call);
        if (call.toolName === "subagent") return mapSpawn(call);
        return undefined;
      },
    };
  },
};
