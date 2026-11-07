import { z } from "zod";
import type {
  ProviderSubagentInputEvent,
  ProviderSubagentStatus,
} from "../../../../provider-subagents/store.js";
import type { PiExtension } from "../contract.js";

const Count = z.number().int().nonnegative();
// Thread sessions can span several workflow calls. Show the producer's bounded
// previews instead of attributing the entire shared session file to one child.
const Agent = z.object({
  id: Count,
  label: z.string(),
  status: z.enum(["queued", "running", "done", "error", "skipped"]),
  phase: z.string().optional(),
  model: z.string().optional(),
  tokens: z.number().nonnegative().optional(),
  estimatedTokens: z.boolean().optional(),
  promptPreview: z.string().optional(),
  resultPreview: z.string().optional(),
  error: z.string().optional(),
});
const Progress = z.object({
  version: z.literal(1),
  runId: z.string().min(1),
  name: z.string(),
  status: z.enum(["running", "paused", "completed", "failed", "aborted"]),
  cwd: z.string(),
  currentPhase: z.string().optional(),
  agentCount: Count,
  runningCount: Count,
  doneCount: Count,
  errorCount: Count,
  tokens: z.number().nonnegative().optional(),
  estimatedTokens: z.boolean().optional(),
  cost: z.number().nonnegative().optional(),
  resultPreview: z.string().optional(),
  error: z.string().optional(),
  agentIds: z.array(Count),
  agents: z.array(Agent),
});
const Deleted = z.object({
  version: z.literal(1),
  runId: z.string().min(1),
  deleted: z.literal(true),
});

type WorkflowAgent = z.infer<typeof Agent>;
type WorkflowProgress = z.infer<typeof Progress>;
type Descriptor = Extract<ProviderSubagentInputEvent, { type: "upsert" }>;

type Previews = Pick<WorkflowAgent, "promptPreview" | "resultPreview" | "error">;

const TOKEN_FORMAT = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

const RUN_STATUS: Record<WorkflowProgress["status"], ProviderSubagentStatus> = {
  running: "running",
  paused: "canceled",
  completed: "completed",
  failed: "failed",
  aborted: "canceled",
};
const AGENT_STATUS: Record<WorkflowAgent["status"], ProviderSubagentStatus> = {
  queued: "running",
  running: "running",
  done: "completed",
  error: "failed",
  skipped: "canceled",
};

function tokenSummary(
  usage: Pick<WorkflowProgress, "tokens" | "estimatedTokens">,
): string | undefined {
  if (usage.tokens === undefined) return undefined;
  const value = TOKEN_FORMAT.format(usage.tokens);
  return `${usage.estimatedTokens ? "~" : ""}${value} tok`;
}

function runSubtitle(progress: WorkflowProgress): string {
  const parts = [progress.status === "paused" ? "Paused" : undefined, progress.currentPhase];
  parts.push(`${progress.doneCount}/${progress.agentCount} completed`);
  if (progress.runningCount > 0 && progress.status === "running")
    parts.push(`${progress.runningCount} running`);
  if (progress.errorCount > 0) parts.push(`${progress.errorCount} failed`);
  parts.push(tokenSummary(progress));
  if (progress.cost !== undefined) parts.push(`$${progress.cost.toFixed(4)}`);
  return parts.filter(Boolean).join(" · ");
}

function agentStatus(
  agent: WorkflowAgent,
  runStatus: WorkflowProgress["status"],
): ProviderSubagentStatus {
  const unfinished = agent.status === "queued" || agent.status === "running";
  if (unfinished && runStatus !== "running") return "canceled";
  return AGENT_STATUS[agent.status];
}

function agentSubtitle(agent: WorkflowAgent, runStatus: WorkflowProgress["status"]): string | null {
  const unfinished = agent.status === "queued" || agent.status === "running";
  let state: string | undefined;
  if (unfinished && runStatus === "paused") state = "Paused";
  else if (agent.status === "queued" && runStatus === "running") state = "Queued";
  else if (agent.status === "skipped") state = "Skipped";
  const parts = [state, agent.phase, agent.model, tokenSummary(agent)];
  return parts.filter(Boolean).join(" · ") || null;
}

