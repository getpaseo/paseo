import { createContext, useContext } from "react";
import type { ForkMenuProps } from "@getpaseo/plugin/client/ui";
import { AssistantForkMenu, type AssistantForkTarget } from "@/components/assistant-fork-menu";

export const TimelineForkContext = createContext<
  ((target: AssistantForkTarget) => Promise<void> | void) | null
>(null);

export function ForkMenu({ testID }: ForkMenuProps) {
  const onFork = useContext(TimelineForkContext);
  return onFork ? <AssistantForkMenu onFork={onFork} testID={testID} /> : null;
}
