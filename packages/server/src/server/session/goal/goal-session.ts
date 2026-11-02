import type pino from "pino";
import { toGoalSummary } from "@getpaseo/protocol/goal/progress";
import { CLIENT_CAPS, type ClientCapability } from "@getpaseo/protocol/client-capabilities";
import { capText, interventionClass } from "@getpaseo/protocol/goal/interventions";
import type {
  Goal,
  GoalEvent,
  GoalSummary,
  Guidance,
  GuidanceChanges,
} from "@getpaseo/protocol/goal/types";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { GoalService, GuidanceInput } from "../../goal/goal-service.js";

export interface GoalSessionHost {
  emit(msg: SessionOutboundMessage): void;
  /** Whether the client parses the event types added with goal controls. Assumed when absent. */
  supportsGoalControlEvents?(): boolean;
  /** Whether the client parses goal.acknowledged. Assumed when absent. */
  supportsGoalAcknowledgeEvents?(): boolean;
  /** Whether the client parses the goal management events. Assumed when absent. */
  supportsGoalManagementEvents?(): boolean;
  /** Whether the client parses config edits and the "auto" policy. Assumed when absent. */
  supportsGoalConfigEdit?(): boolean;
  /** Whether the client shows the usage breakdown. Assumed when absent. */
  supportsGoalUsageBreakdown?(): boolean;
  /** Whether the client parses changeset.integration_retried. Assumed when absent. */
  supportsGoalIntegrationRetry?(): boolean;
  /** Whether the client parses the plan.revision_* events. Assumed when absent. */
  supportsGoalPlanRevision?(): boolean;
  /** Whether the client parses the intervention.* events. Assumed when absent. */
  supportsGoalLeadInterventions?(): boolean;
  /** Whether the client parses the recovery.* events. Assumed when absent. */
  supportsGoalRecovery?(): boolean;
  /** Whether the client parses goal.accepted and the waived fields. Assumed when absent. */
  supportsGoalAccept?(): boolean;
  /** Whether the client parses the wait.* events. Assumed when absent. */
  supportsGoalUserWait?(): boolean;
}

// COMPAT(goalControlEvents): added in v0.13.0, remove after 2027-04-26.
const GOAL_CONTROL_EVENT_TYPES: ReadonlySet<string> = new Set([
  "goal.paused",
  "goal.resumed",
  "goal.retried",
  "usage.recorded",
]);

// COMPAT(goalAcknowledgeEvents): added in v0.13.0, remove after 2027-04-26.
const GOAL_ACKNOWLEDGE_EVENT_TYPES: ReadonlySet<string> = new Set(["goal.acknowledged"]);

// COMPAT(goalManagementEvents): added in v0.13.1, remove after 2027-04-26.
const GOAL_MANAGEMENT_EVENT_TYPES: ReadonlySet<string> = new Set([
  "goal.renamed",
  "goal.priority_set",
  "goal.archived",
  "goal.unarchived",
]);

// COMPAT(goalConfigEdit): added in v0.13.3, remove after 2027-04-27.
const GOAL_CONFIG_EDIT_EVENT_TYPES: ReadonlySet<string> = new Set([
  "goal.config_updated",
  "goal.reopened",
]);

// COMPAT(goalIntegrationRetry): added in v0.13.10, remove after 2027-04-27.
const GOAL_INTEGRATION_RETRY_EVENT_TYPES: ReadonlySet<string> = new Set([
  "changeset.integration_retried",
]);

// COMPAT(goalPlanRevision): added in v0.13.13, remove after 2027-04-28.
const GOAL_PLAN_REVISION_EVENT_TYPES: ReadonlySet<string> = new Set([
  "plan.revision_proposed",
  "plan.revision_approved",
  "plan.revision_rejected",
]);

// COMPAT(goalLeadInterventions): added in v0.13.13, remove after 2027-04-28.
const GOAL_LEAD_INTERVENTION_EVENT_TYPES: ReadonlySet<string> = new Set([
  "intervention.requested",
  "intervention.resolved",
]);

