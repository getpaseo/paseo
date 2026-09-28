import { readFileSync } from "node:fs";
import { join } from "node:path";
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
    asyncDir: z.string().trim().min(1).optional(),
    results: z.array(Row),
    completions: z.array(Completion).optional(),
  })
  .passthrough();
/**
 * The child state this plugin keeps on disk for a detached run.
 *
 * `asyncDir/status.json` is rewritten as the run progresses, and it is the only place a running
 * child's transcript path appears: the spawn result carries the directory, not the file, and the
 * result rows that name files only arrive once the parent collects the run.
 */
const AsyncStep = z
  .object({
    index: z.number().int().nonnegative().optional(),
    agent: z.string().trim().min(1).optional(),
    status: z.string().optional(),
    sessionFile: z.string().trim().min(1).optional(),
    transcriptPath: z.string().trim().min(1).optional(),
  })
  .passthrough();
const AsyncSummary = z
  .object({ state: z.string(), steps: z.array(AsyncStep).optional() })
  .passthrough();

const status = (value: string): "running" | "completed" | "failed" | "canceled" => {
  if (value === "complete") return "completed";
  if (value === "failed" || value === "rejected") return "failed";
  if (value === "stopped") return "canceled";
  // `queued`, `running`, and the paused and partial states all still have work coming.
  return "running";
};

function readAsyncSummary(asyncDir: string): z.infer<typeof AsyncSummary> | undefined {
  try {
    const parsed = AsyncSummary.safeParse(
      JSON.parse(readFileSync(join(asyncDir, "status.json"), "utf8")),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    // The plugin rewrites the file through a coalescer, so a torn read is expected and retried.
    return undefined;
  }
}

export const piSubagents: PiExtension = {
  id: "pi-subagents",
  createSession: () => {
    const callsByRun = new Map<string, string>();
    /** Detached runs whose transcript path has to be read from the run directory. */
    const asyncDirs = new Map<string, string>();
    const readSessions = new Set<string>();
    /** Hands a transcript file over once. The follower owns every read after that. */
    const takeChildSession = (
      id: string,
      file: string | undefined,
    ): Array<{ id: string; file: string }> => {
      if (!file || readSessions.has(file)) return [];
      readSessions.add(file);
      return [{ id, file }];
    };
    /** Remembers what a spawn result said about where the run's live state lives. */
    const rememberRun = (
      runId: string | undefined,
      owner: string,
      asyncDir: string | undefined,
    ): void => {
      if (runId) callsByRun.set(runId, owner);
      if (asyncDir) asyncDirs.set(owner, asyncDir);
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
        childSessions.push(...takeChildSession(id, row.sessionFile));
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
      rememberRun(details.data.runId, call.callId, details.data.asyncDir);
      if (details.data.results.length === 0 && (details.data.asyncId || args.data.async)) {
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
        if (asyncDirs.size === 0) return undefined;
        const subagents: NonNullable<PiExtensionToolMapping["subagents"]> = [];
        const childSessions: NonNullable<PiExtensionToolMapping["childSessions"]> = [];
        const settled: string[] = [];
        for (const [owner, asyncDir] of asyncDirs) {
          const summary = readAsyncSummary(asyncDir);
          if (!summary) continue;
          const state = status(summary.state);
          const steps = summary.steps ?? [];
          subagents.push({ type: "upsert", id: owner, status: state });
          const single = steps.length === 1 ? steps[0] : undefined;
          if (single) {
            childSessions.push(
              ...takeChildSession(owner, single.sessionFile ?? single.transcriptPath),
            );
          } else {
            for (const [index, step] of steps.entries()) {
              const id = `${owner}:${step.index ?? index}`;
              subagents.push({
                type: "upsert",
                id,
                status: status(step.status ?? summary.state),
                ...(step.agent ? { title: step.agent } : {}),
              });
              childSessions.push(...takeChildSession(id, step.sessionFile ?? step.transcriptPath));
            }
          }
          if (state !== "running") settled.push(owner);
        }
        for (const owner of settled) asyncDirs.delete(owner);
        return subagents.length ? { subagents, childSessions } : undefined;
      },
    };
  },
};
