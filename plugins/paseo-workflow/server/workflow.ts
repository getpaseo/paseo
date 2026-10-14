import { profileId, type Role } from "../shared/profiles";
import { decisionJson, routerDecision } from "../shared/decisions";
import {
  classification,
  auditorsFor,
  auditDecision,
  correctionDecision,
  type FinalReview,
} from "../shared/final-review";
import { type ExecutionDecision } from "./execution-routing";
import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentProfile,
  AgentTimelineItem,
  PaseoAgentConfig,
} from "./types";
import { handoffPlanTitle } from "../shared/handoff-presentation";

export interface PlanContext {
  workspaceId: string;
  agentId: string;
  permissionRequestId: string;
  callId: string;
  text: string;
}
type StoredPlanContext = Omit<PlanContext, "permissionRequestId"> & {
  permissionRequestId?: string;
};
export interface WorkflowAgent {
  id: string;
  workspaceId?: string;
  launchProfileId?: string;
  labels: Record<string, string>;
  status?: string;
  pendingPermissions: Pick<
    AgentPermissionRequest,
    "id" | "kind" | "sourcePlanCallId" | "input" | "metadata"
  >[];
}
export interface WorkflowLaunch {
  workspaceId: string;
  title?: string;
  parent?: string;
  launchProfileId?: string;
  idempotencyKey: string;
  config: PaseoAgentConfig;
  prompt?: string;
  clientMessageId?: string;
  outputSchema?: Record<string, unknown>;
  labels: Record<string, string>;
}
interface Review {
  source: "automatic" | "manual";
  phase: "closing" | "closed" | "running" | "complete" | "outcome_unknown";
  agentId?: string;
  promptSent?: boolean;
  superseded?: boolean;
}
interface Handoff {
  // COMPAT(workflow-executor-selection): added in v0.8.0, remove after 2027-09-13.
  selection?: "standard" | "advanced";
  phase: "closing" | "closed" | "running" | "outcome_unknown";
  agentId?: string;
}
interface Routing {
  attempt: number;
  phase: "running" | "complete" | "failed" | "outcome_unknown";
  agentId?: string;
  decision?: ExecutionDecision;
  error?: string;
  promptStarted?: boolean;
}
export interface Workflow {
  id: string;
  workspaceId: string;
  plannerId: string;
  routerId?: string;
  routed?: boolean;
  activePlanId?: string;
  preparedPlanId?: string;
  handledTurns?: Record<string, string>;
  plannerTranscript?: Array<{ role: "user" | "assistant"; text: string }>;
  intent: string;
  request: string;
  constraints: string[];
  assumptions: string[];
  git: {
    base?: string;
    startHead?: string;
    targetBase?: string;
    targetRef?: string;
    branch: string;
    dirty: string;
  };
  recommendation: "standard" | "advanced" | null;
  plans: Record<
    string,
    {
      context: StoredPlanContext;
      review?: Review;
      handoff?: Handoff;
      routing?: Routing;
      handoffRequested?: boolean;
      approved?: boolean;
      verification?: string;
      final?: FinalReview;
    }
  >;
}
export interface WorkflowState {
  workflows: Record<string, Workflow>;
}
const UNCONFIRMED_APPROVAL =
  "Approval follow-up outcome_unknown. Inspect this conversation before continuing; automatic completion is suspended.";
export interface WorkflowPort {
  profiles(): Promise<AgentProfile[]>;
  models(
    provider: string,
    cwd: string,
  ): Promise<Array<{ id: string; thinkingOptions?: Array<{ id: string }> }>>;
  classify(briefing: string, signal: AbortSignal): Promise<ExecutionDecision>;
  agent(id: string): Promise<WorkflowAgent>;
  workspace(id: string): Promise<{ cwd: string; intent?: string | null }>;
  timeline(id: string, projection?: "canonical" | "projected"): Promise<AgentTimelineItem[]>;
  turn(
    id: string,
    turnId?: string,
    expectedMessageId?: string,
    approvedPlanCallId?: string,
    afterMessageId?: string,
  ): Promise<{ key: string; items: AgentTimelineItem[] } | null>;
  git(cwd: string): Promise<Workflow["git"]>;
  diff(
    cwd: string,
    base: string,
  ): Promise<{ head: string; text: string; dirtyFiles: string[]; untrackedFiles: string[] }>;
  commitCount(cwd: string, base: string): Promise<number>;
  create(input: WorkflowLaunch): Promise<string>;
  send(agentId: string, text: string, messageId: string): Promise<void>;
  revise(context: PlanContext, text: string, messageId: string): Promise<boolean>;
  respond(agentId: string, requestId: string, response: AgentPermissionResponse): Promise<void>;
  claimReview(context: PlanContext, active: boolean): Promise<void>;
  read(): Promise<WorkflowState>;
  write(state: WorkflowState): Promise<void>;
}

function profileConfig(profile: AgentProfile, readOnly: boolean): PaseoAgentConfig {
  return {
    provider: profile.model ? `${profile.provider}/${profile.model}` : profile.provider,
    modeId: profile.modeId,
    thinkingOptionId: profile.thinkingOptionId,
    featureValues: profile.featureValues,
    writePolicy: readOnly ? "read_only" : "read_write",
  };
}

function briefing(workflow: Workflow, plan: string): string {
  return JSON.stringify(
    {
      intention: workflow.intent,
      request: workflow.request,
      plan,
      constraints: workflow.constraints,
      assumptions: workflow.assumptions,
      plannerTranscript: workflow.plannerTranscript ?? [],
      git: workflow.git,
    },
    null,
    2,
  );
}

function requestFrom(timeline: readonly AgentTimelineItem[]): string {
  return timeline
    .flatMap((item) =>
      item.type === "user_message" && !item.clientMessageId?.startsWith("workflow:")
        ? [item.text]
        : [],
    )
    .join("\n\nUser follow-up:\n");
}

function samePlan(left: StoredPlanContext, right: StoredPlanContext): boolean {
  return (
    left.agentId === right.agentId &&
    left.workspaceId === right.workspaceId &&
    left.callId === right.callId &&
    (!left.permissionRequestId ||
      !right.permissionRequestId ||
      left.permissionRequestId === right.permissionRequestId) &&
    left.text === right.text
  );
}

function planResolution(
  item: Extract<AgentTimelineItem, { type: "tool_call" }>,
): AgentPermissionResponse | undefined {
  const resolution = item.metadata?.resolution;
  if (typeof resolution !== "object" || resolution === null || !("behavior" in resolution))
    return undefined;
  return resolution.behavior === "allow" || resolution.behavior === "deny"
    ? (resolution as AgentPermissionResponse)
    : undefined;
}

function closureMessage(workflow: Workflow, plan: StoredPlanContext, action: "review" | "handoff") {
  return `Workflow ${workflow.id}: ${action} ${plan.callId}; stop without implementation.`;
}

function actionContext(context: StoredPlanContext): PlanContext {
  if (!context.permissionRequestId)
    throw new Error("This recovered plan is already resolved and cannot accept plan actions.");
  return { ...context, permissionRequestId: context.permissionRequestId };
}

type PlanItem = Extract<AgentTimelineItem, { type: "tool_call" }>;

function canonicalPlanItems(timeline: readonly AgentTimelineItem[]): PlanItem[] {
  return timeline.filter(
    (item): item is PlanItem =>
      item.type === "tool_call" &&
      item.detail.type === "plan" &&
      item.status === "completed" &&
      !item.error &&
      (item.metadata?.approved === true || Boolean(planResolution(item))),
  );
}

