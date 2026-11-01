import type { AgentOptionControl, ProviderOptions } from "@getpaseo/protocol/agent-types";

/**
 * What a draft agent shows and runs with, from its layers:
 * - `seed`: options the draft started from (a profile, a forked agent). The daemon resolves them
 *   into `resolved`, so a legacy Fast profile is drawn as the model's Fast tier.
 * - `persisted`: last-used control values, applied to keys the seed leaves alone and that the
 *   provider still draws a control for.
 * - `edits`: toggles made in this draft.
 */
export function composeDraftOptions(input: {
  seed: ProviderOptions;
  persisted: ProviderOptions;
  edits: ProviderOptions;
  controls: readonly AgentOptionControl[] | undefined;
  resolved: ProviderOptions | undefined;
}): { shown: ProviderOptions; own: ProviderOptions | undefined } {
  const { seed, persisted, edits, controls, resolved } = input;
  const controlKeys = new Set((controls ?? []).map((control) => control.key));
  const remembered = Object.fromEntries(
    Object.entries(persisted).filter(([key]) => controlKeys.has(key) && !(key in seed)),
  );
  const own = { ...seed, ...remembered, ...edits };
  return {
    shown: { ...resolved, ...remembered, ...edits },
    // The daemon resolves defaults again on create, so only what differs from them travels.
    own: Object.keys(own).length > 0 ? own : undefined,
  };
}
