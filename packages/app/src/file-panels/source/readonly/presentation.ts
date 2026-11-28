import { resolveResourceBudgets, sourceFileBudgets } from "@/constants/resource-budget";

export const SOURCE_PRESENTATION_BUDGETS = {
  web: resolveResourceBudgets({ isNative: false }).sourceFileBudgets,
  native: resolveResourceBudgets({ isNative: true }).sourceFileBudgets,
} as const;

export type SourcePresentation = "highlighted" | "plain" | "unsupported";
export type SourcePlatform = keyof typeof SOURCE_PRESENTATION_BUDGETS;

export function selectSourcePresentation(input: {
  size: number;
  platform?: SourcePlatform;
}): SourcePresentation {
  const budgets = input.platform ? SOURCE_PRESENTATION_BUDGETS[input.platform] : sourceFileBudgets;
  if (input.size <= budgets.highlighted) return "highlighted";
  if (input.size <= budgets.plain) return "plain";
  return "unsupported";
}