function latestPlanItem(timeline: readonly AgentTimelineItem[]): PlanItem | undefined {
  return timeline.findLast(
    (item): item is PlanItem => item.type === "tool_call" && item.detail.type === "plan",
  );
}

function recoverApprovedPlan(workflow: Workflow, latest: PlanItem | undefined): boolean {
  if (
    !latest ||
    latest.detail.type !== "plan" ||
    latest.status !== "completed" ||
    latest.error ||
    latest.metadata?.approved !== true ||
    planResolution(latest)?.behavior !== "allow" ||
    workflow.plans[latest.callId]
  )
    return false;
  const syntheticPermissionId = latest.metadata?.syntheticPermissionId;
  const synthetic = typeof syntheticPermissionId === "string";
  if (synthetic && latest.metadata?.approvalOutcome !== "completed") return false;
  workflow.plans[latest.callId] = {
    context: {
      workspaceId: workflow.workspaceId,
      agentId: workflow.plannerId,
      ...(synthetic ? { permissionRequestId: syntheticPermissionId } : {}),
      callId: latest.callId,
      text: latest.detail.text,
    },
    approved: true,
  };
  workflow.activePlanId = latest.callId;
  return true;
}

function closeConsumedOperations(
  workflow: Workflow,
  plan: Workflow["plans"][string],
  item: PlanItem,
  latest: PlanItem | undefined,
): boolean {
  if (item !== latest) return false;
  let changed = false;
  for (const [action, operation] of [
    ["review", plan.review],
    ["handoff", plan.handoff],
  ] as const) {
    if (operation?.phase === "closing" && isClosureDecision(workflow, plan, item, action)) {
      operation.phase = "closed";
      changed = true;
    }
  }
  return changed;
}

function isClosureDecision(
  workflow: Workflow,
  plan: Workflow["plans"][string],
  item: PlanItem | undefined,
  action: "review" | "handoff",
): boolean {
  if (!item || item.callId !== plan.context.callId || item.detail.type !== "plan") return false;
  const resolution = planResolution(item);
  return (
    item.status === "completed" &&
    !item.error &&
    item.detail.text === plan.context.text &&
    item.metadata?.approved === false &&
    resolution?.behavior === "deny" &&
    resolution.interrupt === true &&
    resolution.message === closureMessage(workflow, plan.context, action) &&
    (typeof item.metadata?.syntheticPermissionId !== "string" ||
      (item.metadata.syntheticPermissionId === plan.context.permissionRequestId &&
        item.metadata?.approvalOutcome === "completed"))
  );
}

function isResumingClosedHandoff(
  workflow: Workflow,
  plan: Workflow["plans"][string] | undefined,
  latest: PlanItem | undefined,
): boolean {
  const closed = plan?.handoff?.phase === "closed";
  if (closed && plan && !isClosureDecision(workflow, plan, latest, "handoff"))
    throw new Error("This handoff was superseded by a newer plan.");
  return closed;
}

function applyPlanDecision(
  workflow: Workflow,
  plan: Workflow["plans"][string],
  item: PlanItem,
  latest: PlanItem | undefined,
): boolean {
  let changed = closeConsumedOperations(workflow, plan, item, latest);
  if (item.metadata?.approved === true && !plan.approved) {
    plan.approved = true;
    if (item === latest) workflow.activePlanId = item.callId;
    changed = true;
  }
  if (item.metadata?.syntheticPermissionId && item.metadata.approvalOutcome !== "completed") {
    if (plan.verification !== UNCONFIRMED_APPROVAL) {
      plan.verification = UNCONFIRMED_APPROVAL;
      changed = true;
    }
  } else if (plan.verification === UNCONFIRMED_APPROVAL) {
    delete plan.verification;
    changed = true;
  }
  return changed;
}

function handoffPrompt(workflow: Workflow | undefined, agentId: string) {
  if (!workflow) return undefined;
  const plan = Object.values(workflow.plans).find(
    (entry) =>
      entry.handoff?.agentId === agentId &&
      (entry.handoff.phase === "running" || entry.handoff.phase === "outcome_unknown"),
  );
  return plan ? `workflow:${workflow.id}:handoff:${plan.context.callId}:prompt` : undefined;
}

function reviewerPrompt(workflow: Workflow | undefined, agentId: string) {
  if (!workflow) return undefined;
  const plan = Object.values(workflow.plans).find(
    (entry) => entry.review?.agentId === agentId && entry.review.phase === "running",
  );
  return plan ? `workflow:${workflow.id}:review:${plan.context.callId}:prompt` : undefined;
}

function finalCandidates(final: FinalReview): string[] {
  if (final.phase === "auditing")
    return Object.values(final.audits)
      .filter((audit) => !audit.result)
      .map((audit) => audit.agentId);
  if (final.phase === "delta" && final.deltaId) return [final.deltaId];
  return ["classifying", "deciding", "correcting", "committing"].includes(final.phase)
    ? [final.managerId]
    : [];
}

function planCandidates(plan: Workflow["plans"][string]): string[] {
  const candidates: string[] = [];
  if (
    (plan.handoff?.phase === "running" || plan.handoff?.phase === "outcome_unknown") &&
    plan.handoff.agentId &&
    !plan.final
  )
    candidates.push(plan.handoff.agentId);
  if (plan.review?.phase === "running" && plan.review.agentId) candidates.push(plan.review.agentId);
  if (plan.final) candidates.push(...finalCandidates(plan.final));
  return candidates;
}

export class WorkflowController {
  private queue: Promise<unknown> = Promise.resolve();
  private jobs = new Map<string, Promise<void>>();
  private routingControllers = new Set<AbortController>();
  private runningRoutingAttempts = new Set<string>();
  private rescheduled = new Set<string>();
  private disposed = false;
  constructor(private readonly port: WorkflowPort) {}

  dispose() {
    this.disposed = true;
    for (const controller of this.routingControllers) controller.abort();
  }

  async planRequested(context: PlanContext, automaticReview = true) {
    const automatic = await this.serial(async () => {
      const agent = automaticReview
        ? await this.pending(context)
        : await this.port.agent(context.agentId);
      const state = await this.port.read();
      const workflow = await this.workflow(state, agent);
      const previous = workflow.plans[context.callId];
      if (previous && !samePlan(previous.context, context))
        throw new Error("Plan calls are append-only. Submit a new call ID.");
      workflow.plans[context.callId] ??= { context };
      await this.port.write(state);
      return (
        automaticReview &&
        !Object.values(workflow.plans).some((plan) => plan.review?.source === "automatic")
      );
    });
    if (automatic) await this.review(context, "automatic");
  }

  approved(agentId: string, requestId: string) {
    return this.serial(async () => {
      const agent = await this.port.agent(agentId);
      const state = await this.port.read();
      const workflow = state.workflows[agent.labels["paseo.workflow.id"] ?? agent.id];
      if (!workflow || workflow.plannerId !== agentId) return;
      const plan = Object.values(workflow.plans).find(
        (candidate) => candidate.context.permissionRequestId === requestId,
      );
      // Permission events include ordinary tools, which never select the approved plan.
      if (!plan) return;
      plan.approved = true;
      plan.handoffRequested = false;
      workflow.activePlanId = plan.context.callId;
      await this.port.write(state);
      await this.reconcile(state, workflow);
    });
  }

