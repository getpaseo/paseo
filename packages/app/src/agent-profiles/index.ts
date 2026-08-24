/**
 * Agent profiles: named bundles of composer settings (provider, model, mode,
 * thinking option, feature values, notes) stored host-wide in daemon config.
 *
 * Four capabilities leave this module — managing the list in settings, reading
 * it, pinning it to the model picker, and drawing a profile's glyph. Everything
 * else (the form model, the catalog and feature probes, the materialization
 * rules, the icon registry, the row and modal chrome) is internal; import from
 * `@/agent-profiles`, never a path inside it.
 *
 * `useAgentProfilePicker` deliberately hands the picker a flat row view model
 * and one `applyProfile(id)` callback rather than the profiles themselves: what
 * a profile contains, and how it reaches a live agent versus a draft, stays in
 * here.
 */
export type { AgentProfile } from "@getpaseo/protocol/messages";
export type { MaterializedAgentProfile } from "./internal/materialize-profile";
export type { AgentProfileSeed } from "./internal/profile-form-model";
export { useAgentProfileEditor, type AgentProfileEditorControls } from "./agent-profile-editor";
export { useAgentProfiles } from "./internal/use-agent-profiles";
export {
  useAgentProfilePicker,
  type AgentProfileApplyTarget,
  type AgentProfilePicker,
  type AgentProfilePickerRow,
  type DraftAgentProfileControls,
} from "./internal/use-agent-profile-picker";
export { AgentProfileGlyph } from "./internal/agent-profile-glyph";
export { AgentProfilesSection } from "./settings/agent-profiles-section";
