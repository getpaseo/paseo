import { createNativeStreamStrategy } from "./stream-strategy-native";
import { createWebStreamStrategy } from "./stream-strategy-web";
export type ResolveStreamRenderStrategyInput = {
  platform: string;
  isMobileBreakpoint: boolean;
};
export * from "./stream-strategy-core";
import type { StreamStrategy } from "./stream-strategy-core";

export function resolveStreamRenderStrategy(
  input: ResolveStreamRenderStrategyInput,
): StreamStrategy {
  if (input.platform === "web") {
    return createWebStreamStrategy({
      isMobileBreakpoint: input.isMobileBreakpoint,
    });
  }
  return createNativeStreamStrategy();
}