  prepareHandoff(context: StoredPlanContext) {
    return this.serial(async () => {
      const agent = await this.available(context);
      const state = await this.port.read();
      const workflow = await this.workflow(state, agent);
      const previous = workflow.plans[context.callId];
      if (previous && !samePlan(previous.context, context))
        throw new Error("Plan calls are append-only.");
      workflow.plans[context.callId] ??= { context };
      const plan = workflow.plans[context.callId];
      if (context.permissionRequestId)
        plan.context.permissionRequestId = context.permissionRequestId;
      if (plan.review || plan.approved)
        throw new Error("This plan is already reviewed or approved.");
      workflow.preparedPlanId = context.callId;
      if (!plan.routing) {
        await this.refreshPlannerTranscript(state, workflow);
        plan.routing = { attempt: 1, phase: "running", promptStarted: false };
      }
      await this.port.write(state);
      this.schedule(workflow.id, context.callId);
      return { recommendation: workflow.recommendation };
    });
  }

  enqueueHandoff(context: PlanContext) {
    return this.serial(async () => {
      const state = await this.port.read();
      const agent = await this.port.agent(context.agentId);
      const workflow = await this.workflow(state, agent);
      const previous = workflow.plans[context.callId];
      if (previous && !samePlan(previous.context, context))
        throw new Error("This plan context does not match the recorded plan.");
      if (previous?.handoff && previous.handoff.phase !== "closed")
        return { handoffRequested: true };
      if (previous?.handoff?.phase === "closed")
        isResumingClosedHandoff(
          workflow,
          previous,
          latestPlanItem(await this.port.timeline(context.agentId)),
        );
      else await this.available(context);
      if (previous?.review || previous?.approved)
        throw new Error("This plan is already reviewed or approved.");
      const plan = previous ?? (workflow.plans[context.callId] = { context });
      plan.context = context;
      plan.handoffRequested = true;
      workflow.preparedPlanId = context.callId;
      if (!plan.routing || plan.routing.phase === "failed")
        plan.routing = {
          attempt: (plan.routing?.attempt ?? 0) + 1,
          phase: "running",
          promptStarted: false,
        };
      else if (plan.routing.phase === "complete") delete plan.routing.error;
      await this.port.write(state);
      this.schedule(workflow.id, context.callId);
      return { handoffRequested: true };
    });
  }

  /** Classifies the final plan and persists the fixed execution route. */
  private schedule(workflowId: string, callId: string) {
    const key = `${workflowId}:${callId}`;
    if (this.disposed) return;
    if (this.jobs.has(key)) {
      this.rescheduled.add(key);
      return;
    }
    const job = this.runRouting(workflowId, callId)
      .catch(() => undefined)
      .finally(() => {
        this.jobs.delete(key);
        if (this.rescheduled.delete(key)) this.schedule(workflowId, callId);
      });
    this.jobs.set(key, job);
  }

  private async routingSnapshot(workflowId: string, callId: string) {
    return this.serial(async () => {
      if (this.disposed) return undefined;
      const workflow = (await this.port.read()).workflows[workflowId];
      const plan = workflow?.plans[callId];
      return workflow && plan ? { workflow, plan } : undefined;
    });
  }

  private async updateRouting(
    workflowId: string,
    callId: string,
    attempt: number,
    update: Partial<Routing>,
  ) {
    return this.serial(async () => {
      if (this.disposed) return false;
      const state = await this.port.read();
      const routing = state.workflows[workflowId]?.plans[callId]?.routing;
      if (!routing || routing.attempt !== attempt) return false;
      Object.assign(routing, update);
      if ("error" in update && update.error === undefined) delete routing.error;
      await this.port.write(state);
      return true;
    });
  }

  private async runRouting(workflowId: string, callId: string) {
    const snapshot = await this.routingSnapshot(workflowId, callId);
    if (!snapshot) return;
    const { workflow, plan } = snapshot;
    const routing = plan.routing;
    if (!routing || routing.phase === "failed") return;
    if (routing.phase === "outcome_unknown") return;
    const update = (change: Partial<Routing>) =>
      this.updateRouting(workflowId, callId, routing.attempt, change);
    if (routing.phase !== "complete") {
      if (routing.promptStarted) {
        await this.failRouting(
          workflowId,
          callId,
          routing.attempt,
          "La classification JEV a été interrompue. Relancez le handoff explicitement.",
        );
        return;
      }
      try {
        if (!(await update({ promptStarted: true }))) return;
        const controller = new AbortController();
        const attemptKey = `${workflowId}:${callId}:${routing.attempt}`;
        this.routingControllers.add(controller);
        this.runningRoutingAttempts.add(attemptKey);
        let decision: ExecutionDecision;
        try {
          decision = await this.port.classify(
            briefing(workflow, plan.context.text),
            controller.signal,
          );
        } finally {
          this.routingControllers.delete(controller);
          this.runningRoutingAttempts.delete(attemptKey);
        }
        const cwd = (await this.port.workspace(workflow.workspaceId)).cwd;
        await this.executionModel(decision, cwd);
        if (!(await update({ phase: "complete", decision, error: undefined }))) return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.failRouting(
          workflowId,
          callId,
          routing.attempt,
          `${message} Le plan reste disponible pour une relance explicite.`,
        );
        return;
      }
    }
    await this.finishQueuedHandoff(workflowId, callId);
  }

  private async failRouting(workflowId: string, callId: string, attempt: number, error: string) {
    return this.serial(async () => {
      if (this.disposed) return false;
      const state = await this.port.read();
      const plan = state.workflows[workflowId]?.plans[callId];
      if (!plan?.routing || plan.routing.attempt !== attempt) return false;
      plan.routing.phase = "failed";
      plan.routing.error = error;
      plan.handoffRequested = false;
      await this.port.write(state);
      return true;
    });
  }

  private async finishQueuedHandoff(workflowId: string, callId: string) {
    const current = await this.routingSnapshot(workflowId, callId);
    if (
      !current?.plan.handoffRequested ||
      (current.plan.handoff && current.plan.handoff.phase !== "closed") ||
      this.disposed
    )
      return;
    try {
      await this.handoff(actionContext(current.plan.context));
    } catch (error) {
      await this.serial(async () => {
        if (this.disposed) return;
        const state = await this.port.read();
        const pending = state.workflows[workflowId]?.plans[callId];
        if (!pending) return;
        pending.handoffRequested = false;
        if (pending.routing)
          pending.routing.error = error instanceof Error ? error.message : String(error);
        await this.port.write(state);
      });
    }
  }

  private async executionModel(decision: ExecutionDecision, cwd: string) {
    const model = (await this.port.models(decision.provider, cwd)).find(
      (entry) => entry.id === decision.model,
    );
    if (!model?.thinkingOptions?.some((option) => option.id === decision.effort))
      throw new Error(
        `The provider does not expose ${decision.model}/${decision.effort}. Update the provider and retry.`,
      );
  }

  status(agentId: string, workspaceId: string) {
    return this.serial(async () => {
      const agent = await this.port.agent(agentId);
      if (agent.workspaceId !== workspaceId)
        throw new Error("The agent belongs to another workspace.");
      const state = await this.port.read();
      let workflow = state.workflows[agent.labels["paseo.workflow.id"] ?? agent.id];
      if (
        !workflow &&
        agent.launchProfileId === profileId("router") &&
        (await this.port.timeline(agent.id)).some((item) => item.type === "user_message")
      ) {
        workflow = await this.workflow(state, agent);
        await this.port.write(state);
      }
      if (workflow) await this.reconcile(state, workflow);
      return this.statusView(workflow);
    });
  }

