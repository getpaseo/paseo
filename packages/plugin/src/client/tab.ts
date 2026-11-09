import { useCallback, useMemo } from "react";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type { ZodType } from "zod";
import type { PluginTab } from "./contracts.js";

/** Validates the panel's persisted state, using the default for missing or invalid values. */
export function useTabState<T extends JsonValue>(
  tab: PluginTab,
  schema: ZodType<T>,
  defaultState: T,
): [T, (next: T) => void] {
  const parsed = useMemo(() => schema.safeParse(tab.state), [schema, tab.state]);
  const writeState = tab.setState;
  const setState = useCallback((next: T) => writeState(next), [writeState]);
  return [parsed.success ? parsed.data : defaultState, setState];
}
