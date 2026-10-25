import { createContext } from "react";
import type { InteractiveState } from "@getpaseo/protocol/interactive-response-schema";
export const InteractiveFields = createContext<{
  state: InteractiveState;
  disabled: boolean;
  change: (name: string, value: string | number) => void;
  registerRuntime: (flush: () => Promise<void>) => () => void;
}>({ state: {}, disabled: true, change: () => {}, registerRuntime: () => () => {} });