  private statusView(workflow: Workflow | undefined) {
    const prepared = workflow?.preparedPlanId ? workflow.plans[workflow.preparedPlanId] : undefined;
    return {
      plan: prepared?.context.permissionRequestId ? actionContext(prepared.context) : null,
      recommendation: workflow?.recommendation ?? null,
      routing: prepared?.routing ?? null,
      handoffRequested: prepared?.handoffRequested ?? false,
      handoff: prepared?.handoff ?? null,
      verification: Object.values(workflow?.plans ?? {})
        .filter((plan) => plan.verification)
        .map((plan) => ({
          planId: plan.context.callId,
          phase: "verification_required" as const,
          reason: plan.verification!,
        })),
      reviews: Object.values(workflow?.plans ?? {})
        .filter((plan) => plan.final)
        .map((plan) => ({
          planId: plan.context.callId,
          phase: plan.final!.phase,
          reason: plan.final!.reason ?? null,
          managerId: plan.final!.managerId,
        })),
    };
  }
  handoff(context: PlanContext) {
    return this.serial(async () => {
      const state = await this.port.read();
      const agent = await this.port.agent(context.agentId);
      const workflow = await this.workflow(state, agent);
      const latestPlan = await this.reconcilePlanTimeline(state, workflow);
      const previous = workflow.plans[context.callId];
      if (previous && !samePlan(previous.context, context))
        throw new Error("This plan context does not match the recorded plan.");
      if (previous?.handoff?.phase === "running") return { agentId: previous.handoff.agentId! };
      if (previous?.handoff?.phase === "outcome_unknown" && previous.handoff.agentId)
        return { agentId: previous.handoff.agentId };
      const resumingClosed = isResumingClosedHandoff(workflow, previous, latestPlan);
      await this.refreshPlannerTranscript(state, workflow);
      const plan = previous ?? (workflow.plans[context.callId] = { context });
      if (plan.handoff?.phase !== "closed") await this.available(context);
      if (plan.review || plan.approved)
        throw new Error("This plan is already reviewed or approved.");
      const decision = plan.routing?.phase === "complete" ? plan.routing.decision : undefined;
      if (!decision)
        throw new Error(
          "Executor preparation is required. Use workflow.handoff.prepare and workflow.handoff.enqueue; this request never waits for classification.",
        );
      await this.executionModel(decision, (await this.port.workspace(workflow.workspaceId)).cwd);
      if (plan.handoff?.phase !== "closed") {
        await this.available(context);
        plan.context = context;
        plan.handoff = { phase: "closing" };
        await this.port.write(state);
        await this.port.respond(context.agentId, context.permissionRequestId, {
          behavior: "deny",
          interrupt: true,
          message: closureMessage(workflow, context, "handoff"),
        });
        plan.handoff.phase = "closed";
        await this.port.write(state);
      }
      return {
        agentId: await this.startHandoff(state, workflow, plan, decision, resumingClosed),
      };
    });
  }

  private async startHandoff(
    state: WorkflowState,
    workflow: Workflow,
    plan: Workflow["plans"][string],
    decision: ExecutionDecision,
    resume = false,
  ) {
    const handoff = plan.handoff!;
    if (!handoff.agentId && resume) {
      const record = latestPlanItem(await this.port.timeline(workflow.plannerId));
      if (!isClosureDecision(workflow, plan, record, "handoff"))
        throw new Error("This handoff was superseded by a newer plan.");
    }
    const cwd = (await this.port.workspace(workflow.workspaceId)).cwd;
    const model = (await this.port.models(decision.provider, cwd)).find(
      (entry) => entry.id === decision.model,
    );
    if (!model?.thinkingOptions?.some((option) => option.id === decision.effort))
      throw new Error(
        `The provider does not expose ${decision.model}/${decision.effort}. Update the provider and retry.`,
      );
    const executorId =
      handoff.agentId ??
      (await this.port.create({
        workspaceId: workflow.workspaceId,
        title: handoffPlanTitle(plan.context.text),
        idempotencyKey: `workflow:${workflow.id}:handoff:${plan.context.callId}`,
        config: {
          provider: `${decision.provider}/${decision.model}`,
          modeId: "auto",
          thinkingOptionId: decision.effort,
          writePolicy: "read_write",
        },
        labels: {
          "paseo.workflow.id": workflow.id,
          "paseo.workflow.plan": plan.context.callId,
          "paseo.workflow.role": `executor-${decision.category}`,
        },
      }));
    handoff.agentId = executorId;
    handoff.phase = "outcome_unknown";
    await this.port.write(state);
    try {
      await this.port.send(
        executorId,
        `/paseo-handoff\nPASEO_WORKFLOW_HANDOFF ${JSON.stringify({ mode: "receiver", workflowId: workflow.id, planId: plan.context.callId, role: `executor-${decision.category}` })}\nExecute the approved plan here without creating another agent. Follow its scope and explicit authorizations; handoff grants no additional permissions. Preserve pre-existing and concurrent changes. Run targeted validation and report results and blockers.\n${JSON.stringify({ plan: plan.context.text, git: workflow.git }, null, 2)}`,
        `workflow:${workflow.id}:handoff:${plan.context.callId}:prompt`,
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("agent_request_not_accepted")) {
        handoff.phase = "closed";
        await this.port.write(state);
      }
      throw error;
    }
    handoff.phase = "running";
    await this.port.write(state);
    return executorId;
  }
  finished(agentId: string, text: string, timeline: readonly AgentTimelineItem[] = []) {
    return this.serial(async () => {
      const agent = await this.port.agent(agentId);
      const state = await this.port.read();
      return this.finishNow(state, agent, text, timeline);
    });
  }

  private async finishNow(
    state: WorkflowState,
    agent: WorkflowAgent,
    text: string,
    timeline: readonly AgentTimelineItem[],
  ): Promise<boolean> {
    const agentId = agent.id;
    if (agent.launchProfileId === profileId("router"))
      return this.routerFinished(agent, state, text);
    const workflow = state.workflows[agent.labels["paseo.workflow.id"] ?? agent.id];
    if (!workflow) return false;
    const plan = workflow.plans[agent.labels["paseo.workflow.plan"] ?? workflow.activePlanId ?? ""];
    if (!plan) return false;
    if (
      (plan.handoff?.agentId === agentId &&
        (plan.handoff.phase === "running" || plan.handoff.phase === "outcome_unknown")) ||
      (workflow.plannerId === agentId && plan.approved)
    )
      return this.startFinal(state, workflow, plan);
    if (plan.review?.agentId === agentId) {
      if (plan.review.phase !== "running") return false;
      await this.reviewFinished(state, workflow, plan, text);
      return true;
    }
    return this.finalFinished(state, workflow, plan, agentId, text, timeline);
  }

  turnEnded(agentId: string, turnId: string | null) {
    return this.serial(async () => {
      if (!turnId) return;
      const state = await this.port.read();
      const agent = await this.port.agent(agentId);
      if (agent.labels["paseo.workflow.role"] === "execution-router") {
        this.schedule(agent.labels["paseo.workflow.id"], agent.labels["paseo.workflow.plan"]);
        return;
      }
      await this.consumeTurn(state, agent, turnId);
    });
  }

  private async consumeTurn(state: WorkflowState, agent: WorkflowAgent, turnId?: string) {
    const workflow = state.workflows[agent.labels["paseo.workflow.id"] ?? agent.id];
    const implementationPlan =
      workflow?.plannerId === agent.id ? workflow.plans[workflow.activePlanId ?? ""] : undefined;
    const reviewSource = reviewerPrompt(workflow, agent.id);
    const turn = await this.port.turn(
      agent.id,
      turnId,
      this.expectedPrompt(workflow, agent.id),
      implementationPlan?.approved ? implementationPlan.context.callId : undefined,
      reviewSource ?? handoffPrompt(workflow, agent.id),
    );
    if (!turn) return;
    if (workflow?.handledTurns?.[agent.id] === turn.key) return;
    const text = turn.items
      .filter((item) => item.type === "assistant_message")
      .map((item) => item.text)
      .join("");
    if (
      agent.launchProfileId === profileId("router") &&
      !text.trim().startsWith("{") &&
      !text.trim().startsWith("```")
    )
      return;
    if (!(await this.finishNow(state, agent, text, turn.items))) return;
    const current = state.workflows[agent.labels["paseo.workflow.id"] ?? agent.id];
    if (current) {
      (current.handledTurns ??= {})[agent.id] = turn.key;
      await this.port.write(state);
    }
  }