export const piDynamicWorkflows: PiExtension = {
  id: "pi-dynamic-workflows",
  createSession() {
    const runs = new Map<string, Map<number, WorkflowAgent>>();
    const descriptors = new Map<string, string>();
    const previews = new Map<string, Previews>();

    function upsert(
      events: ProviderSubagentInputEvent[],
      descriptor: Descriptor,
      timestamp: string,
    ) {
      const serialized = JSON.stringify(descriptor);
      if (descriptors.get(descriptor.id) === serialized) return;
      descriptors.set(descriptor.id, serialized);
      events.push({ ...descriptor, timestamp });
    }

    function remove(events: ProviderSubagentInputEvent[], id: string) {
      if (descriptors.delete(id)) events.push({ type: "remove", id });
      previews.delete(id);
    }

    function appendPreviews(
      events: ProviderSubagentInputEvent[],
      id: string,
      next: Previews,
      timestamp: string,
    ) {
      const previous = previews.get(id);
      if (next.promptPreview && next.promptPreview !== previous?.promptPreview) {
        events.push({
          type: "timeline",
          id,
          item: { type: "user_message", text: next.promptPreview },
          timestamp,
        });
      }
      if (next.resultPreview && next.resultPreview !== previous?.resultPreview) {
        events.push({
          type: "timeline",
          id,
          item: { type: "assistant_message", text: next.resultPreview },
          timestamp,
        });
      }
      if (next.error && next.error !== previous?.error) {
        events.push({
          type: "timeline",
          id,
          item: { type: "error", message: next.error },
          timestamp,
        });
      }
      previews.set(id, {
        promptPreview: next.promptPreview,
        resultPreview: next.resultPreview,
        error: next.error,
      });
    }

    return {
      resetCustomEntries() {
        runs.clear();
        descriptors.clear();
        previews.clear();
      },
      mapCustomEntry(entry) {
        if (entry.customType !== "pi-dynamic-workflows:progress") return undefined;
        const events: ProviderSubagentInputEvent[] = [];
        const deleted = Deleted.safeParse(entry.data);
        if (deleted.success) {
          const id = `workflow:${deleted.data.runId}`;
          for (const agentId of runs.get(deleted.data.runId)?.keys() ?? [])
            remove(events, `${id}:${agentId}`);
          remove(events, id);
          runs.delete(deleted.data.runId);
          return { subagents: events };
        }
        const parsed = Progress.safeParse(entry.data);
        if (!parsed.success) return undefined;
        const progress = parsed.data;
        const id = `workflow:${progress.runId}`;
        const agents = runs.get(progress.runId) ?? new Map<number, WorkflowAgent>();
        const agentIds = new Set(progress.agentIds);
        for (const agentId of agents.keys()) {
          if (agentIds.has(agentId)) continue;
          agents.delete(agentId);
          remove(events, `${id}:${agentId}`);
        }
        for (const agent of progress.agents) {
          if (agentIds.has(agent.id)) agents.set(agent.id, agent);
        }
        runs.set(progress.runId, agents);
        upsert(
          events,
          {
            type: "upsert",
            id,
            title: progress.name,
            status: RUN_STATUS[progress.status],
            cwd: progress.cwd,
            parentSubagentId: null,
            subtitle: runSubtitle(progress),
          },
          entry.timestamp,
        );
        appendPreviews(events, id, progress, entry.timestamp);
        for (const agent of agents.values()) {
          const childId = `${id}:${agent.id}`;
          upsert(
            events,
            {
              type: "upsert",
              id: childId,
              title: agent.label,
              description: agent.promptPreview,
              status: agentStatus(agent, progress.status),
              cwd: progress.cwd,
              parentSubagentId: id,
              subtitle: agentSubtitle(agent, progress.status),
            },
            entry.timestamp,
          );
          appendPreviews(events, childId, agent, entry.timestamp);
        }
        return { subagents: events };
      },
    };
  },
};
