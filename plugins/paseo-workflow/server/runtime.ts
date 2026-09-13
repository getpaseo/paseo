import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginSettingsHandle, PluginBeforeRequests } from "@getpaseo/plugin/server";
import { profileId, roles } from "../shared/profiles";
import { WorkflowController, type WorkflowPort } from "./workflow";
import { workflowSettings } from "./state";

const execute = promisify(execFile);
async function git(cwd: string, args: string[]): Promise<string> {
  return (await execute("git", args, { cwd, maxBuffer: 8 * 1024 * 1024, timeout: 30_000 })).stdout;
}

export function runtime(
  paseo: PaseoApi,
  settings: PluginSettingsHandle<typeof workflowSettings.schema>,
) {
  let revision: string | undefined;
  const history = async (id: string) => {
    const agent = paseo.agents.ref(id);
    let page = await agent.timeline.refetch({ limit: 200, projection: "canonical" });
    const pages = [];
    for (;;) {
      if (page.error || page.staleCursor || page.gap)
        throw new Error("The original history is incomplete. Reopen the agent and retry.");
      pages.push(page.entries);
      if (!page.hasOlder || !page.startCursor) break;
      page = await agent.timeline.refetch({
        direction: "before",
        cursor: page.startCursor,
        limit: 200,
        projection: "canonical",
      });
    }
    return pages.toReversed().flat();
  };
  const completedTurnId = async (id: string) => {
    const snapshot = (await paseo.agents.ref(id).refresh())?.agent;
    if (
      (snapshot?.status !== "idle" && snapshot?.status !== "closed") ||
      snapshot.activeTurn ||
      snapshot.lastError ||
      snapshot.pendingPermissions.length
    )
      return undefined;
    return snapshot.lastCompletedTurnId;
  };
  const unconfirmedPlan = (entries: Awaited<ReturnType<typeof history>>, callId: string) => {
    const latest = entries.findLast(
      ({ item }) =>
        item.type === "tool_call" && item.callId === callId && item.metadata?.syntheticPermissionId,
    );
    return (
      latest?.item.type === "tool_call" && latest.item.metadata?.approvalOutcome !== "completed"
    );
  };
  const port: WorkflowPort = {
    profiles: async () => (await paseo.config.get()).config.agentProfiles ?? [],
    agent: async (id) => {
      const handle = paseo.agents.ref(id);
      const snapshot = await handle.refresh();
      if (!snapshot) throw new Error(`Agent '${id}' is unavailable. Reconnect to its host.`);
      return {
        id,
        workspaceId: snapshot.agent.workspaceId ?? undefined,
        launchProfileId: snapshot.agent.launchProfileId,
        labels: snapshot.agent.labels,
        pendingPermissions: snapshot.agent.pendingPermissions,
      };
    },
    workspace: async (id) => {
      const handle = paseo.workspaces.ref(id);
      const snapshot = await handle.refresh();
      if (!snapshot?.workspaceDirectory) throw new Error(`Workspace '${id}' is unavailable.`);
      return { cwd: snapshot.workspaceDirectory, intent: snapshot.intent };
    },
    timeline: async (id) => (await history(id)).map((entry) => entry.item),
    turn: async (id, turnId, expectedMessageId, approvedPlanCallId, afterMessageId) => {
      turnId ??= await completedTurnId(id);
      if (!turnId) return null;
      const entries = await history(id);
      const end = entries.findLastIndex((entry) => entry.turnId === turnId);
      const promptIndex = entries.findLastIndex(
        (entry, index) => index <= end && entry.item.type === "user_message",
      );
      if (promptIndex < 0) return null;
      if (afterMessageId) {
        const source = entries.findIndex(
          ({ item }) => item.type === "user_message" && item.clientMessageId === afterMessageId,
        );
        if (source < 0 || source > promptIndex) return null;
      }
      // Providers can reuse a turnId. The canonical prompt position owns this occurrence.
      let selected = entries
        .slice(promptIndex + 1, end + 1)
        .filter((entry) => entry.turnId === turnId);
      if (approvedPlanCallId) {
        if (unconfirmedPlan(entries, approvedPlanCallId)) return null;
        const resolution = entries.find(
          ({ item }) =>
            item.type === "tool_call" &&
            item.callId === approvedPlanCallId &&
            item.detail.type === "plan" &&
            item.status === "completed" &&
            !item.error &&
            item.metadata?.approved === true,
        );
        if (!resolution) return null;
        if (entries[promptIndex]!.seqStart <= resolution.seqEnd) {
          // A provider may resume the plan's own turn without another user prompt.
          if (resolution.turnId !== turnId) return null;
          selected = selected.filter((entry) => entry.seqStart > resolution.seqEnd);
          if (
            !selected.some(({ item }) =>
              item.type === "assistant_message"
                ? Boolean(item.text.trim())
                : item.type === "tool_call" &&
                  item.detail.type !== "plan" &&
                  item.status === "completed",
            )
          )
            return null;
        }
      }
      const prompt = entries[promptIndex]!.item;
      if (
        expectedMessageId &&
        (prompt?.type !== "user_message" || prompt.clientMessageId !== expectedMessageId)
      )
        return null;
      if (!selected.length) return null;
      return {
        key: `${turnId}:${selected.at(-1)!.seqEnd}`,
        items: selected.map((entry) => entry.item),
      };
    },
    git: async (cwd) => {
      const [startHead, branch, dirty] = await Promise.all([
        git(cwd, ["rev-parse", "HEAD"]),
        git(cwd, ["branch", "--show-current"]),
        git(cwd, ["status", "--porcelain=v1"]),
      ]);
      let targetRef: string | undefined;
      let targetBase: string | undefined;
      try {
        targetRef = (await git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"])).trim();
        targetBase = (await git(cwd, ["merge-base", "HEAD", targetRef])).trim();
      } catch {
        // No guessed branch name: workflow completion will expose verification_required.
      }
      return {
        startHead: startHead.trim(),
        ...(targetRef ? { targetRef } : {}),
        ...(targetBase ? { targetBase } : {}),
        branch: branch.trim(),
        dirty,
      };
    },
    diff: async (cwd, base) => {
      const [head, text, dirty] = await Promise.all([
        git(cwd, ["rev-parse", "HEAD"]),
        git(cwd, ["diff", "--no-ext-diff", base, "--"]),
        git(cwd, ["status", "--porcelain=v1", "-z"]),
      ]);
      const entries = dirty.split("\0").filter(Boolean);
      return {
        head: head.trim(),
        text,
        dirtyFiles: entries.map((entry) => entry.slice(3)),
        untrackedFiles: entries
          .filter((entry) => entry.startsWith("?? "))
          .map((entry) => entry.slice(3)),
      };
    },
    commitCount: async (cwd, base) =>
      Number((await git(cwd, ["rev-list", "--count", `${base}..HEAD`])).trim()),
    create: async ({ workspaceId, ...input }) => {
      const agent = await paseo.workspaces.ref(workspaceId).agents.create(input);
      const id = agent.id;
      return id;
    },
    send: async (id, text, messageId) => {
      const agent = paseo.agents.ref(id);
      await agent.send(text, { messageId });
    },
    revise: async (context, text, messageId) =>
      paseo.agents.ref(context.agentId).sendPlanRevision({
        workspaceId: context.workspaceId,
        callId: context.callId,
        sourcePlanText: context.text,
        text,
        messageId,
      }),
    respond: async (id, requestId, response) => {
      const agent = paseo.agents.ref(id);
      await agent.respondToPermission({ requestId, response });
    },
    claimReview: async ({ agentId, workspaceId, permissionRequestId, callId }, active) => {
      await paseo.agents
        .ref(agentId)
        .setPlanReviewClaim({ workspaceId, permissionRequestId, callId, active });
    },
    read: async () => {
      const current = await settings.read();
      revision = current.revision;
      return current.values;
    },
    write: async (value) => {
      if (!revision) throw new Error("Workflow state was not loaded.");
      await settings.write(value, revision);
      revision = (await settings.read()).revision;
    },
  };
  return new WorkflowController(port);
}

export async function prepareAgent(request: PluginBeforeRequests["agent.create"], paseo: PaseoApi) {
  const role = roles.find((candidate) => profileId(candidate) === request.launchProfileId);
  if (role) {
    const profile = (await paseo.config.get()).config.agentProfiles?.find(
      (candidate) => candidate.id === request.launchProfileId,
    );
    if (!profile)
      throw new Error(
        `Profile '${request.launchProfileId}' is missing. Open Workflow settings and choose Install / repair profiles.`,
      );
  }
  if (!request.workspaceId) {
    if (role) throw new Error("A workflow agent requires a workspace.");
    return request;
  }
  const workspace = await paseo.workspaces.ref(request.workspaceId).refresh();
  if (!workspace) throw new Error("The workflow workspace is unavailable.");
  if (!role && !workspace.intent) return request;
  const readOnly = role === "router" || role === "plan-reviewer" || role?.startsWith("audit-");
  let instruction: string | undefined;
  if (role === "router") {
    instruction =
      'Clarify the real user request interactively, expose tradeoffs and ask missing questions. Do not implement or delegate. Once ready, return only JSON {"ready":true,"recommendation":"standard|advanced","constraints":["..."],"assumptions":["..."]}. Until ready, ask the user questions; do not return the ready JSON.';
  } else if (role) {
    instruction = `Your workflow role is ${role}. Follow the bounded workflow request. ${readOnly ? "Read only. Never edit, mutate, commit or delegate." : "Preserve pre-existing dirty files and concurrent changes. Never push, merge, deploy or cause external effects without explicit user authority."}`;
    if (role === "planner")
      instruction +=
        " Before approval, clarify and plan without implementing. After approval, implement the approved plan in this conversation, run targeted checks, stage only your own files/hunks, and create a functional commit after successful validation. Then wait for final review. If validation or attribution is blocked, report it instead of committing.";
  }
  return {
    ...request,
    config: {
      ...request.config,
      ...(readOnly ? { writePolicy: "read_only" as const } : {}),
      systemPrompt: [
        request.config.systemPrompt,
        instruction,
        workspace.intent ? `Workspace intention:\n${workspace.intent}` : undefined,
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  };
}