  private expectedPrompt(workflow: Workflow | undefined, agentId: string): string | undefined {
    if (!workflow) return undefined;
    for (const plan of Object.values(workflow.plans)) {
      const prefix = `workflow:${workflow.id}`;
      const callId = plan.context.callId;
      if (plan.review?.agentId === agentId) return undefined;
      const final = plan.final;
      if (!final) continue;
      if (final.deltaId === agentId) return `${prefix}:${callId}:delta:prompt`;
      for (const [role, audit] of Object.entries(final.audits)) {
        if (audit.agentId === agentId) return `${prefix}:${callId}:${role}:prompt`;
      }
      if (final.managerId !== agentId) continue;
      switch (final.phase) {
        case "classifying":
          return `${prefix}:final:${callId}:classify`;
        case "deciding":
          return `${prefix}:${callId}:correction-decision`;
        case "correcting":
          return `${prefix}:${callId}:correct`;
        case "committing":
          return `${prefix}:${callId}:correction-commit`;
        default:
          return undefined;
      }
    }
    return undefined;
  }

  private async reconcilePlanTimeline(state: WorkflowState, workflow: Workflow) {
    const timeline = await this.port.timeline(workflow.plannerId);
    const latest = latestPlanItem(timeline);
    const decisions = new Map(canonicalPlanItems(timeline).map((item) => [item.callId, item]));
    let changed = recoverApprovedPlan(workflow, latest);
    for (const plan of Object.values(workflow.plans)) {
      if (
        plan.handoffRequested &&
        !plan.handoff &&
        (plan.approved ||
          plan.review ||
          latest?.callId !== plan.context.callId ||
          latest.detail.type !== "plan" ||
          latest.detail.text !== plan.context.text ||
          planResolution(latest) ||
          latest.metadata?.approved !== undefined)
      ) {
        plan.handoffRequested = false;
        if (plan.routing)
          plan.routing.error =
            "Pending handoff canceled: the plan was replaced, resolved or reviewed.";
        changed = true;
      }
    }
    for (const item of decisions.values()) {
      const plan = workflow.plans[item.callId];
      if (!plan || item.detail.type !== "plan" || plan.context.text !== item.detail.text) continue;
      changed = applyPlanDecision(workflow, plan, item, latest) || changed;
    }
    if (changed) await this.port.write(state);
    return latest;
  }

  private async reconcile(state: WorkflowState, workflow: Workflow) {
    // One bounded pass over existing operations, never replay arbitrary agent history.
    const latestPlan = await this.reconcilePlanTimeline(state, workflow);
    const candidates = new Set<string>();
    if (
      !workflow.routed &&
      (await this.port.agent(workflow.routerId ?? workflow.plannerId)).launchProfileId ===
        profileId("router")
    )
      candidates.add(workflow.routerId ?? workflow.plannerId);
    const activePlan = workflow.plans[workflow.activePlanId ?? ""];
    if (activePlan?.approved && !activePlan.final) candidates.add(workflow.plannerId);
    for (const plan of Object.values(workflow.plans)) {
      await this.reconcileRouting(state, workflow, plan);
      await this.resumePlan(state, workflow, plan, latestPlan);
      if (
        plan.routing &&
        (plan.routing.phase === "running" ||
          (plan.routing.phase === "complete" &&
            plan.handoffRequested &&
            (!plan.handoff || plan.handoff.phase === "closed")))
      )
        this.schedule(workflow.id, plan.context.callId);
      for (const id of planCandidates(plan)) candidates.add(id);
    }
    for (const agentId of candidates) {
      await this.consumeTurn(state, await this.port.agent(agentId));
    }
  }

  private async reconcileRouting(
    state: WorkflowState,
    workflow: Workflow,
    plan: Workflow["plans"][string],
  ) {
    const routing = plan.routing;
    if (!routing) return;
    const legacy = routing.agentId && routing.phase !== "complete";
    const interrupted =
      routing.phase === "running" &&
      routing.promptStarted &&
      !this.runningRoutingAttempts.has(`${workflow.id}:${plan.context.callId}:${routing.attempt}`);
    if (!legacy && !interrupted) return;
    routing.phase = "failed";
    routing.error = legacy
      ? "Ancien classificateur Codex interrompu. Relancez le handoff explicitement."
      : "La classification JEV a été interrompue. Relancez le handoff explicitement.";
    plan.handoffRequested = false;
    await this.port.write(state);
  }

  private async resumePlan(
    state: WorkflowState,
    workflow: Workflow,
    plan: Workflow["plans"][string],
    latestPlan: PlanItem | undefined,
  ) {
    if (plan.review?.phase === "closed" && plan.review.agentId && plan.review.promptSent) {
      plan.review.phase = "running";
      await this.port.write(state);
    }
    if (
      plan.handoff?.phase === "closed" &&
      !plan.handoff.agentId &&
      isClosureDecision(workflow, plan, latestPlan, "handoff")
    ) {
      const decision = plan.routing?.decision;
      if (decision) await this.startHandoff(state, workflow, plan, decision, true);
    }
    if (plan.review?.phase === "complete")
      await this.port.claimReview(actionContext(plan.context), false);
  }

  private async finalFinished(
    state: WorkflowState,
    workflow: Workflow,
    plan: Workflow["plans"][string],
    agentId: string,
    text: string,
    timeline: readonly AgentTimelineItem[],
  ): Promise<boolean> {
    const final = plan.final;
    if (!final) return false;
    if (!workflow.git.targetBase) {
      final.phase = "verification_required";
      final.reason =
        "The audited target base is unavailable. Start a new workflow with an explicit remote default reference.";
      await this.port.write(state);
      return true;
    }
    if (final.phase === "auditing")
      return this.auditFinished(state, workflow, plan, agentId, text, final);
    if (final.phase === "delta" && final.deltaId === agentId) {
      await this.deltaFinished(state, workflow, plan, text, final);
      return true;
    }
    if (final.managerId !== agentId) return false;
    switch (final.phase) {
      case "classifying":
        await this.classifyFinal(state, workflow, plan, agentId, text);
        break;
      case "deciding":
        await this.decideCorrection(state, workflow, plan, agentId, text, final);
        break;
      case "correcting":
        await this.correctionFinished(state, workflow, plan, agentId, final, timeline);
        break;
      case "committing":
        await this.commitFinished(state, workflow, final);
        break;
      default:
        return false;
    }
    return true;
  }

  private async routerFinished(agent: WorkflowAgent, state: WorkflowState, text: string) {
    const workflow = await this.workflow(state, agent);
    if (workflow.routed) return false;
    await this.profile("router");
    const decision = routerDecision.parse(decisionJson(text));
    if (!decision.ready) return false;
    const request = requestFrom(await this.port.timeline(agent.id));
    if (!request)
      throw new Error("The original request is unavailable. Reopen the agent history and retry.");
    const planner = await this.profile("planner");
    workflow.routerId = agent.id;
    workflow.request = request;
    workflow.recommendation = decision.recommendation;
    workflow.constraints = decision.constraints;
    workflow.assumptions = decision.assumptions;
    await this.port.write(state);
    const plannerId = await this.port.create({
      workspaceId: workflow.workspaceId,
      launchProfileId: planner.id,
      idempotencyKey: `workflow:${workflow.id}:planner`,
      config: profileConfig(planner, false),
      labels: { "paseo.workflow.id": workflow.id, "paseo.workflow.role": "planner" },
    });
    await this.port.send(
      plannerId,
      `Plan the request interactively. Ask missing questions before producing a plan. Do not implement. Submit a plan for review and approval.\n${briefing(workflow, "")}`,
      `workflow:${workflow.id}:planner:prompt`,
    );
    workflow.plannerId = plannerId;
    workflow.routed = true;
    await this.port.write(state);
    return true;
  }