// COMPAT(goalRecovery): added in v0.13.13, remove after 2027-04-28.
const GOAL_RECOVERY_EVENT_TYPES: ReadonlySet<string> = new Set([
  "recovery.started",
  "recovery.decided",
  "recovery.resolved",
]);

// COMPAT(goalAccept): added in v0.13.14, remove after 2027-04-28.
const GOAL_ACCEPT_EVENT_TYPES: ReadonlySet<string> = new Set(["goal.accepted"]);

// COMPAT(goalUserWait): added in v0.13.14, remove after 2027-04-28.
const GOAL_USER_WAIT_EVENT_TYPES: ReadonlySet<string> = new Set(["wait.started", "wait.ended"]);

// COMPAT(goalUserWait): added in v0.13.14, remove after 2027-04-28.
function withoutUserWaitEvents(events: GoalEvent[], hide: boolean): GoalEvent[] {
  return hide ? events.filter((e) => !GOAL_USER_WAIT_EVENT_TYPES.has(e.type)) : events;
}

// COMPAT(goalAccept): added in v0.13.14, remove after 2027-04-28.
function withoutAcceptEvents(events: GoalEvent[], hide: boolean): GoalEvent[] {
  return hide ? events.filter((e) => !GOAL_ACCEPT_EVENT_TYPES.has(e.type)) : events;
}

// COMPAT(goalAccept): added in v0.13.14, remove after 2027-04-28. An older client shows an
// accepted goal as plain completed, its waived criteria as unverified.
export function withoutAcceptance<T extends Goal>(goal: T): T {
  if (!goal.accepted && !goal.criteria.some((c) => c.waived)) return goal;
  const { accepted: _accepted, ...rest } = goal;
  return {
    ...rest,
    criteria: goal.criteria.map(({ waived: _waived, ...c }) => c),
  } as T;
}

// COMPAT(goalConfigEdit): added in v0.13.3, remove after 2027-04-27. An older client's
// policy enum has no "auto"; the nearest it knows is "wait", which auto also does when
// an agent still asks.
export function withoutAutoPolicy<T extends Pick<Goal, "config">>(goal: T): T {
  if (goal.config?.onPermissionRequest !== "auto") return goal;
  return { ...goal, config: { ...goal.config, onPermissionRequest: "wait" } };
}

// COMPAT(goalUsageBreakdown): added in v0.13.3, remove after 2027-04-27. An older client
// cannot show the breakdown, and it grows with every agent the goal starts.
export function withoutUsageBreakdown<T extends Goal>(goal: T): T {
  if (!goal.usageByRole && !goal.usageBreakdown && goal.usageBreakdownTruncated === undefined) {
    return goal;
  }
  const {
    usageByRole: _byRole,
    usageBreakdown: _breakdown,
    usageBreakdownTruncated: _truncated,
    ...rest
  } = goal;
  return rest as T;
}

// COMPAT(goalPlanRevision): added in v0.13.13, remove after 2027-04-28. An older client
// knows neither field; its parser would break on an op kind added after it shipped.
// COMPAT(goalLeadInterventions): added in v0.13.13, remove after 2027-04-28. A client that
// parses plan revisions but not interventions gets the revisions only.
export function withoutInterventions<T extends Goal>(goal: T): T {
  if (!goal.interventions) return goal;
  const { interventions: _interventions, ...rest } = goal;
  return rest as T;
}

export function withoutPlanRevisions<T extends Goal>(goal: T): T {
  if (!goal.planRevisions && !goal.interventions) return goal;
  const { planRevisions: _revisions, interventions: _interventions, ...rest } = goal;
  return rest as T;
}

// COMPAT(goalRecovery): added in v0.13.13, remove after 2027-04-28. An older client cannot
// show a recovery, and the Lead's decision prompt is about no task, which its views assume.
export function withoutRecovery<T extends Goal>(goal: T): T {
  if (!goal.recovery && goal.recoveries === undefined && !goal.guidance) {
    return goal;
  }
  const { recovery: _recovery, recoveries: _recoveries, guidance: _guidance, ...rest } = goal;
  if (!rest.interventions?.some((i) => interventionClass(i) === "recovery")) return rest as T;
  return {
    ...rest,
    interventions: rest.interventions.filter((i) => interventionClass(i) !== "recovery"),
  } as T;
}

