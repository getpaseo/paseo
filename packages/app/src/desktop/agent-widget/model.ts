import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
} from "@getpaseo/protocol/agent-types";
import type { WidgetAction, WidgetRequest } from "@getpaseo/protocol/desktop-agent-widget";
import type { HostProjectListItem } from "@/projects/host-projects";
import type { ProjectIconRenderData } from "@/projects/icons";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { deriveIdentityColorName, identityColor } from "@/styles/identity-colors";
import { createMarkdownParser } from "@/utils/markdown-parser";
import {
  areQuestionsAnswered,
  buildQuestionFormAnswers,
  parseQuestionFormQuestions,
} from "@/components/question-form-card-core";

export function projectWidgetIdentity(
  project: Pick<HostProjectListItem, "projectName" | "viewKey"> | undefined,
  workspace: Pick<WorkspaceDescriptor, "gitRuntime"> | undefined,
  icons: ReadonlyMap<string, ProjectIconRenderData>,
): WidgetRequest["project"] {
  if (!project) return undefined;
  const icon = icons.get(project.viewKey);
  return {
    name: project.projectName,
    branchName: workspace?.gitRuntime?.currentBranch ?? "",
    color: identityColor(deriveIdentityColorName(project.viewKey)),
    iconDataUri: icon?.dataUri,
    emoji: icon?.emoji,
  };
}

const markdown = createMarkdownParser({ linkify: false });
// Images can disclose plan content through remote URLs; this small reading surface is text-only.
markdown.disable("image");
interface RequestInput {
  serverId: string;
  agentId: string;
  request: AgentPermissionRequest;
  project?: WidgetRequest["project"];
  agentTitle: string;
  workspace: string;
  workspaceId?: string;
  handoffDisabledReason?: string;
  handoffProfiles?: { id: string; name: string }[];
}
function handoffDisabledReason(input: RequestInput, plan: unknown): string | undefined {
  if (input.handoffDisabledReason) return input.handoffDisabledReason;
  if (input.request.kind !== "plan") return undefined;
  return input.request.sourcePlanCallId && plan ? undefined : "This plan cannot be handed off.";
}
export function projectWidgetRequest(input: RequestInput): WidgetRequest | null {
  const { request, serverId, agentId, agentTitle, workspace } = input;
  if (request.kind !== "plan" && request.kind !== "question") return null;
  const questions = parseQuestionFormQuestions(request.input) ?? [];
  if (request.kind === "question" && questions.length === 0) return null;
  let plan =
    typeof request.metadata?.planText === "string"
      ? request.metadata.planText
      : request.input?.plan;
  if (typeof plan !== "string" && request.detail?.type === "plan") plan = request.detail.text;
  if (request.kind === "plan" && typeof plan !== "string") return null;
  const canApprove =
    !request.actions?.length || request.actions.some((action) => action.behavior === "allow");
  return {
    key: JSON.stringify([serverId, agentId, request.id]),
    serverId,
    agentId,
    requestId: request.id,
    workspaceId: input.workspaceId,
    planCallId: request.sourcePlanCallId,
    planText: typeof plan === "string" ? plan : undefined,
    handoffDisabledReason: handoffDisabledReason(input, plan),
    handoffProfiles: input.handoffProfiles,
    project: input.project,
    agentTitle,
    workspace,
    kind: request.kind,
    title: request.title ?? "",
    planHtml: typeof plan === "string" ? markdown.render(plan) : "",
    questions,
    canApprove,
  };
}
export function buildWidgetPermissionResponse(
  request: AgentPermissionRequest,
  action: WidgetAction,
): AgentPermissionResponse {
  if (action.type === "approve") return approvePlan(request);
  if (action.type !== "answer" || request.kind !== "question")
    throw new Error("This request has changed.");
  const questions = parseQuestionFormQuestions(request.input);
  if (!questions) throw new Error("This question cannot be answered here.");
  const selections: Record<number, ReadonlySet<number>> = {};
  const texts: Record<number, string> = {};
  for (const [index, question] of questions.entries()) {
    const selected = action.selections[index] ?? [];
    if (selected.some((value) => value >= question.options.length))
      throw new Error("Invalid question option.");
    if (!question.multiSelect && selected.length > 1) throw new Error("Select one option.");
    selections[index] = new Set(selected);
    texts[index] = action.texts[index] ?? "";
  }
  if (!areQuestionsAnswered(questions, selections, texts))
    throw new Error("Answer all required questions.");
  return {
    behavior: "allow",
    updatedInput: {
      ...request.input,
      answers: buildQuestionFormAnswers(questions, selections, texts),
    },
  };
}

function approvePlan(request: AgentPermissionRequest): AgentPermissionResponse {
  if (request.kind !== "plan") throw new Error("This request has changed.");
  const allowing = request.actions?.filter((item) => item.behavior === "allow") ?? [];
  const allow = allowing.find((item) => item.variant === "primary") ?? allowing[0];
  if (request.actions?.length && !allow) throw new Error("This plan cannot be approved.");
  return { behavior: "allow", selectedActionId: allow?.id ?? "accept" };
}

interface WidgetResponseInput {
  client: Pick<
    import("@getpaseo/client/internal/daemon-client").DaemonClient,
    "sendAgentMessage" | "respondToPermissionAndWait"
  >;
  agentId: string;
  request: AgentPermissionRequest;
  operationId: string;
  action: WidgetAction;
}
export async function respondToWidgetRequest(input: WidgetResponseInput): Promise<void> {
  const { client, agentId, request, operationId, action } = input;
  if (action.type === "comment") {
    if (request.kind !== "plan") throw new Error("This request is not a plan.");
    // Interrupting a waiting plan uses the normal prompt path and keeps feedback in this conversation.
    await client.sendAgentMessage(agentId, action.message, {
      messageId: operationId,
      activeTurnBehavior: "interrupt",
    });
    return;
  }
  await client.respondToPermissionAndWait(
    agentId,
    request.id,
    buildWidgetPermissionResponse(request, action),
    15000,
  );
}