  private async startFinal(
    state: WorkflowState,
    workflow: Workflow,
    plan: Workflow["plans"][string],
  ) {
    if (plan.final) return false;
    const workspace = await this.port.workspace(workflow.workspaceId);
    // COMPAT(workflow-start-head): added in v0.8.0, remove after 2027-09-13.
    const startHead = workflow.git.startHead ?? workflow.git.base;
    const verify = async (reason: string) => {
      plan.verification = reason;
      await this.port.write(state);
      return true;
    };
    if (!startHead || !workflow.git.targetBase)
      return verify(
        "The target base cannot be resolved. Configure refs/remotes/origin/HEAD and start a new workflow; no audit or correction has run.",
      );
    const snapshot = await this.port.diff(workspace.cwd, workflow.git.targetBase);
    const progress = await this.port.diff(workspace.cwd, startHead);
    if (!progress.text.trim())
      return verify(
        "No reviewable tracked delta was confirmed after workflow start. Report the local result and validation evidence for manual verification; do not create a commit to satisfy the workflow.",
      );
    const manager = await this.profile("final-review");
    await this.refreshPlannerTranscript(state, workflow);
    const managerId = await this.port.create({
      workspaceId: workflow.workspaceId,
      launchProfileId: manager.id,
      idempotencyKey: `workflow:${workflow.id}:final:${plan.context.callId}`,
      config: profileConfig(manager, false),
      labels: {
        "paseo.workflow.id": workflow.id,
        "paseo.workflow.plan": plan.context.callId,
        "paseo.workflow.role": "final-review",
      },
    });
    await this.port.send(
      managerId,
      `Compare intention, request, plan, base and diff. The approved plan and explicit user authorization take precedence over generic workflow instructions; review grants no additional authorization to edit or commit. A validated uncommitted local result is valid when no commit was authorized. Do not edit, commit or delegate yet. Classify SIMPLE (local change), STRUCTURAL (architecture/contracts), or SENSITIVE (security, permissions, secrets, payments or external effects). Return only JSON {"classification":"SIMPLE|STRUCTURAL|SENSITIVE"}.\n${briefing(workflow, plan.context.text)}\nReviewed HEAD: ${snapshot.head}\nDiff (may include uncommitted changes):\n${snapshot.text}`,
      `workflow:${workflow.id}:final:${plan.context.callId}:classify`,
    );
    plan.final = {
      phase: "classifying",
      managerId,
      head: snapshot.head,
      diff: snapshot.text,
      dirtyFiles: snapshot.dirtyFiles,
      ambiguousWorkingTree: Boolean(
        workflow.git.dirty.trim() || snapshot.dirtyFiles.length || snapshot.untrackedFiles.length,
      ),
      audits: {},
    };
    delete plan.verification;
    await this.port.write(state);
    return true;
  }

  private async classifyFinal(
    state: WorkflowState,
    workflow: Workflow,
    plan: Workflow["plans"][string],
    agentId: string,
    text: string,
  ) {
    const final = plan.final!;
    const parsed = decisionJson(text);
    const level = classification.parse(
      typeof parsed === "object" && parsed !== null && "classification" in parsed
        ? parsed.classification
        : undefined,
    );
    const profiles = await Promise.all(auditorsFor(level).map((role) => this.profile(role)));
    for (const profile of profiles) {
      const role = profile.id.slice("paseo-workflow-".length);
      const id = await this.port.create({
        workspaceId: workflow.workspaceId,
        parent: agentId,
        launchProfileId: profile.id,
        idempotencyKey: `workflow:${workflow.id}:${plan.context.callId}:${role}`,
        config: profileConfig(profile, true),
        labels: {
          "paseo.workflow.id": workflow.id,
          "paseo.workflow.plan": plan.context.callId,
          "paseo.workflow.role": role,
        },
      });
      await this.port.send(
        id,
        `Audit ${role}. Read only; never edit, execute mutations, commit or delegate. Compare intention/request/plan/base/diff. Return only JSON {"findings":[{"summary":"...","files":["relative/path"],"certain":true,"local":true,"verifiable":true,"externalEffects":false}]}. Do not present assumptions as certain findings.\n${briefing(workflow, plan.context.text)}\nDiff:\n${final.diff}`,
        `workflow:${workflow.id}:${plan.context.callId}:${role}:prompt`,
      );
      final.audits[role] = { agentId: id };
    }
    final.classification = level;
    final.phase = "auditing";
    await this.port.write(state);
    return;
  }

  private async auditFinished(
    state: WorkflowState,
    workflow: Workflow,
    plan: Workflow["plans"][string],
    agentId: string,
    text: string,
    final: FinalReview,
  ) {
    const audit = Object.values(final.audits).find((entry) => entry.agentId === agentId);
    if (!audit || audit.result) return false;
    audit.result = auditDecision.parse(decisionJson(text));
    if (Object.values(final.audits).every((entry) => entry.result)) {
      const findings = Object.values(final.audits).flatMap((entry) => entry.result!.findings);
      if (findings.length === 0) {
        const workspace = await this.port.workspace(workflow.workspaceId);
        const current = await this.port.diff(workspace.cwd, workflow.git.targetBase!);
        const ambiguous =
          final.ambiguousWorkingTree ||
          workflow.git.dirty.trim() ||
          current.dirtyFiles.length ||
          current.untrackedFiles.length ||
          current.head !== final.head ||
          current.text !== final.diff;
        final.phase = ambiguous ? "verification_required" : "complete";
        if (ambiguous)
          final.reason =
            "The working tree cannot be attributed completely to this workflow (pre-existing changes, untracked files or a changed audited diff). Review it manually.";
        await this.port.send(
          final.managerId,
          ambiguous
            ? `Verification required: ${final.reason} Report this limit; do not edit or commit.`
            : "The audits found no defects. Report the review outcome. Do not edit or create another commit.",
          `workflow:${workflow.id}:${plan.context.callId}:final-report`,
        );
      } else {
        final.phase = "deciding";
        await this.port.send(
          final.managerId,
          `Evaluate these findings. Do not edit or commit yet. Return only JSON {"correct":true|false,"validationCommands":["exact targeted command"]}. Return correct:false if correction is outside the approved plan or explicit user authorization. Authorize correction only for certain, local, verifiable defects with no external effect; all other findings need user direction. Never modify pre-existing dirty files.\n${JSON.stringify({ findings, protectedFiles: final.dirtyFiles })}`,
          `workflow:${workflow.id}:${plan.context.callId}:correction-decision`,
        );
      }
    }
    await this.port.write(state);
    return true;
  }

  private async correctionBoundaryUnchanged(workflow: Workflow, final: FinalReview) {
    if (!workflow.git.targetBase) return false;
    const workspace = await this.port.workspace(workflow.workspaceId);
    const current = await this.port.diff(workspace.cwd, workflow.git.targetBase);
    return (
      current.head === final.head &&
      current.text === final.diff &&
      current.dirtyFiles.length === 0 &&
      current.untrackedFiles.length === 0
    );
  }

