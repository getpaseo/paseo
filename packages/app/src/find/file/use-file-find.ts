import type { UseFileFindInput, UseFileFindResult } from "./use-file-find.web";

export type { UseFileFindInput, UseFileFindResult };

/** Find is web-only; native builds get no bar, no engine, and no keyboard handler. */
export function useFileFind(_input: UseFileFindInput): UseFileFindResult {
  return null;
}
