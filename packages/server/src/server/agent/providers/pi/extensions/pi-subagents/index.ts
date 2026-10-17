import { z } from "zod";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractTextFromToolResult } from "../../tool-call-mapper.js";
import type { PiAgentMessage } from "../../rpc-types.js";
import type { ProviderSubagentInputEvent } from "../../../../provider-subagents/store.js";
import type { PiExtension, PiExtensionToolCall, PiExtensionToolMapping } from "../contract.js";

type CustomMessage = Extract<PiAgentMessage, { role: "custom" }>;
type SubagentUpsert = Extract<ProviderSubagentInputEvent, { type: "upsert" }>;

const Args = z
  .object({
    agent: z.string().trim().min(1).optional(),
    task: z.string().trim().min(1).optional(),
    workflow: z.union([z.string().trim().min(1), z.literal(true)]).optional(),
    // `subagent({ workflow: true })` launches the reply's script; Pi delivers it as this field.
    workflowScript: z.string().trim().min(1).optional(),
    async: z.boolean().optional(),
    action: z.unknown().optional(),
  })
  .passthrough();
const Row = z
  .object({
    index: z.number().int().nonnegative().optional(),
    agent: z.string().trim().min(1),
    workflowKey: z.string().trim().min(1).optional(),
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
          workflowKey: z.string().trim().min(1).optional(),
          status: z.string().optional(),
          sessionFile: z.string().trim().min(1).optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

/**
 * Run states that will not change again: `paused` waits on the user, and `partial`/`rejected`
 * still end the run even when some steps never produced a result of their own.
 */
const TERMINAL_RUN_STATES = new Set([
  "complete",
  "failed",
  "stopped",
  "paused",
  "partial",
  "rejected",
]);
/** The run's status file, or undefined while it is missing or not yet readable. */
function readAsyncStatus(dir: string): z.infer<typeof AsyncStatus> | undefined {
  try {
    const parsed = AsyncStatus.safeParse(
      JSON.parse(readFileSync(join(dir, "status.json"), "utf8")),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** One async run the poll follows, keyed by its async directory. */
interface AsyncRun {
  owner: string;
  polling: boolean;
  misses: number;
  deadline: number;
  rows: Set<string>;
}

/**
 * Missing ticks before a status directory counts as gone: 60 s at the 250 ms follow cadence. A live
 * run can briefly lose its file while the concurrency queue starts it or retention rotates it.
 */
const POLL_MISS_LIMIT = 240;
/**
 * A run that never reaches a terminal state in its status file must not keep a card spinning
 * forever. pi-subagents' own default run timeout is 30 minutes; this is the backstop.
 */
const POLL_TTL_MS = 6 * 60 * 60 * 1000;

function asyncChildStatus(runState: string, stepStatus?: string) {
  if (!TERMINAL_RUN_STATES.has(runState)) return "running";
  // A partial or rejected run says nothing about its individual children: read their own outcome,
  // and treat a step that never reached one as canceled rather than still running.
  if (runState === "partial" || runState === "rejected") {
    // Two vocabularies: status.json steps say `complete`, WorkflowNodeStatus says `completed`.
    if (stepStatus === "complete" || stepStatus === "completed") return "completed";
    if (stepStatus === "failed" || stepStatus === "error") return "failed";
    return "canceled";
  }
  if (runState === "stopped" || runState === "paused" || stepStatus === "stopped")
    return "canceled";
  if (runState === "failed" || stepStatus === "failed" || stepStatus === "error") return "failed";
  return "completed";
}

/** The status of the run itself, used for the row a launch opened before its children reported. */
function asyncRunStatus(runState: string) {
  if (runState === "complete") return "completed" as const;
  if (runState === "failed") return "failed" as const;
  return "canceled" as const;
}

/**
 * The `subagent-notify` / `subagent-incremental-child-notify` header. A grouped notice reports
 * every run as completed; a paused run is waiting on the user, which the track shows as canceled.
 */
function noticeStatus(header: string) {
  if (/^Background tasks completed \(\d+\):/.test(header)) return "completed";
  const outcome = header.match(
    /^(?:Background task|Detached foreground task|Workflow child) (completed|failed|paused|stopped)(?: \([^)]*\))?: \*\*/,
  )?.[1];
  if (!outcome) return undefined;
  return outcome === "paused" || outcome === "stopped"
    ? ("canceled" as const)
    : (outcome as "completed" | "failed");
}

/**
 * A workflow launch carries no `agent`/`task`: the children are declared by the script. Its label
 * is the script file name, or the bare `workflow` of the reply-block form.
 */
function workflowLabel(workflow: string | true | undefined) {
  if (workflow === undefined) return undefined;
  if (workflow === true) return "workflow";
  const segments = workflow.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? workflow;
}

/**
 * A workflow launch carries no agent/task; its children are declared by the script. A reply-scoped
 * script arrives as `workflowScript` instead of a `workflow` path, so it takes the generic label.
 */
function workflowTitle(args: { workflow?: string | true; workflowScript?: string }) {
  const label = workflowLabel(args.workflow);
  if (label !== undefined) return label;
  return args.workflowScript === undefined ? undefined : "workflow";
}

/**
 * A row keeps one id from launch to settle: the owner alone for a single unnamed child, otherwise
 * `owner:key`. Workflow children carry their `workflowKey`, so progress updates, child notices and
 * final results all land on the same row.
 */
function rowId(owner: string, count: number, key: string | undefined, index: number) {
  return count === 1 && !key ? owner : `${owner}:${key ?? index}`;
}

export const piSubagents: PiExtension = {
  id: "pi-subagents",
  createSession: () => {
    const callsByRun = new Map<string, string>();
    const readSessions = new Set<string>();
    /** Rows already reported terminal; a late give-up must not rewrite one of them. */
    const settledRows = new Set<string>();
    /** Rows whose poll already reported the step's agent. A settled row is still named once. */
    const namedRows = new Set<string>();
    const recordTerminal = (id: string, status: string) => {
      if (status !== "running") settledRows.add(id);
    };
    /** Keyed by async directory, which both status.json and the completion notice carry. */
    const asyncRuns = new Map<string, AsyncRun>();
    const rememberAsyncRun = (details: z.infer<typeof Details>, call: PiExtensionToolCall) => {
      if (details.asyncDir && call.status !== "failed") {
        asyncRuns.set(details.asyncDir, {
          owner: call.callId,
          polling: true,
          misses: 0,
          deadline: Date.now() + POLL_TTL_MS,
          rows: new Set<string>(),
        });
      }
    };
    /**
     * The run is over and nothing will ever update its rows again, so settle them rather than leave a
     * spinner. A row that already reported a terminal status keeps it: this is not its verdict.
     */
    const giveUpRun = (run: AsyncRun) => {
      run.polling = false;
      const subagents: NonNullable<PiExtensionToolMapping["subagents"]> = [];
      for (const id of new Set([run.owner, ...run.rows])) {
        if (settledRows.has(id)) continue;
        subagents.push({ type: "upsert", id, status: "canceled", liveness: "poll" });
      }
      return subagents;
    };
    /**
     * The notice is the run's last word: it ends the poll, settles the launch row, and cancels the
     * children the run stopped with. No later tick will report those, and nothing here proves they
     * succeeded, so they settle as canceled. A child that already reported its own verdict keeps it.
     */
    const settleRunNotice = (run: AsyncRun, status: "completed" | "failed" | "canceled") => {
      // A stale status.json must not revert this card either.
      run.polling = false;
      recordTerminal(run.owner, status);
      const subagents: NonNullable<PiExtensionToolMapping["subagents"]> = [
        { type: "upsert", id: run.owner, status },
      ];
      for (const id of run.rows) {
        if (settledRows.has(id)) continue;
        subagents.push({ type: "upsert", id, status: "canceled" });
      }
      return subagents;
    };
    /**
     * A row id can settle twice: a completion notice records a verdict in `settledRows`, and a
     * `subagent_wait` result repeats the run's rows with the run's own verdict. Both are terminal, so
     * a disagreement moves a row terminal-to-terminal (completed → failed) and never resurrects it;
     * the owner row is what carries the run outcome.
     */
    // ponytail: child verdicts can diverge between notice and bg_wait result — unify when one source of truth exists
    const collectRows = (
      owner: string,
      rows: z.infer<typeof Row>[],
      description?: string,
      failed = false,
    ) => {
      const subagents: NonNullable<PiExtensionToolMapping["subagents"]> = [];
      const childSessions: NonNullable<PiExtensionToolMapping["childSessions"]> = [];
      for (const [index, row] of rows.entries()) {
        const id = rowId(owner, rows.length, row.workflowKey, row.index ?? index);
        const status =
          failed || row.success === false || (row.success !== true && row.exitCode !== 0)
            ? ("failed" as const)
            : ("completed" as const);
        recordTerminal(id, status);
        subagents.push({
          type: "upsert",
          id,
          title: row.agent,
          description,
          toolCallId: owner,
          status,
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
    /** A settled spawn: Pi either reports the rows it ran, or an async directory the poll follows. */
    const mapSettledSpawn = (
      call: PiExtensionToolCall,
      base: SubagentUpsert,
      description: string | undefined,
      asyncRequested: boolean,
    ): Pick<PiExtensionToolMapping, "subagents" | "childSessions"> => {
      const failed = call.status === "failed";
      const details = Details.safeParse(
        typeof call.result === "object" ? call.result?.details : null,
      );
      if (!details.success || details.data.mode === "management") {
        if (!failed) return { subagents: [] };
        recordTerminal(call.callId, "failed");
        return { subagents: [{ ...base, status: "failed" as const }] };
      }
      if (details.data.runId) callsByRun.set(details.data.runId, call.callId);
      if (details.data.results.length === 0) {
        if (failed) {
          recordTerminal(call.callId, "failed");
          return { subagents: [{ ...base, status: "failed" as const }] };
        }
        if (!details.data.asyncId && !asyncRequested) {
          // ponytail: inferred completion — revisit if pi can return success while a child outlives the call.
          recordTerminal(call.callId, "completed");
          return { subagents: [{ ...base, status: "completed" as const }] };
        }
        // The placeholder row is now backed by a per-tick poll, which is what proves it alive.
        rememberAsyncRun(details.data, call);
        return { subagents: [{ ...base, status: "running" as const, liveness: "poll" as const }] };
      }
      const collected = collectRows(call.callId, details.data.results, description, failed);
      // A run that reported rows of its own never keeps the placeholder card it opened at launch.
      if (!collected.subagents.some((event) => event.id === call.callId)) {
        collected.subagents.unshift({ type: "remove", id: call.callId });
      }
      return collected;
    };
    const mapSpawn = (call: PiExtensionToolCall) => {
      const args = Args.safeParse(call.args);
      if (!args.success || args.data.action !== undefined) return undefined;
      const single = Boolean(args.data.agent && args.data.task);
      let workflow: string | undefined;
      if (!single) workflow = workflowTitle(args.data);
      if (!single && workflow === undefined) return undefined;
      const base = {
        type: "upsert" as const,
        id: call.callId,
        title: (single ? args.data.agent : workflow) ?? "workflow",
        description: args.data.task,
        toolCallId: call.callId,
      };
      const detail = {
        type: "sub_agent" as const,
        subAgentType: base.title,
        description: args.data.task,
        log: extractTextFromToolResult(call.result)?.trim() ?? "",
      };
      // The in-flight placeholder is poll-marked: a turn interrupted before this call reports
      // never delivers a terminal mapping, and only a marked row can be settled by the sweep.
      // ponytail: replay re-emits running before the settled rows land — one-pass client flip, upgrade when replay maps calls with their results first
      if (call.status === "running")
        return {
          detail,
          subagents: [{ ...base, status: "running" as const, liveness: "poll" as const }],
        };
      return {
        detail,
        ...mapSettledSpawn(call, base, args.data.task, Boolean(args.data.async)),
      };
    };
    const noticeText = (message: CustomMessage) =>
      typeof message.content === "string"
        ? message.content
        : extractTextFromToolResult({ content: message.content });
    const mapWorkflowChildNotice = (message: CustomMessage) => {
      const lines = noticeText(message)?.split("\n") ?? [];
      const status = noticeStatus(lines[0] ?? "");
      const key = lines[0]?.match(
        /^Workflow child (?:completed|failed|paused|stopped)(?: \([^)]*\))?: \*\*(.+?)\*\*/,
      )?.[1];
      const runId = lines.find((line) => line.startsWith("Workflow run: "))?.slice(14);
      const owner = runId ? callsByRun.get(runId) : undefined;
      if (!status || !key || !owner) return undefined;
      const id = `${owner}:${key}`;
      recordTerminal(id, status);
      return { subagents: [{ type: "upsert" as const, id, status }] };
    };
    return {
      mapToolCall(call) {
        if (call.toolName === "bg_wait") return mapWait(call);
        if (call.toolName === "subagent") return mapSpawn(call);
        return undefined;
      },
      mapCustomMessage(message) {
        if (message.customType === "subagent-incremental-child-notify")
          return mapWorkflowChildNotice(message);
        if (message.customType !== "subagent-notify") return undefined;
        const lines = noticeText(message)?.split("\n") ?? [];
        const status = noticeStatus(lines[0] ?? "");
        if (!status) return undefined;
        const subagents: NonNullable<PiExtensionToolMapping["subagents"]> = [];
        const childSessions: NonNullable<PiExtensionToolMapping["childSessions"]> = [];
        // Each run's session line follows its async directory line; earlier lines are child output.
        let owner: string | undefined;
        for (const line of lines) {
          const dir = line.match(/^Retention-managed async directory: (.+)$/)?.[1];
          if (dir) {
            const run = asyncRuns.get(dir);
            owner = run?.owner;
            if (!run || !owner) continue;
            subagents.push(...settleRunNotice(run, status));
            continue;
          }
          const file = owner ? line.match(/^Session file: (.+)$/)?.[1] : undefined;
          if (!owner || !file) continue;
          if (!readSessions.has(file)) {
            readSessions.add(file);
            childSessions.push({ id: owner, file });
          }
          owner = undefined;
        }
        return subagents.length ? { subagents, childSessions } : undefined;
      },
      poll() {
        const subagents: NonNullable<PiExtensionToolMapping["subagents"]> = [];
        const childSessions: NonNullable<PiExtensionToolMapping["childSessions"]> = [];
        const now = Date.now();
        for (const [dir, run] of asyncRuns) {
          if (!run.polling) continue;
          if (now >= run.deadline) {
            subagents.push(...giveUpRun(run));
            continue;
          }
          const status = readAsyncStatus(dir);
          if (!status) {
            run.misses += 1;
            if (run.misses >= POLL_MISS_LIMIT) {
              subagents.push(...giveUpRun(run));
              continue;
            }
            // The run is still alive even though its file is gone for now. Keep re-reporting its
            // unsettled rows: silence would freeze their timestamp and a turn end would cancel a
            // live run inside the miss budget.
            for (const id of new Set([run.owner, ...run.rows])) {
              if (settledRows.has(id)) continue;
              subagents.push({
                type: "upsert",
                id,
                status: "running" as const,
                liveness: "poll" as const,
              });
            }
            continue;
          }
          run.misses = 0;
          const runTerminal = TERMINAL_RUN_STATES.has(status.state);
          for (const [index, step] of status.steps.entries()) {
            const id = rowId(run.owner, status.steps.length, step.workflowKey, index);
            run.rows.add(id);
            // A child notice is this child's verdict, so a settled row gets no further status write
            // from the poll. While the run is going, a stale step entry must not revert it to
            // running; on the terminal tick, the run's own outcome must not overwrite it.
            if (!settledRows.has(id)) {
              const childStatus = asyncChildStatus(status.state, step.status);
              recordTerminal(id, childStatus);
              namedRows.add(id);
              subagents.push({
                type: "upsert",
                id,
                title: step.agent,
                status: childStatus,
                liveness: "poll" as const,
              });
            } else if (!namedRows.has(id)) {
              // A child notice can settle a row before any poll saw it, and that notice carries no
              // agent name. Omit `status`: the store keeps the settled verdict and only takes the
              // title the run's status file names.
              namedRows.add(id);
              subagents.push({ type: "upsert", id, title: step.agent, liveness: "poll" as const });
            }
            if (step.sessionFile && !readSessions.has(step.sessionFile)) {
              readSessions.add(step.sessionFile);
              childSessions.push({ id, file: step.sessionFile });
            }
          }
          if (runTerminal) run.polling = false;
          // The launch row stands for the whole run, and a single unnamed child already took its
          // id. Re-reporting it every tick is also what proves to the manager that this run is alive.
          // A row that already settled keeps that verdict: a result that landed before the run's
          // steps named its children must not be reverted to running by the next tick.
          if (!run.rows.has(run.owner) && !settledRows.has(run.owner)) {
            const ownerStatus = run.polling ? ("running" as const) : asyncRunStatus(status.state);
            recordTerminal(run.owner, ownerStatus);
            subagents.push({
              type: "upsert",
              id: run.owner,
              status: ownerStatus,
              liveness: "poll",
            });
          }
        }
        return subagents.length || childSessions.length ? { subagents, childSessions } : undefined;
      },
    };
  },
};