  private async decideCorrection(
    state: WorkflowState,
    workflow: Workflow,
    plan: Workflow["plans"][string],
    agentId: string,
    text: string,
    final: FinalReview,
  ) {
    const decision = correctionDecision.parse(decisionJson(text));
    const findings = Object.values(final.audits).flatMap((entry) => entry.result!.findings);
    const safe = findings.every(
      (finding) =>
        finding.certain &&
        finding.local &&
        finding.verifiable &&
        !finding.externalEffects &&
        finding.files.every((file) => !final.dirtyFiles.includes(file)),
    );
    if (
      !decision.correct ||
      !safe ||
      decision.validationCommands.length === 0 ||
      final.dirtyFiles.length > 0 ||
      workflow.git.dirty.trim() ||
      !(await this.correctionBoundaryUnchanged(workflow, final))
    ) {
      final.phase = "verification_required";
      final.reason =
        "The findings or current HEAD/diff/status do not match the audited correction boundary. Review them manually; no correction was started.";
    } else {
      final.validationCommands = decision.validationCommands;
      final.phase = "correcting";
      await this.port.send(
        agentId,
        `Correct only the agreed certain/local/verifiable defects. You are the only writer. Preserve all pre-existing dirty files. Do not commit, delegate, push, merge, deploy or cause external effects. Run these targeted validations through your normal agent tools and permissions, then report. Do not run a full suite.\n${JSON.stringify({ findings, validationCommands: decision.validationCommands, protectedFiles: final.dirtyFiles })}`,
        `workflow:${workflow.id}:${plan.context.callId}:correct`,
      );
    }
    await this.port.write(state);
    return;
  }

  private async correctionFinished(
    state: WorkflowState,
    workflow: Workflow,
    plan: Workflow["plans"][string],
    agentId: string,
    final: FinalReview,
    timeline: readonly AgentTimelineItem[],
  ) {
    // Any later tool can invalidate a successful check. Fail closed instead of interpreting commands.
    const checks = timeline
      .filter((item) => item.type === "tool_call")
      .slice(-(final.validationCommands?.length ?? 0));
    const verified = final.validationCommands?.every((command) =>
      checks.some(
        (item) =>
          item.status === "completed" &&
          !item.error &&
          item.detail.type === "shell" &&
          item.detail.command === command &&
          item.detail.exitCode === 0,
      ),
    );
    const allowedFiles = new Set(
      Object.values(final.audits).flatMap((audit) =>
        audit.result!.findings.flatMap((finding) => finding.files),
      ),
    );
    const workspace = await this.port.workspace(workflow.workspaceId);
    const snapshot = await this.port.diff(workspace.cwd, final.head);
    if (
      !verified ||
      snapshot.head !== final.head ||
      !snapshot.text.trim() ||
      snapshot.untrackedFiles.length > 0 ||
      snapshot.dirtyFiles.some((file) => !allowedFiles.has(file))
    ) {
      final.phase = "verification_required";
      final.reason =
        "Successful final targeted tool evidence and a delta confined to the agreed files are required. No automatic second commit.";
    } else {
      final.phase = "delta";
      final.correctionDiff = snapshot.text;
      const auditor = await this.profile(
        final.classification === "SIMPLE" ? "audit-economic" : "audit-deep",
      );
      const deltaId = await this.port.create({
        workspaceId: workflow.workspaceId,
        parent: agentId,
        launchProfileId: auditor.id,
        idempotencyKey: `workflow:${workflow.id}:${plan.context.callId}:delta`,
        config: profileConfig(auditor, true),
        labels: {
          "paseo.workflow.id": workflow.id,
          "paseo.workflow.plan": plan.context.callId,
          "paseo.workflow.role": "delta-review",
        },
      });
      await this.port.send(
        deltaId,
        `Read-only review of the corrected delta, once. Never edit or commit. Return the same findings JSON as an audit.\n${snapshot.text}`,
        `workflow:${workflow.id}:${plan.context.callId}:delta:prompt`,
      );
      final.deltaId = deltaId;
    }
    await this.port.write(state);
    return;
  }

  private async deltaFinished(
    state: WorkflowState,
    workflow: Workflow,
    plan: Workflow["plans"][string],
    text: string,
    final: FinalReview,
  ) {
    const result = auditDecision.parse(decisionJson(text));
    const workspace = await this.port.workspace(workflow.workspaceId);
    const snapshot = await this.port.diff(workspace.cwd, final.head);
    const allowedFiles = new Set(
      Object.values(final.audits).flatMap((audit) =>
        audit.result!.findings.flatMap((finding) => finding.files),
      ),
    );
    if (
      result.findings.length > 0 ||
      snapshot.head !== final.head ||
      snapshot.text !== final.correctionDiff ||
      snapshot.untrackedFiles.length > 0 ||
      snapshot.dirtyFiles.some((file) => !allowedFiles.has(file))
    ) {
      final.phase = "verification_required";
      final.reason =
        "The single corrected-delta review found a defect or the verified delta changed. Review manually; no automatic commit.";
    } else {
      await this.port.send(
        final.managerId,
        "Create the correction commit for exactly the verified delta only if the approved plan or explicit user authorization permits that commit. Otherwise leave the validated delta uncommitted and report the local result; workflow review does not authorize a commit. Stage explicit files/hunks only when committing is authorized; preserve concurrent and unrelated edits. Recheck HEAD and diff before committing and stop if they changed. Never push, merge or deploy. Report the result and checks.",
        `workflow:${workflow.id}:${plan.context.callId}:correction-commit`,
      );
      final.phase = "committing";
    }
    await this.port.write(state);
    return;
  }

  private async commitFinished(state: WorkflowState, workflow: Workflow, final: FinalReview) {
    const workspace = await this.port.workspace(workflow.workspaceId);
    const snapshot = await this.port.diff(workspace.cwd, final.head);
    const allowedFiles = new Set(
      Object.values(final.audits).flatMap((audit) =>
        audit.result!.findings.flatMap((finding) => finding.files),
      ),
    );
    const finalized =
      snapshot.head === final.head
        ? snapshot.dirtyFiles.every((file) => allowedFiles.has(file))
        : snapshot.dirtyFiles.length === 0 &&
          (await this.port.commitCount(workspace.cwd, final.head)) === 1;
    if (
      snapshot.text === final.correctionDiff &&
      snapshot.untrackedFiles.length === 0 &&
      finalized
    ) {
      final.phase = "complete";
    } else {
      final.phase = "verification_required";
      final.reason =
        "The local correction result could not be confirmed against the verified delta.";
    }
    await this.port.write(state);
    return;
  }

