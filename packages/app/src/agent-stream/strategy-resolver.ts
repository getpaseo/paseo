import type { ResolveStreamRenderStrategyInput, StreamStrategy } from "./strategy";
import { createNativeStreamStrategy } from "./strategy-native";
import { createWebStreamStrategy } from "./strategy-web";

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
