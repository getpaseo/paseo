/**
 * Agent profiles: named bundles of composer settings (provider, model, mode,
 * thinking option, feature values, notes) stored host-wide in daemon config.
 *
 * Two capabilities leave this module — managing the list in settings, and
 * reading it to apply one. Everything else (the form model, the catalog and
 * feature probes, the row and modal chrome) is internal; import from
 * `@/agent-profiles`, never from a path inside it.
 */
export type { AgentProfile } from "@getpaseo/protocol/messages";
export { useAgentProfiles } from "./internal/use-agent-profiles";
export { AgentProfilesSection } from "./settings/agent-profiles-section";
