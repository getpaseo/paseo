import type { JsonValue } from "@getpaseo/protocol/agent-types";
import { useCallback, useMemo } from "react";
import { z } from "zod";
import { usePaneContext } from "@/panels/pane-context";

export function usePanelState<T extends JsonValue>(
  schema: z.ZodType<T>,
  defaultState: T,
): [T, (state: T) => void] {
  const { state, setCurrentTabState } = usePaneContext();
  const parsed = useMemo(() => schema.safeParse(state), [schema, state]);
  const currentState = parsed.success ? parsed.data : defaultState;
  const setState = useCallback(
    (nextState: T) => setCurrentTabState(nextState),
    [setCurrentTabState],
  );
  return [currentState, setState];
}