/**
 * Revisions and interventions grow with the goal's life. goal.list, mutation responses and
 * goal.update carry the pending revision in full, which a person needs to decide it. Decided
 * revisions come with `ops: []`, which means "left out", not "changed nothing"; read their ops
 * from goal.inspect. Interventions lose only `workSummary` and a nudge's `message`: `error` is
 * required by the schema an older reader of this field already has, so it stays. A recovery
 * keeps its decision's ops only while a person has to approve them, and the Lead's advice for
 * the workers is left out; both are in goal.inspect.
 */
export function withSlimPlanHistory<T extends Goal>(goal: T): T {
  if (!goal.planRevisions && !goal.interventions && !goal.recovery && !goal.guidance) {
    return goal;
  }
  return {
    ...goal,
    ...slimRecovery(goal),
    ...(goal.planRevisions
      ? {
          planRevisions: goal.planRevisions.map((r) =>
            r.status === "pending" ? r : { ...r, ops: [] },
          ),
        }
      : {}),
    ...(goal.interventions
      ? {
          interventions: goal.interventions.map(
            ({ workSummary: _summary, message: _message, ...rest }) => rest,
          ),
        }
      : {}),
  };
}

function slimRecovery(goal: Goal): Pick<Goal, "recovery" | "guidance"> {
  const slim: Pick<Goal, "recovery" | "guidance"> = {};
  const recovery = goal.recovery;
  if (recovery?.decision?.ops && recovery.status !== "awaiting_approval") {
    slim.recovery = { ...recovery, decision: { ...recovery.decision, ops: [] } };
  }
  if (goal.guidance) slim.guidance = slimGuidance(goal.guidance);
  return slim;
}

/** Longest piece of a person's guidance goal.list and goal.update carry. */
export const SLIM_GUIDANCE_CHARS = 500;

/** The person's guidance, each text cut to SLIM_GUIDANCE_CHARS and marked when cut; no Lead advice. */
function slimGuidance(guidance: Guidance): Guidance {
  const { lead: _lead, goal, tasks } = guidance;
  let truncated = guidance.truncated === true;
  const cut = (text: string) => {
    if (text.length <= SLIM_GUIDANCE_CHARS) return text;
    truncated = true;
    return capText(text, SLIM_GUIDANCE_CHARS);
  };
  const slim: Guidance = {
    ...(goal === undefined ? {} : { goal: cut(goal) }),
    ...(tasks
      ? { tasks: Object.fromEntries(Object.entries(tasks).map(([id, text]) => [id, cut(text)])) }
      : {}),
  };
  return truncated ? { ...slim, truncated: true } : slim;
}

/** What a client parses, as the capabilities it announced say. Absent means supported. */
export interface GoalClientSupport {
  configEdit?: boolean;
  usageBreakdown?: boolean;
  planRevision?: boolean;
  leadInterventions?: boolean;
  recovery?: boolean;
  accept?: boolean;
}

/** The goal as a client with `support` can read it. */
export function goalForClient<T extends Goal>(goal: T, support: GoalClientSupport): T {
  const accepted = support.accept === false ? withoutAcceptance(goal) : goal;
  const policy = support.configEdit === false ? withoutAutoPolicy(accepted) : accepted;
  const usage = support.usageBreakdown === false ? withoutUsageBreakdown(policy) : policy;
  const recovery = support.recovery === false ? withoutRecovery(usage) : usage;
  if (support.planRevision === false) return withoutPlanRevisions(recovery);
  return support.leadInterventions === false ? withoutInterventions(recovery) : recovery;
}

export interface GoalUpdateTarget {
  supports(capability: ClientCapability): boolean;
  publish(message: SessionOutboundMessage): void;
}

/**
 * Push one goal.update to each session, in the slim shape goal.list uses and adapted to what
 * the session's client parses. Sessions that announced the same support share one payload.
 */
