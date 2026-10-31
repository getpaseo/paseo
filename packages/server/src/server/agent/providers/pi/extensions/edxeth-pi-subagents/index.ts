import { z } from "zod";
import type { PiChildSessionFile, PiExtension } from "../contract.js";
import type { ProviderSubagentInputEvent } from "../../../../provider-subagents/store.js";

const Run = z
  .object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1),
    agent: z.string().trim().min(1).optional(),
    task: z.string().optional(),
    status: z.enum(["started", "completed", "failed", "cancelled", "pinged"]),
    sessionFile: z.string().trim().min(1).optional(),
  })
  .passthrough();
const Args = z.object({ task: z.string().optional() }).passthrough();
const Batch = z.object({ status: z.enum(["started", "batch"]), children: z.array(Run).min(1) });
const Completion = z
  .object({
    id: z.string().trim().min(1),
    status: z.enum(["completed", "failed", "cancelled", "pinged"]).optional(),
    error: z.string().optional(),
    sessionFile: z.string().trim().min(1).optional(),
  })
  .passthrough();
const Ping = Completion.extend({ message: z.string() });

function childStatus(status: z.infer<typeof Run>["status"]) {
  if (status === "started") return "running";
  // A ping ends the child process and needs a new resume run. It is not success.
  if (status === "cancelled" || status === "pinged") return "canceled";
  return status;
}

export const edxethPiSubagents: PiExtension = {
  id: "edxeth/pi-subagents",
  createSession: () => {
    const callsByRun = new Map<string, string>();
    const completions = new Map<string, z.infer<typeof Completion>>();
    const readSessions = new Map<string, string>();
    const childSession = (id: string, file: string | undefined): PiChildSessionFile[] => {
      if (!file || readSessions.get(id) === file) return [];
      readSessions.set(id, file);
      return [{ id, file }];
    };
    const completeRun = (result: z.infer<typeof Completion>) => {
      const status = result.status ?? (result.error === undefined ? undefined : "failed");
      if (!status) return undefined;
      // A fast child can finish before the tool returns its run id. Keep the
      // terminal outcome so a later "started" acknowledgement cannot regress it.
      completions.set(result.id, { ...result, status });
      const id = callsByRun.get(result.id);
      if (!id) return undefined;
      const subagents: ProviderSubagentInputEvent[] = [
        {
          type: "upsert",
          id,
          status: childStatus(status),
          ...(status === "pinged" ? { subtitle: "Needs help" } : {}),
        },
      ];
      return { subagents, childSessions: childSession(id, result.sessionFile) };
    };
    return {
      mapToolCall(call) {
        const isLaunch = call.toolName === "subagent" || call.toolName === "subagent_resume";
        if (!isLaunch || call.status === "running") return undefined;
        const details = typeof call.result === "object" ? call.result?.details : null;
        const single = Run.safeParse(details);
        let runs: z.infer<typeof Run>[];
        if (single.success) {
          runs = [single.data];
        } else {
          const batch = Batch.safeParse(details);
          if (!batch.success) return undefined;
          runs = batch.data.children;
        }
        const args = Args.safeParse(call.args);
        const description = args.success ? args.data.task : undefined;
        const subagents: ProviderSubagentInputEvent[] = [];
        const childSessions: PiChildSessionFile[] = [];
        for (const [index, run] of runs.entries()) {
          const id = runs.length === 1 ? call.callId : `${call.callId}:${index}`;
          const completion = completions.get(run.id);
          const status = completion?.status ?? run.status;
          callsByRun.set(run.id, id);
          subagents.push({
            type: "upsert",
            id,
            title: run.agent ?? run.name,
            description: run.task ?? description,
            toolCallId: call.callId,
            status: childStatus(status),
            ...(status === "pinged" ? { subtitle: "Needs help" } : {}),
          });
          childSessions.push(...childSession(id, completion?.sessionFile ?? run.sessionFile));
        }
        return {
          detail: {
            type: "sub_agent",
            description,
            // COMPAT(subagent-log): remove after 2027-04-30.
            log: "",
          },
          subagents,
          childSessions,
        };
      },
      mapCustomMessage(message) {
        if (message.customType === "subagent_ping") {
          const ping = Ping.safeParse(message.details);
          return ping.success ? completeRun({ ...ping.data, status: "pinged" }) : undefined;
        }
        if (message.customType !== "subagent_result") return undefined;
        const parsed = Completion.safeParse(message.details);
        return parsed.success ? completeRun(parsed.data) : undefined;
      },
    };
  },
};
