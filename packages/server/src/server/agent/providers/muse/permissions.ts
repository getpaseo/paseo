import type {
  AgentMetadata,
  AgentPermissionAction,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentProvider,
  ToolCallDetail,
} from "../../agent-sdk-types.js";
import { isRecord, parseJsonRecord, readString } from "./items.js";

export const MUSE_APPROVAL_METADATA = "muse_approval";
export const MUSE_USER_INPUT_METADATA = "muse_user_input";

export interface MuseApprovalChoice {
  choiceId: string;
  decision: string;
  label: string;
  scope: string;
  acceptsFeedback: boolean;
}

export interface MusePendingApproval {
  kind: "approval";
  request: AgentPermissionRequest;
  approvalId: string;
  requirementId: unknown;
  sessionId: string;
  turnId?: string;
  choices: MuseApprovalChoice[];
}

export interface MusePendingQuestion {
  id: string;
  header: string;
  question: string;
  multiSelect: boolean;
  options: Array<{ label: string; description?: string }>;
}

export interface MusePendingUserInput {
  kind: "userInput";
  request: AgentPermissionRequest;
  userInputId: string;
  sessionId: string;
  turnId?: string;
  questions: MusePendingQuestion[];
}

export type MusePendingRequest = MusePendingApproval | MusePendingUserInput;

function readApprovalChoice(value: unknown): MuseApprovalChoice | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value["choiceId"] !== "string" ||
    typeof value["decision"] !== "string" ||
    typeof value["label"] !== "string" ||
    typeof value["scope"] !== "string"
  ) {
    return null;
  }
  return {
    choiceId: value["choiceId"],
    decision: value["decision"],
    label: value["label"],
    scope: value["scope"],
    acceptsFeedback: value["acceptsFeedback"] === true,
  };
}

function isAllowDecision(decision: string): boolean {
  return decision.startsWith("approved");
}

function mapChoiceToAction(choice: MuseApprovalChoice): AgentPermissionAction {
  if (isAllowDecision(choice.decision)) {
    return {
      id: choice.choiceId,
      label: choice.label,
      behavior: "allow",
      variant: choice.scope === "once" ? "primary" : "secondary",
    };
  }
  return {
    id: choice.choiceId,
    label: choice.label,
    behavior: "deny",
    variant: "danger",
  };
}

function readStagesCommand(stages: unknown): string | undefined {
  if (!Array.isArray(stages)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const stage of stages) {
    if (!isRecord(stage) || !Array.isArray(stage["argv"])) {
      continue;
    }
    const argv = stage["argv"].filter((entry): entry is string => typeof entry === "string");
    if (argv.length > 0) {
      parts.push(argv.join(" "));
    }
  }
  return parts.length > 0 ? parts.join(" && ") : undefined;
}

interface ApprovalSubjectView {
  title: string;
  description?: string;
  detail: ToolCallDetail;
}

function mapApprovalSubject(
  subject: Record<string, unknown>,
  toolName: string,
  rawArgs: string | undefined,
): ApprovalSubjectView {
  const kind = typeof subject["kind"] === "string" ? subject["kind"] : "tool";
  switch (kind) {
    case "shell": {
      const command =
        readStagesCommand(subject["stages"]) ??
        readString(subject, ["command"]) ??
        toolName;
      return {
        title: `Allow shell command: ${command}`,
        detail: {
          type: "shell",
          command,
          cwd: readString(subject, ["workspaceRoot"]),
        },
      };
    }
    case "fileAccess": {
      const path = readString(subject, ["path"]) ?? "(unknown path)";
      const access = readString(subject, ["access"]) ?? "";
      if (access.includes("read")) {
        return {
          title: `Allow file read: ${path}`,
          detail: { type: "read", filePath: path },
        };
      }
      if (access.includes("write")) {
        return {
          title: `Allow file write: ${path}`,
          detail: { type: "write", filePath: path },
        };
      }
      return {
        title: `Allow file access: ${path}`,
        description: access.length > 0 ? `Access: ${access}` : undefined,
        detail: { type: "plain_text", label: toolName, text: `${access} ${path}`.trim() },
      };
    }
    case "network": {
      const host = readString(subject, ["host"]) ?? "(unknown host)";
      const protocol = readString(subject, ["protocol"]) ?? "https";
      const port = subject["port"];
      const url = `${protocol}://${host}${typeof port === "number" ? `:${port}` : ""}`;
      return {
        title: `Allow network access: ${url}`,
        detail: { type: "fetch", url },
      };
    }
    case "process": {
      const target = readString(subject, ["target"]) ?? rawArgs ?? kind;
      return {
        title: `Allow process: ${toolName}`,
        detail: { type: "plain_text", label: toolName, text: target },
      };
    }
    case "tool":
    default: {
      const parsed = rawArgs ? parseJsonRecord(rawArgs) : undefined;
      return {
        title: `Allow tool: ${toolName}`,
        ...(kind !== "tool" ? { description: `Subject kind: ${kind}` } : {}),
        detail: parsed
          ? { type: "unknown", input: parsed, output: null }
          : {
              type: "plain_text",
              label: toolName,
              ...(rawArgs ? { text: rawArgs } : {}),
            },
      };
    }
  }
}

