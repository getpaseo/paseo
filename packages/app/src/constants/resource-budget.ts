import { isNative } from "./platform";

/**
 * Answers whether this target runs under constrained mobile memory and layout budgets
 * (single mounted workspace, 1 MiB source highlight cap, deferred selector mount, 15/16 pt fonts,
 * and 30 pt composer minimum height) rather than desktop budgets.
 */
export function resolveUsesMobileResourceBudget(input: { isNative: boolean }): boolean {
  return input.isNative;
}

export const usesMobileResourceBudget = resolveUsesMobileResourceBudget({ isNative });