export function publishGoalUpdate(
  sessions: Iterable<GoalUpdateTarget>,
  goal: GoalSummary,
  options?: { deleted?: boolean },
): void {
  const slim = withSlimPlanHistory(goal);
  // COMPAT(goalConfigEdit, goalUsageBreakdown): added in v0.13.3, remove after 2027-04-27.
  // COMPAT(goalPlanRevision, goalLeadInterventions): added in v0.13.13, remove after 2027-04-28.
  // COMPAT(goalRecovery): added in v0.13.13, remove after 2027-04-28.
  // COMPAT(goalAccept): added in v0.13.14, remove after 2027-04-28.
  const variants = new Map<string, Extract<SessionOutboundMessage, { type: "goal.update" }>>();
  for (const session of sessions) {
    const support = {
      configEdit: session.supports(CLIENT_CAPS.goalConfigEdit),
      usageBreakdown: session.supports(CLIENT_CAPS.goalUsageBreakdown),
      planRevision: session.supports(CLIENT_CAPS.goalPlanRevision),
      leadInterventions: session.supports(CLIENT_CAPS.goalLeadInterventions),
      recovery: session.supports(CLIENT_CAPS.goalRecovery),
      accept: session.supports(CLIENT_CAPS.goalAccept),
    };
    const key = `${support.configEdit}:${support.usageBreakdown}:${support.planRevision}:${support.leadInterventions}:${support.recovery}:${support.accept}`;
    let message = variants.get(key);
    if (!message) {
      const variant = goalForClient(slim, support);
      message = {
        type: "goal.update",
        payload: options?.deleted ? { goal: variant, deleted: true } : { goal: variant },
      };
      variants.set(key, message);
    }
    session.publish(message);
  }
}

// COMPAT(goalRecovery): added in v0.13.13, remove after 2027-04-28. The Lead's recovery
// decision prompt goes with the recovery events it belongs to.
function isRecoveryRequest(event: GoalEvent): boolean {
  return event.type === "intervention.requested" && interventionClass(event) === "recovery";
}

/** The service's guidance input from a request's guidance changes. */
function guidanceInput(guidance: GuidanceChanges | undefined): GuidanceInput {
  if (!guidance) return {};
  return {
    ...(guidance.goal === undefined ? {} : { prompt: guidance.goal }),
    ...(guidance.tasks ? { tasks: guidance.tasks } : {}),
  };
}

function eventWithoutAutoPolicy(event: GoalEvent): GoalEvent {
  if (event.type !== "goal.created" || event.config?.onPermissionRequest !== "auto") return event;
  return { ...event, config: { ...event.config, onPermissionRequest: "wait" } };
}

export interface GoalSessionOptions {
  host: GoalSessionHost;
  goalService: GoalService;
  logger: pino.Logger;
}

export interface OptionalGoalSessionOptions extends Omit<GoalSessionOptions, "goalService"> {
  goalService: GoalService | undefined;
}

type GoalMutationRequest = Extract<
  SessionInboundMessage,
  {
    type:
      | "goal.create.request"
      | "goal.propose_plan.request"
      | "goal.approve_plan.request"
      | "goal.approve_changeset.request"
      | "goal.request_changes.request"
      | "goal.cancel.request"
      | "goal.reject_plan.request"
      | "goal.retry.request"
      | "goal.pause.request"
      | "goal.resume.request"
      | "goal.acknowledge.request"
      | "goal.rename.request"
      | "goal.set_priority.request"
      | "goal.archive.request"
      | "goal.unarchive.request"
      | "goal.update_config.request"
      | "goal.plan.revise.request"
      | "goal.plan.approve_revision.request"
      | "goal.plan.reject_revision.request"
      | "goal.recovery.start.request"
      | "goal.recovery.decide.request"
      | "goal.recovery.cancel.request"
      | "goal.outcome.accept.request";
  }
>;

type GoalListRequest = Extract<SessionInboundMessage, { type: "goal.list.request" }>;

