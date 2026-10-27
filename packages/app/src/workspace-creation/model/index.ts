import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { captureCreationInput } from "../internal/capture";
import type { CreateWorkspaceRequestOptions } from "@getpaseo/client/internal/daemon-client";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import type { CreationSnapshot } from "@getpaseo/protocol/messages";
import type { UserMessageItem } from "@/types/stream";

export interface Submission {
  serverId: string;
  key: string;
  provider: AgentProvider;
  /** Submitted agent configuration, shown before the host publishes the agent. */
  config: { modeId?: string; model?: string; thinkingOptionId?: string };
  projectId: string;
  projectName: string;
  text: string;
  message?: Omit<UserMessageItem, "id" | "clientMessageId">;
  prepare: () => Promise<CreateWorkspaceRequestOptions>;
  onComplete?: () => void;
  /** The host created neither the workspace nor the agent. */
  onWorkspaceFailed?: (attempt: CreationAttempt, error: string) => void;
  /** The host created the workspace but not the agent. The receipt's workspace, when it has one. */
  onAgentFailed?: (
    attempt: CreationAttempt,
    error: string,
    workspace: CreationSnapshot["workspace"],
  ) => void;
}
type SubmissionHandlers = "prepare" | "onComplete" | "onWorkspaceFailed" | "onAgentFailed";
export interface CreationAttempt extends Omit<Submission, SubmissionHandlers> {
  operationKey: string;
  workspaceId: string;
  agentId: string;
  clientMessageId: string;
  phase: "preparing" | "creating" | "complete";
  workspaceObserved: boolean;
  agentObserved: boolean;
}
interface Result {
  workspace?: unknown;
  error?: string | null;
  creation?: CreationSnapshot;
}
interface Operation extends Pick<Submission, "onComplete" | "onWorkspaceFailed" | "onAgentFailed"> {
  attempt: CreationAttempt;
  /** The host's latest account of this creation. */
  creation?: CreationSnapshot;
  running?: Promise<void>;
}