  private async reviewFinished(
    state: WorkflowState,
    workflow: Workflow,
    plan: Workflow["plans"][string],
    text: string,
  ) {
    const current = (await this.port.timeline(workflow.plannerId)).findLast(
      (item) => item.type === "tool_call" && item.detail.type === "plan",
    );
    if (
      plan.approved ||
      current?.type !== "tool_call" ||
      current.callId !== plan.context.callId ||
      current.metadata?.approved === true ||
      (current.detail.type === "plan" && current.detail.text !== plan.context.text)
    ) {
      plan.review!.phase = "complete";
      plan.review!.superseded = true;
      await this.port.write(state);
      await this.port.claimReview(actionContext(plan.context), false);
      return;
    }
    if (!text.trim())
      throw new Error(
        "The review returned no objections or conclusion. Open the reviewer and retry.",
      );
    const accepted = await this.port.revise(
      actionContext(plan.context),
      `Revise the plan using these objections. Produce a new plan call; never rewrite the previous plan. Stay in planning, do not implement.\n${briefing(workflow, plan.context.text)}\nReview:\n${text}`,
      `workflow:${workflow.id}:revision:${plan.context.callId}`,
    );
    plan.review!.phase = "complete";
    if (!accepted) plan.review!.superseded = true;
    await this.port.write(state);
    await this.port.claimReview(actionContext(plan.context), false);
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    // ponytail: one queue per plugin; split by workflow if concurrent launches become a bottleneck.
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async profile(role: Role): Promise<AgentProfile> {
    const id = profileId(role);
    const profile = (await this.port.profiles()).find((entry) => entry.id === id);
    if (!profile)
      throw new Error(
        `Profile '${id}' is missing. Open Workflow settings and choose Install / repair profiles.`,
      );
    return profile;
  }

  private async pending(context: PlanContext, requirePlanner = true): Promise<WorkflowAgent> {
    const agent = await this.port.agent(context.agentId);
    if (agent.workspaceId !== context.workspaceId)
      throw new Error("This plan belongs to another workspace.");
    const permission = agent.pendingPermissions.find(
      (entry) =>
        entry.id === context.permissionRequestId &&
        entry.sourcePlanCallId === context.callId &&
        entry.kind === "plan",
    );
    if (!permission) throw new Error("This plan is no longer pending. Open the current plan.");
    const text = permission.input?.plan ?? permission.metadata?.planText;
    if (text !== context.text) throw new Error("The plan text changed. Open the current plan.");
    if (requirePlanner && agent.launchProfileId !== profileId("planner"))
      throw new Error("This agent was not launched with the workflow planner profile.");
    if (requirePlanner) await this.profile("planner");
    return agent;
  }

  private async available(context: StoredPlanContext): Promise<WorkflowAgent> {
    const agent = context.permissionRequestId
      ? await this.pending(actionContext(context), false)
      : await this.port.agent(context.agentId);
    if (agent.workspaceId !== context.workspaceId)
      throw new Error("This plan belongs to another workspace.");
    const latest = latestPlanItem(await this.port.timeline(context.agentId));
    if (
      !latest ||
      latest.callId !== context.callId ||
      latest.detail.type !== "plan" ||
      latest.detail.text !== context.text
    )
      throw new Error("This plan was superseded or its text changed. Open the current plan.");
    if (
      latest.error ||
      planResolution(latest) ||
      latest.metadata?.approved !== undefined ||
      latest.metadata?.reviewClaim
    )
      throw new Error("This plan is already resolved or being reviewed.");
    if (
      !context.permissionRequestId &&
      (latest.status !== "completed" || agent.status !== "idle" || !context.text.trim())
    )
      throw new Error("Wait for the complete actionable plan before preparing handoff.");
    return agent;
  }

  private async workflow(state: WorkflowState, agent: WorkflowAgent): Promise<Workflow> {
    const id = agent.labels["paseo.workflow.id"] ?? agent.id;
    const existing = state.workflows[id];
    if (existing) return existing;
    if (!agent.workspaceId) throw new Error("The agent has no workspace.");
    const workspace = await this.port.workspace(agent.workspaceId);
    const timeline = await this.port.timeline(agent.id);
    const request = requestFrom(timeline);
    if (!request)
      throw new Error("The original request is unavailable. Reopen the agent history and retry.");
    const workflow: Workflow = {
      id,
      workspaceId: agent.workspaceId,
      plannerId: agent.id,
      intent: workspace.intent ?? "",
      request,
      constraints: [],
      assumptions: [],
      git: await this.port.git(workspace.cwd),
      recommendation: null,
      plans: {},
    };
    state.workflows[id] = workflow;
    return workflow;
  }

  private async refreshPlannerTranscript(state: WorkflowState, workflow: Workflow) {
    const timeline = await this.port.timeline(workflow.plannerId, "projected");
    // Reuse the host's message/chunk projection; preserve exchanges without inferring authority.
    const transcript: NonNullable<Workflow["plannerTranscript"]> = [];
    for (const item of timeline) {
      if (item.type === "user_message" && !item.clientMessageId?.startsWith("workflow:"))
        transcript.push({ role: "user", text: item.text });
      if (item.type === "assistant_message")
        transcript.push({ role: "assistant", text: item.text });
      if (
        item.type === "tool_call" &&
        (item.name === "request_user_input" || item.name === "request_user_input_async") &&
        item.detail.type === "plain_text"
      )
        transcript.push({
          role: "assistant",
          text: `[${item.name} (${item.status})]\n${item.detail.text}`,
        });
    }
    workflow.plannerTranscript = transcript;
    await this.port.write(state);
  }

  review(context: PlanContext, source: "automatic" | "manual") {
    return this.serial(async () => {
      const state = await this.port.read();
      const agent = await this.port.agent(context.agentId);
      const workflow = await this.workflow(state, agent);
      await this.reconcilePlanTimeline(state, workflow);
      const previous = workflow.plans[context.callId];
      if (previous && !samePlan(previous.context, context))
        throw new Error("This plan context does not match the recorded plan.");
      if (previous?.review?.phase === "running" || previous?.review?.phase === "complete")
        return { agentId: previous.review.agentId! };
      if (previous?.review?.phase === "outcome_unknown")
        throw new Error(
          "Reviewer delivery outcome_unknown. Open the reviewer to inspect it; automatic retry is disabled.",
        );
      const reviewer = await this.profile("plan-reviewer");
      await this.refreshPlannerTranscript(state, workflow);
      if (
        Object.values(workflow.plans).some(
          (plan) => plan !== previous && plan.review?.source === source,
        )
      )
        throw new Error(`The ${source} plan review has already been used.`);
      const plan = previous ?? (workflow.plans[context.callId] = { context });
      plan.handoffRequested = false;
      if (plan.review?.phase !== "closed") {
        await this.pending(context);
        await this.port.claimReview(context, true);
      }
      plan.review ??= { source, phase: "closing" };
      await this.port.write(state);
      const childId =
        plan.review.agentId ??
        (await this.port.create({
          workspaceId: workflow.workspaceId,
          parent: context.agentId,
          launchProfileId: reviewer.id,
          idempotencyKey: `workflow:${workflow.id}:review:${context.callId}`,
          config: profileConfig(reviewer, true),
          labels: {
            "paseo.workflow.id": workflow.id,
            "paseo.workflow.plan": context.callId,
            "paseo.workflow.role": "plan-reviewer",
          },
        }));
      plan.review!.agentId = childId;
      await this.port.write(state);
      await this.sendReviewPrompt(state, workflow, plan);
      if (plan.review.phase !== "closed") {
        await this.pending(context);
        await this.port.respond(context.agentId, context.permissionRequestId, {
          behavior: "deny",
          interrupt: true,
          message: closureMessage(workflow, context, "review"),
        });
        plan.review.phase = "closed";
        await this.port.write(state);
      }
      plan.review!.phase = "running";
      await this.port.write(state);
      await this.consumeTurn(state, await this.port.agent(childId));
      return { agentId: childId };
    });
  }

  private async sendReviewPrompt(
    state: WorkflowState,
    workflow: Workflow,
    plan: Workflow["plans"][string],
  ) {
    const review = plan.review!;
    if (review.promptSent) return;
    const childId = review.agentId!;
    try {
      await this.port.send(
        childId,
        `Review this plan. Report objections, omissions, contradictions and assumptions. Do not edit, execute, commit, or delegate.\n${briefing(workflow, plan.context.text)}`,
        `workflow:${workflow.id}:review:${plan.context.callId}:prompt`,
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("agent_request_not_accepted"))
        throw error;
      review.phase = "outcome_unknown";
      await this.port.write(state);
      throw new Error(
        `Reviewer delivery outcome_unknown. Open reviewer ${childId} to inspect it; automatic retry is disabled.`,
        { cause: error },
      );
    }
    review.promptSent = true;
    await this.port.write(state);
  }
}