type GoalMutationResponseType =
  | "goal.create.response"
  | "goal.propose_plan.response"
  | "goal.approve_plan.response"
  | "goal.approve_changeset.response"
  | "goal.request_changes.response"
  | "goal.cancel.response"
  | "goal.reject_plan.response"
  | "goal.retry.response"
  | "goal.pause.response"
  | "goal.resume.response"
  | "goal.acknowledge.response"
  | "goal.rename.response"
  | "goal.set_priority.response"
  | "goal.archive.response"
  | "goal.unarchive.response"
  | "goal.update_config.response"
  | "goal.plan.revise.response"
  | "goal.plan.approve_revision.response"
  | "goal.plan.reject_revision.response"
  | "goal.recovery.start.response"
  | "goal.recovery.decide.response"
  | "goal.recovery.cancel.response"
  | "goal.outcome.accept.response";

export class GoalSession {
  private readonly host: GoalSessionHost;
  private readonly goalService: GoalService;
  private readonly logger: pino.Logger;

  /** Goals are advertised and served only when the daemon was built with a GoalService. */
  static forService(options: OptionalGoalSessionOptions): GoalSession | null {
    const { goalService, ...rest } = options;
    return goalService ? new GoalSession({ ...rest, goalService }) : null;
  }

  constructor(options: GoalSessionOptions) {
    this.host = options.host;
    this.goalService = options.goalService;
    this.logger = options.logger;
  }

