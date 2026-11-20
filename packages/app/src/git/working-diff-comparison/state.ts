export type WorkingDiffComparison = "uncommitted" | "base" | "all";

export interface WorkingDiffComparisonOverride {
  comparison: WorkingDiffComparison;
}

export interface WorkingDiffComparisonState {
  overrides: Record<string, WorkingDiffComparisonOverride>;
}

export interface WorkingDiffCheckoutIdentity {
  serverId: string;
  workspaceId?: string | null;
  cwd: string;
}

function normalizeCwd(cwd: string): string {
  const trimmed = cwd.trim();
  return trimmed === "/" ? trimmed : trimmed.replace(/\/+$/, "");
}

export function workingDiffComparisonKey(input: WorkingDiffCheckoutIdentity): string {
  const workspaceId = input.workspaceId?.trim();
  const checkout = workspaceId
    ? `workspace=${encodeURIComponent(workspaceId)}`
    : `cwd=${encodeURIComponent(normalizeCwd(input.cwd))}`;
  return `working-diff:server=${encodeURIComponent(input.serverId.trim())}:${checkout}`;
}

export function selectWorkingDiffComparisonInState(
  state: WorkingDiffComparisonState,
  input: WorkingDiffCheckoutIdentity & {
    comparison: WorkingDiffComparison;
  },
): WorkingDiffComparisonState {
  return {
    overrides: {
      ...state.overrides,
      [workingDiffComparisonKey(input)]: {
        comparison: input.comparison,
      },
    },
  };
}

export function resolveWorkingDiffComparisonFromState(
  state: WorkingDiffComparisonState,
  input: WorkingDiffCheckoutIdentity,
): WorkingDiffComparison {
  return state.overrides[workingDiffComparisonKey(input)]?.comparison ?? "all";
}