export function mapMuseApprovalRequest(
  params: Record<string, unknown>,
  provider: AgentProvider,
): { request: AgentPermissionRequest; entry: MusePendingApproval } | null {
  const approvalId = params["approvalId"];
  const sessionId = params["sessionId"];
  const subject = params["subject"];
  if (
    typeof approvalId !== "string" ||
    typeof sessionId !== "string" ||
    !isRecord(subject) ||
    !("currentRequirementId" in params)
  ) {
    return null;
  }
  const choices = Array.isArray(params["availableChoices"])
    ? params["availableChoices"].flatMap((choice) => {
        const parsed = readApprovalChoice(choice);
        return parsed ? [parsed] : [];
      })
    : [];
  if (choices.length === 0) {
    return null;
  }
  const toolName =
    typeof params["toolName"] === "string" && params["toolName"].length > 0
      ? params["toolName"]
      : "tool";
  const rawArgs = typeof params["rawArgs"] === "string" ? params["rawArgs"] : undefined;
  const view = mapApprovalSubject(subject, toolName, rawArgs);
  const flags: string[] = [];
  if (params["protectedWrite"] === true) {
    flags.push("Protected write.");
  }
  if (params["judgeEscalated"] === true) {
    flags.push("Escalated for review.");
  }
  const turnId = typeof params["turnId"] === "string" ? params["turnId"] : undefined;
  const request: AgentPermissionRequest = {
    id: approvalId,
    provider,
    name: toolName,
    kind: "tool",
    title: view.title,
    ...(view.description ?? flags.length > 0
      ? { description: [view.description, ...flags].filter(Boolean).join(" ") }
      : {}),
    detail: view.detail,
    actions: choices.map(mapChoiceToAction),
    metadata: {
      musePendingKind: MUSE_APPROVAL_METADATA,
      approvalId,
      sessionId,
      ...(turnId ? { turnId } : {}),
      toolName,
      choices,
      requirementId: params["currentRequirementId"],
    },
  };
  return {
    request,
    entry: {
      kind: "approval",
      request,
      approvalId,
      requirementId: params["currentRequirementId"],
      sessionId,
      ...(turnId ? { turnId } : {}),
      choices,
    },
  };
}

export function buildMuseApprovalDecision(
  entry: MusePendingApproval,
  response: AgentPermissionResponse,
): { choiceId: string; feedback?: string } {
  let choice: MuseApprovalChoice | undefined;
  if (response.selectedActionId) {
    choice = entry.choices.find((candidate) => candidate.choiceId === response.selectedActionId);
    if (!choice) {
      throw new Error(`Unknown Muse approval choice: ${response.selectedActionId}`);
    }
  } else if (response.behavior === "allow") {
    choice =
      entry.choices.find(
        (candidate) => isAllowDecision(candidate.decision) && candidate.scope === "once",
      ) ?? entry.choices.find((candidate) => isAllowDecision(candidate.decision));
    if (!choice) {
      throw new Error("Muse approval offers no allow choice");
    }
  } else {
    choice =
      entry.choices.find((candidate) => !isAllowDecision(candidate.decision)) ??
      entry.choices.find((candidate) => candidate.decision.startsWith("denied"));
    if (!choice) {
      throw new Error("Muse approval offers no deny choice");
    }
  }
  if (response.behavior === "deny" && response.message && choice.acceptsFeedback) {
    return { choiceId: choice.choiceId, feedback: response.message };
  }
  return { choiceId: choice.choiceId };
}

