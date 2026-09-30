import { z } from "zod";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
    asyncDir: z.string().trim().min(1).optional(),
    results: z.array(Row),
    completions: z.array(Completion).optional(),
  })
  .passthrough();
const AsyncStatus = z
  .object({
    state: z.string(),
    steps: z.array(
      z
        .object({
          agent: z.string().trim().min(1),
          status: z.string().optional(),
          sessionFile: z.string().trim().min(1).optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

function asyncChildStatus(runState: string, stepStatus?: string) {
  if (!["complete", "failed", "stopped"].includes(runState)) return "running";
  if (runState === "stopped" || stepStatus === "stopped") return "canceled";
  if (runState === "failed" || stepStatus === "failed" || stepStatus === "error") return "failed";
  return "completed";
}

export const piSubagents: PiExtension = {
  id: "pi-subagents",
  createSession: () => {
    const callsByRun = new Map<string, string>();
    const readSessions = new Set<string>();
    const asyncRuns = new Map<string, { owner: string; dir: string }>();
    const rememberAsyncRun = (details: z.infer<typeof Details>, call: PiExtensionToolCall) => {
      if (details.runId && details.asyncDir && call.status !== "failed") {
        asyncRuns.set(details.runId, { owner: call.callId, dir: details.asyncDir });
      }
    };
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
      if (details.data.results.length === 0 && (details.data.asyncId || args.data.async)) {
        rememberAsyncRun(details.data, call);
        return {
          detail,
          subagents: [
            {
              ...base,
              status: call.status === "failed" ? ("failed" as const) : ("running" as const),
            },
          ],
        };
      }
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
      poll() {
        const subagents: NonNullable<PiExtensionToolMapping["subagents"]> = [];
        const childSessions: NonNullable<PiExtensionToolMapping["childSessions"]> = [];
        for (const [runId, run] of asyncRuns) {
          let raw: unknown;
          try {
            raw = JSON.parse(readFileSync(join(run.dir, "status.json"), "utf8"));
          } catch {
            continue;
          }
          const parsed = AsyncStatus.safeParse(raw);
          if (!parsed.success) continue;
          const terminal = ["complete", "failed", "stopped"].includes(parsed.data.state);
          for (const [index, step] of parsed.data.steps.entries()) {
            const id = parsed.data.steps.length === 1 ? run.owner : `${run.owner}:${index}`;
            const status = asyncChildStatus(parsed.data.state, step.status);
            subagents.push({ type: "upsert", id, title: step.agent, status });
            if (step.sessionFile && !readSessions.has(step.sessionFile)) {
              readSessions.add(step.sessionFile);
              childSessions.push({ id, file: step.sessionFile });
            }
          }
          if (terminal) {
            if (parsed.data.steps.length === 0) {
              subagents.push({
                type: "upsert",
                id: run.owner,
                status: parsed.data.state === "complete" ? "completed" : "failed",
              });
            }
            asyncRuns.delete(runId);
          }
        }
        return subagents.length || childSessions.length ? { subagents, childSessions } : undefined;
      },
    };
  },
};
