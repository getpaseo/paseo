import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import type { PluginPlanActionContribution } from "@getpaseo/plugin/client";

export interface PlanActionsInput {
  callId: string;
  launchProfileId?: string | null;
  live: boolean;
  readOnly: boolean;
  fallbackAvailable?: boolean;
  resolved?: boolean;
  compact?: boolean;
  permissions: readonly AgentPermissionRequest[];
  contributions: { pluginId: string; contribution: PluginPlanActionContribution }[];
}

export interface PlanAction {
  id: string;
  title?: string;
  overflow: boolean;
  disabled?: boolean;
  disabledReason?: string;
  permission?: AgentPermissionRequest;
  contribution?: PluginPlanActionContribution;
  pluginId?: string;
}

export function resolvePlanActions(input: PlanActionsInput): PlanAction[] {
  const secondary = { overflow: input.compact === true };
  const actions: PlanAction[] = [{ id: "copy", ...secondary }];
  const permission =
    input.live && !input.readOnly
      ? input.permissions.find(
          (request) => request.kind === "plan" && request.sourcePlanCallId === input.callId,
        )
      : undefined;
  if (!input.live || input.readOnly || input.resolved || (!permission && !input.fallbackAvailable))
    return actions;
  for (const { pluginId, contribution } of [...input.contributions].sort(
    (left, right) =>
      (left.contribution.order ?? 0) - (right.contribution.order ?? 0) ||
      `${left.pluginId}/${left.contribution.id}`.localeCompare(
        `${right.pluginId}/${right.contribution.id}`,
      ),
  )) {
    if (
      contribution.query?.launchProfileId !== undefined &&
      contribution.query.launchProfileId !== input.launchProfileId
    )
      continue;
    actions.push({
      id: `${pluginId}/${contribution.id}`,
      title: contribution.title,
      ...secondary,
      disabled: Boolean(contribution.disabledReason),
      disabledReason: contribution.disabledReason,
      pluginId,
      contribution,
      permission,
    });
  }
  const approval = permission?.actions?.find((action) => action.behavior === "allow");
  if (!permission?.actions?.length || approval)
    actions.push({ id: "approve", overflow: false, permission });
  return actions;
}

interface PlanState {
  callId: string;
  pending: string | null;
  error: string | null;
  copying: boolean;
  copied: boolean;
  copyError: string | null;
}

export class PlanActionState {
  private state: PlanState;
  private generation = 0;
  private listeners = new Set<() => void>();
  constructor(callId: string) {
    this.state = {
      callId,
      pending: null,
      error: null,
      copying: false,
      copied: false,
      copyError: null,
    };
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  // Called before reading the snapshot during render; never notify a mounted subscriber here.
  setPlan(callId: string): void {
    if (callId === this.state.callId) return;
    this.generation++;
    this.state = {
      callId,
      pending: null,
      error: null,
      copying: false,
      copied: false,
      copyError: null,
    };
  }
  private update(patch: Partial<PlanState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  async run(id: string, operation: () => void | Promise<void>): Promise<void> {
    const copy = id === "copy";
    if (copy ? this.state.copying : this.state.pending !== null) return;
    const generation = this.generation;
    this.update(
      copy ? { copying: true, copied: false, copyError: null } : { pending: id, error: null },
    );
    try {
      await operation();
      if (copy && generation === this.generation) this.update({ copied: true });
    } catch (error) {
      if (generation === this.generation) {
        const message = error instanceof Error ? error.message : String(error);
        this.update(copy ? { copyError: message } : { error: message });
      }
    } finally {
      if (generation === this.generation)
        this.update(copy ? { copying: false } : { pending: null });
    }
  }
}