function readPendingQuestion(value: unknown): MusePendingQuestion | null {
  if (!isRecord(value)) {
    return null;
  }
  const selection = isRecord(value["selection"]) ? value["selection"] : undefined;
  const mode = selection && typeof selection["mode"] === "string" ? selection["mode"] : "single";
  if (
    typeof value["id"] !== "string" ||
    typeof value["header"] !== "string" ||
    typeof value["question"] !== "string" ||
    !Array.isArray(value["options"])
  ) {
    return null;
  }
  const options: MusePendingQuestion["options"] = [];
  for (const option of value["options"]) {
    if (!isRecord(option) || typeof option["label"] !== "string") {
      continue;
    }
    options.push({
      label: option["label"],
      ...(typeof option["description"] === "string" ? { description: option["description"] } : {}),
    });
  }
  return {
    id: value["id"],
    header: value["header"],
    question: value["question"],
    multiSelect: mode === "multiple",
    options,
  };
}

export function mapMuseUserInputRequest(
  params: Record<string, unknown>,
  provider: AgentProvider,
): { request: AgentPermissionRequest; entry: MusePendingUserInput } | null {
  const userInputId = params["userInputId"];
  const sessionId = params["sessionId"];
  if (typeof userInputId !== "string" || typeof sessionId !== "string") {
    return null;
  }
  const questions = Array.isArray(params["questions"])
    ? params["questions"].flatMap((question) => {
        const parsed = readPendingQuestion(question);
        return parsed ? [parsed] : [];
      })
    : [];
  if (questions.length === 0) {
    return null;
  }
  const toolName =
    typeof params["toolName"] === "string" && params["toolName"].length > 0
      ? params["toolName"]
      : "question";
  const turnId = typeof params["turnId"] === "string" ? params["turnId"] : undefined;
  const request: AgentPermissionRequest = {
    id: userInputId,
    provider,
    name: toolName,
    kind: "question",
    title: questions.length === 1 ? questions[0].question : `${toolName}: ${questions.length} questions`,
    input: {
      questions: questions.map((question) => ({
        question: question.question,
        header: question.header,
        options: question.options,
        multiSelect: question.multiSelect,
      })),
    },
    metadata: {
      musePendingKind: MUSE_USER_INPUT_METADATA,
      userInputId,
      sessionId,
      ...(turnId ? { turnId } : {}),
      questions: questions.map((question) => ({
        id: question.id,
        header: question.header,
        multiSelect: question.multiSelect,
      })),
    },
  };
  return {
    request,
    entry: {
      kind: "userInput",
      request,
      userInputId,
      sessionId,
      ...(turnId ? { turnId } : {}),
      questions,
    },
  };
}

export interface MuseUserInputAnswer {
  questionId: string;
  selectedLabel?: string;
  selectedLabels?: string[];
  freeText?: string;
}

export type MuseUserInputResolution =
  | { cancel: true; reason?: string }
  | { cancel: false; answers: MuseUserInputAnswer[] };

function readAnswerText(input: AgentMetadata | undefined, header: string): string {
  if (!input || !isRecord(input["answers"])) {
    return "";
  }
  const answer = input["answers"][header];
  return typeof answer === "string" ? answer : "";
}

export function buildMuseUserInputResolution(
  entry: MusePendingUserInput,
  response: AgentPermissionResponse,
): MuseUserInputResolution {
  if (response.behavior === "deny") {
    return {
      cancel: true,
      ...(response.message ? { reason: response.message } : {}),
    };
  }
  const answers: MuseUserInputAnswer[] = entry.questions.map((question) => {
    const text = readAnswerText(response.updatedInput, question.header);
    if (question.options.length === 0) {
      return { questionId: question.id, freeText: text.slice(0, 500) };
    }
    if (question.multiSelect) {
      const selectedLabels =
        text.length > 0
          ? text
              .split(",")
              .map((label) => label.trim())
              .filter((label) => label.length > 0)
          : [];
      return { questionId: question.id, selectedLabels };
    }
    return { questionId: question.id, selectedLabel: text };
  });
  return { cancel: false, answers };
}

export function readMspErrorKind(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const kind = (error as Record<string, unknown>)["kind"];
  return typeof kind === "string" ? kind : undefined;
}
