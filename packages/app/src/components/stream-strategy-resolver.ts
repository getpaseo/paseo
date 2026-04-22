import type { ResolveStreamRenderStrategyInput, StreamStrategy } from "./stream-strategy";
import { createNativeStreamStrategy } from "./stream-strategy-native";
import { createWebStreamStrategy } from "./stream-strategy-web";

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
