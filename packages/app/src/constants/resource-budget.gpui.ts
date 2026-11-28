import type { SourceFileBudgets } from "./resource-budget";

// Mounted workspace retention limit on GPUI (adjust independently while memory retention is measured).
export const workspaceDeckRetentionLimit = 10;

export const sourceFileBudgets: SourceFileBudgets = {
  highlighted: 10 * 1024 * 1024,
  plain: 50 * 1024 * 1024,
};

export const deferModelSelectorMount = false;