/** What the host is known to have created for a failed creation. */
function createdResources(
  attempt: CreationAttempt,
  creation: CreationSnapshot | undefined,
): "agent" | "workspace" | "none" {
  if (
    attempt.agentObserved ||
    creation?.agent ||
    creation?.failedStage === "prompt" ||
    (creation?.failedStage === "agent" && creation.outcomeUnknown)
  )
    return "agent";
  if (attempt.workspaceObserved || creation?.workspace || creation?.failedStage === "agent")
    return "workspace";
  return "none";
}
export function createWorkspaceCreationModel(dependencies: {
  identities: () => Pick<
    CreationAttempt,
    "operationKey" | "workspaceId" | "agentId" | "clientMessageId"
  >;
  execute: (request: CreateWorkspaceRequestOptions, serverId: string) => Promise<Result>;
  onSubmitted?: (attempt: CreationAttempt) => void;
  /** The host did not create the agent; its prompt was never delivered. */
  onFailed?: (attempt: CreationAttempt) => void;
  onComplete?: (attempt: CreationAttempt) => void;
  /** The completed creation's workspace and agent are both published. */
  onAdopted?: (attempt: CreationAttempt) => void;
}) {
  const listeners = new Set<() => void>();
  let snapshot: readonly CreationAttempt[] = [];
  const operations = new Map<string, Operation>();
  // Current submissions remain owned until settled and adopted. Adopted creations
  // only need a bounded receipt to absorb duplicate commands from retained forms.
  const receipts = new Map<string, CreationAttempt>();
  const intentKey = (serverId: string, key: string) =>
    bytesToHex(sha256(utf8ToBytes(JSON.stringify([serverId, key]))));
  const operationFor = (attempt: CreationAttempt) => operations.get(attempt.key);
  function retire(operation: Operation) {
    if (
      operation.attempt.phase !== "complete" ||
      !operation.attempt.workspaceObserved ||
      !operation.attempt.agentObserved
    )
      return;
    const receipt = { ...operation.attempt, text: "", message: undefined, projectName: "" };
    receipts.set(receipt.key, receipt);
    while (receipts.size > 128) receipts.delete(receipts.keys().next().value!);
    operations.delete(receipt.key);
    publish();
    dependencies.onAdopted?.(operation.attempt);
  }
  function publish() {
    snapshot = [...operations.values()].map(({ attempt }) => attempt);
    listeners.forEach((listener) => listener());
  }
  function patch(
    operation: NonNullable<ReturnType<typeof operations.get>>,
    update: Partial<CreationAttempt>,
  ) {
    operation.attempt = { ...operation.attempt, ...update };
    publish();
  }
  function complete(operation: Operation) {
    patch(operation, { phase: "complete" });
    dependencies.onComplete?.(operation.attempt);
    const onComplete = operation.onComplete;
    operation.onComplete = undefined;
    operation.onWorkspaceFailed = undefined;
    operation.onAgentFailed = undefined;
    onComplete?.();
    retire(operation);
  }
  /** Hands a failure to the owner of what the host created: the agent, the workspace or nothing. */
  function fail(operation: Operation, error: string) {
    const created = createdResources(operation.attempt, operation.creation);
    if (created === "agent") {
      complete(operation);
      return;
    }
    operations.delete(operation.attempt.key);
    publish();
    dependencies.onFailed?.(operation.attempt);
    if (created === "workspace")
      operation.onAgentFailed?.(operation.attempt, error, operation.creation?.workspace);
    else operation.onWorkspaceFailed?.(operation.attempt, error);
  }
  async function run(operation: Operation, prepare: Submission["prepare"]) {
    try {
      const prepared = await prepare();
      const request = captureCreationInput({
        ...prepared,
        workspaceId: operation.attempt.workspaceId,
        idempotencyKey: operation.attempt.operationKey,
        agent: {
          ...prepared.agent,
          agentId: operation.attempt.agentId,
          clientMessageId: operation.attempt.clientMessageId,
        },
      });
      patch(operation, { phase: "creating" });
      const result = await dependencies.execute(
        {
          ...request,
          // CreationClient owns receipt ordering; progress alone does not change presentation.
          onEvent: (event) => {
            operation.creation = event;
          },
        },
        operation.attempt.serverId,
      );
      if (result.creation) operation.creation = result.creation;
      if (result.error) {
        fail(operation, result.error);
        return;
      }
      complete(operation);
    } catch (error) {
      fail(operation, error instanceof Error ? error.message : String(error));
    } finally {
      operation.running = undefined;
    }
  }
  function start(operation: Operation, prepare: Submission["prepare"]) {
    operation.running = Promise.resolve().then(() => run(operation, prepare));
  }
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    submit(input: Submission): CreationAttempt {
      const key = intentKey(input.serverId, input.key);
      const existing = operations.get(key);
      if (existing) return existing.attempt;
      const receipt = receipts.get(key);
      if (receipt) return receipt;
      const { prepare, onComplete, onWorkspaceFailed, onAgentFailed, ...presentation } = input;
      const attempt: CreationAttempt = {
        ...captureCreationInput(presentation),
        key,
        ...dependencies.identities(),
        phase: "preparing",
        workspaceObserved: false,
        agentObserved: false,
      };
      const operation: Operation = {
        onComplete,
        onWorkspaceFailed,
        onAgentFailed,
        attempt,
      };
      operations.set(key, operation);
      dependencies.onSubmitted?.(operation.attempt);
      publish();
      start(operation, prepare);
      return operation.attempt;
    },
    observeResources(
      serverId: string,
      workspaces: ReadonlySet<string>,
      agents: ReadonlySet<string>,
    ) {
      for (const operation of operations.values()) {
        const attempt = operation.attempt;
        if (attempt.serverId !== serverId) continue;
        const workspaceObserved = attempt.workspaceObserved || workspaces.has(attempt.workspaceId);
        const agentObserved = attempt.agentObserved || agents.has(attempt.agentId);
        if (
          workspaceObserved !== attempt.workspaceObserved ||
          agentObserved !== attempt.agentObserved
        )
          patch(operation, { workspaceObserved, agentObserved });
        retire(operation);
      }
    },
    getWorkspace: (serverId: string, workspaceId: string) =>
      snapshot.find((item) => item.serverId === serverId && item.workspaceId === workspaceId) ??
      null,
    getAgent: (serverId: string, agentId: string) =>
      snapshot.find((item) => item.serverId === serverId && item.agentId === agentId) ?? null,
    settled: (attempt: CreationAttempt) => operationFor(attempt)?.running ?? Promise.resolve(),
  };
}
