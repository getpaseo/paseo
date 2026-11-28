import { isNative } from "./platform";

export interface SourceFileBudgets {
  readonly highlighted: number;
  readonly plain: number;
}

export interface PlatformResourceBudgets {
  readonly workspaceDeckRetentionLimit: number;
  readonly sourceFileBudgets: SourceFileBudgets;
  readonly deferModelSelectorMount: boolean;
}

const MOBILE_RESOURCE_BUDGETS: PlatformResourceBudgets = {
  workspaceDeckRetentionLimit: 1,
  sourceFileBudgets: { highlighted: 1024 * 1024, plain: 10 * 1024 * 1024 },
  deferModelSelectorMount: true,
};

const WEB_RESOURCE_BUDGETS: PlatformResourceBudgets = {
  workspaceDeckRetentionLimit: 10,
  sourceFileBudgets: { highlighted: 10 * 1024 * 1024, plain: 50 * 1024 * 1024 },
  deferModelSelectorMount: false,
};

/** Shipping-target resolver: native phones use mobile memory budgets; web and Electron use desktop budgets. */
export function resolveResourceBudgets(input: { isNative: boolean }): PlatformResourceBudgets {
  return input.isNative ? MOBILE_RESOURCE_BUDGETS : WEB_RESOURCE_BUDGETS;
}

const RESOURCE_BUDGETS = resolveResourceBudgets({ isNative });

export const workspaceDeckRetentionLimit = RESOURCE_BUDGETS.workspaceDeckRetentionLimit;
export const sourceFileBudgets = RESOURCE_BUDGETS.sourceFileBudgets;
export const deferModelSelectorMount = RESOURCE_BUDGETS.deferModelSelectorMount;
