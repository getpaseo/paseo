import type { ProviderOptions } from "@getpaseo/protocol/agent-types";

/**
 * The options that still apply after an answer from the daemon. A key an earlier answer drew as a
 * control and the latest answer does not (the model changed to one without that control) is
 * dropped, and applies again if a control for it returns. A key no answer has drawn is an option
 * without a control and always applies.
 */
export function withoutLostControls(
  options: ProviderOptions,
  drawn: ReadonlySet<string>,
  current: ReadonlySet<string>,
): ProviderOptions {
  return Object.fromEntries(
    Object.entries(options).filter(([key]) => !drawn.has(key) || current.has(key)),
  );
}
