import type { ProviderCapability } from "@getpaseo/plugin/server/provider";

/**
 * The capabilities the legacy ZCode transport can deliver.
 * The V4 transport adds session.revert.* and prompt.steer.
 */
export const ZCODE_CAPABILITIES = [
  "prompt.message",
  "permission",
  "permission.tool_policy",
  "session.configure",
  "session.list",
  "session.persistence",
  "session.archive",
  "session.unarchive",
  "session.can_stop_runtime",
  "session.subsession",
  "timeline.plugin",
] as const satisfies readonly ProviderCapability[];
