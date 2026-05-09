// Pure-data entry point for callers that don't want React Native deps in
// their dependency graph (e.g. workspace-agent-visibility.ts is plain JS
// data derivation and its tests run without an RN environment).
//
// The full module entry `@/subagents` re-exports these too, alongside the
// UI surface. Use `@/subagents/policies` only when the caller is
// non-RN infrastructure code; otherwise prefer `@/subagents`.
export { resolveCloseAgentTabPolicy, type CloseAgentTabPolicy } from "./close-tab-policy";
export { shouldAutoOpenAgentTab } from "./auto-open-tab-policy";