  dispatch(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "goal.create.request":
        return this.mutate(msg, "goal.create.response", () =>
          this.goalService.create({
            goalId: msg.goalId,
            title: msg.title,
            objective: msg.objective,
            criteria: msg.criteria,
            config: msg.config,
            priority: msg.priority,
          }),
        );
      case "goal.propose_plan.request":
        return this.mutate(msg, "goal.propose_plan.response", () =>
          this.goalService.proposePlan(msg.goalId, msg.tasks, msg.eventId),
        );
      case "goal.approve_plan.request":
        return this.mutate(msg, "goal.approve_plan.response", () =>
          this.goalService.approvePlan(msg.goalId, msg.eventId),
        );
      case "goal.approve_changeset.request":
        return this.mutate(msg, "goal.approve_changeset.response", () =>
          this.goalService.approveChangeSet(msg.goalId, msg.changeSetId, msg.eventId),
        );
      case "goal.request_changes.request":
        return this.mutate(msg, "goal.request_changes.response", () =>
          this.goalService.requestChanges(msg.goalId, msg.changeSetId, msg.findings, msg.eventId),
        );
      case "goal.cancel.request":
        return this.mutate(msg, "goal.cancel.response", () =>
          this.goalService.cancel(msg.goalId, msg.eventId),
        );
      case "goal.reject_plan.request":
        return this.mutate(msg, "goal.reject_plan.response", () =>
          this.goalService.rejectPlan(msg.goalId, msg.feedback, msg.eventId),
        );
      case "goal.retry.request":
        return this.mutate(msg, "goal.retry.response", () =>
          this.goalService.retry(msg.goalId, msg.taskId, msg.eventId, msg.timeMode, {
            ...guidanceInput(msg.guidance),
            ...(msg.agentId ? { agentId: msg.agentId } : {}),
          }),
        );
      case "goal.pause.request":
        return this.mutate(msg, "goal.pause.response", () =>
          this.goalService.pause(msg.goalId, msg.eventId),
        );
      case "goal.resume.request":
        return this.mutate(msg, "goal.resume.response", () =>
          this.goalService.resume(msg.goalId, msg.eventId),
        );
      case "goal.acknowledge.request":
        return this.mutate(msg, "goal.acknowledge.response", () =>
          this.goalService.acknowledge(msg.goalId, msg.eventId),
        );
      case "goal.rename.request":
        return this.mutate(msg, "goal.rename.response", () =>
          this.goalService.rename(msg.goalId, msg.title, msg.eventId),
        );
      case "goal.set_priority.request":
        return this.mutate(msg, "goal.set_priority.response", () =>
          this.goalService.setPriority(msg.goalId, msg.priority, msg.eventId),
        );
      case "goal.archive.request":
        return this.mutate(msg, "goal.archive.response", () =>
          this.goalService.archive(msg.goalId, msg.eventId),
        );
      case "goal.unarchive.request":
        return this.mutate(msg, "goal.unarchive.response", () =>
          this.goalService.unarchive(msg.goalId, msg.eventId),
        );
      case "goal.update_config.request":
        return this.mutate(msg, "goal.update_config.response", () =>
          this.goalService.updateConfig(msg.goalId, msg.changes, msg.eventId),
        );
      case "goal.delete.request":
        return this.handleDelete(msg.requestId, msg.goalId);
      case "goal.list.request":
        return this.handleList(msg);
      case "goal.inspect.request":
        return this.handleInspect(msg.requestId, msg.goalId);
      default:
        return this.dispatchPlanRevision(msg);
    }
  }

  private dispatchRecovery(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "goal.recovery.start.request":
        return this.mutate(msg, "goal.recovery.start.response", () =>
          this.goalService.startRecovery(
            msg.goalId,
            {
              ...guidanceInput(msg.guidance),
              ...(msg.timeMode ? { timeMode: msg.timeMode } : {}),
              ...(msg.agentId ? { agentId: msg.agentId } : {}),
            },
            msg.eventId,
          ),
        );
      case "goal.recovery.decide.request":
        return this.mutate(msg, "goal.recovery.decide.response", () =>
          this.goalService.decideRecovery(
            msg.goalId,
            {
              recoveryId: msg.recoveryId,
              approve: msg.approve,
              ...(msg.message === undefined ? {} : { message: msg.message }),
              ...(msg.agentId ? { agentId: msg.agentId } : {}),
            },
            msg.eventId,
          ),
        );
      case "goal.recovery.cancel.request":
        return this.mutate(msg, "goal.recovery.cancel.response", () =>
          this.goalService.cancelRecovery(
            msg.goalId,
            { recoveryId: msg.recoveryId, ...(msg.agentId ? { agentId: msg.agentId } : {}) },
            msg.eventId,
          ),
        );
      case "goal.outcome.accept.request":
        return this.mutate(msg, "goal.outcome.accept.response", () =>
          this.goalService.accept(
            msg.goalId,
            {
              criterionIds: msg.criterionIds,
              note: msg.note,
              ...(msg.client ? { client: msg.client } : {}),
              ...(msg.agentId ? { agentId: msg.agentId } : {}),
            },
            msg.eventId,
          ),
        );
      default:
        return undefined;
    }
  }

  private dispatchPlanRevision(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "goal.plan.revise.request":
        return this.mutate(msg, "goal.plan.revise.response", () =>
          this.goalService.revisePlan(
            msg.goalId,
            {
              ops: msg.ops,
              tasks: msg.tasks,
              remove: msg.remove,
              reason: msg.reason,
              agentId: msg.agentId,
            },
            msg.eventId,
          ),
        );
      case "goal.plan.approve_revision.request":
        return this.mutate(msg, "goal.plan.approve_revision.response", () =>
          this.goalService.approvePlanRevision(msg.goalId, msg.revisionId, msg.eventId),
        );
      case "goal.plan.reject_revision.request":
        return this.mutate(msg, "goal.plan.reject_revision.response", () =>
          this.goalService.rejectPlanRevision(
            msg.goalId,
            msg.revisionId,
            msg.feedback,
            msg.eventId,
          ),
        );
      default:
        return this.dispatchRecovery(msg);
    }
  }

  private async mutate(
    request: GoalMutationRequest,
    responseType: GoalMutationResponseType,
    run: () => Promise<Goal>,
  ): Promise<void> {
    try {
      const goal = withSlimPlanHistory(this.forClient(await run()));
      this.host.emit({
        type: responseType,
        payload: { requestId: request.requestId, goal, error: null },
      });
    } catch (error) {
      this.emitError(request.requestId, request.type, error);
    }
  }

  private async handleList(msg: GoalListRequest): Promise<void> {
    try {
      const goals = this.goalService.list({
        query: msg.query,
        status: msg.status,
        priority: msg.priority,
        cwd: msg.cwd,
        archived: msg.archived ?? (msg.includeArchived ? "include" : undefined),
      });
      this.host.emit({
        type: "goal.list.response",
        payload: {
          requestId: msg.requestId,
          goals: goals.map((goal) => toGoalSummary(withSlimPlanHistory(this.forClient(goal)))),
          error: null,
        },
      });
    } catch (error) {
      this.emitError(msg.requestId, "goal.list.request", error);
    }
  }

  private async handleDelete(requestId: string, goalId: string): Promise<void> {
    try {
      const { deleted, retained } = await this.goalService.delete(goalId);
      this.host.emit({
        type: "goal.delete.response",
        payload: { requestId, goalId, deleted, retained, error: null },
      });
    } catch (error) {
      this.emitError(requestId, "goal.delete.request", error);
    }
  }

  private async handleInspect(requestId: string, goalId: string): Promise<void> {
    try {
      const { goal, events } = await this.goalService.inspect(goalId);
      // An older client's event union rejects types it does not know.
      const hideControl = this.host.supportsGoalControlEvents?.() === false;
      const hideAcknowledge = this.host.supportsGoalAcknowledgeEvents?.() === false;
      const hideManagement = this.host.supportsGoalManagementEvents?.() === false;
      const hideConfigEdit = this.host.supportsGoalConfigEdit?.() === false;
      const hideIntegrationRetry = this.host.supportsGoalIntegrationRetry?.() === false;
      const hidePlanRevision = this.host.supportsGoalPlanRevision?.() === false;
      const hideLeadInterventions = this.host.supportsGoalLeadInterventions?.() === false;
      const hideRecovery = this.host.supportsGoalRecovery?.() === false;
      const visible =
        hideControl ||
        hideAcknowledge ||
        hideManagement ||
        hideConfigEdit ||
        hideIntegrationRetry ||
        hidePlanRevision ||
        hideLeadInterventions ||
        hideRecovery
          ? events.filter(
              (e) =>
                !(hideControl && GOAL_CONTROL_EVENT_TYPES.has(e.type)) &&
                !(hideAcknowledge && GOAL_ACKNOWLEDGE_EVENT_TYPES.has(e.type)) &&
                !(hideManagement && GOAL_MANAGEMENT_EVENT_TYPES.has(e.type)) &&
                !(hideConfigEdit && GOAL_CONFIG_EDIT_EVENT_TYPES.has(e.type)) &&
                !(hideIntegrationRetry && GOAL_INTEGRATION_RETRY_EVENT_TYPES.has(e.type)) &&
                !(hidePlanRevision && GOAL_PLAN_REVISION_EVENT_TYPES.has(e.type)) &&
                !(hideLeadInterventions && GOAL_LEAD_INTERVENTION_EVENT_TYPES.has(e.type)) &&
                !(hideRecovery && GOAL_RECOVERY_EVENT_TYPES.has(e.type)) &&
                !(hideRecovery && isRecoveryRequest(e)),
            )
          : events;
      const shown = this.withoutUnparsedWaits(
        withoutAcceptEvents(visible, this.host.supportsGoalAccept?.() === false),
      );
      this.host.emit({
        type: "goal.inspect.response",
        payload: {
          requestId,
          goal: this.forClient(goal),
          events: hideConfigEdit ? shown.map(eventWithoutAutoPolicy) : shown,
          error: null,
        },
      });
    } catch (error) {
      this.emitError(requestId, "goal.inspect.request", error);
    }
  }

  // COMPAT(goalUserWait): added in v0.13.14, remove after 2027-04-28.
  private withoutUnparsedWaits(events: GoalEvent[]): GoalEvent[] {
    return withoutUserWaitEvents(events, this.host.supportsGoalUserWait?.() === false);
  }

  private forClient(goal: Goal): Goal {
    return goalForClient(goal, {
      configEdit: this.host.supportsGoalConfigEdit?.(),
      usageBreakdown: this.host.supportsGoalUsageBreakdown?.(),
      planRevision: this.host.supportsGoalPlanRevision?.(),
      leadInterventions: this.host.supportsGoalLeadInterventions?.(),
      recovery: this.host.supportsGoalRecovery?.(),
      accept: this.host.supportsGoalAccept?.(),
    });
  }

  private emitError(requestId: string, requestType: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error({ err: error, requestType }, "Goal request failed");
    this.host.emit({
      type: "rpc_error",
      payload: { requestId, requestType, error: message, code: "goal_request_failed" },
    });
  }
}
