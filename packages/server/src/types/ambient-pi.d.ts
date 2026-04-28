// Ambient declarations for the optional Pi agent stack.
// These packages are not always installed locally; the runtime imports
// are guarded, but the type checker still needs them to type-resolve.
// Mirror only what packages/server uses.

declare module "@mariozechner/pi-coding-agent" {
  // Values that are also usable as types — declared as `any` so neither
  // member nor instance shapes are constrained.
  export const ModelRegistry: any;
  export type ModelRegistry = any;
  export const SessionManager: any;
  export type SessionManager = any;
  export const createAgentSessionFromServices: any;
  export const createAgentSessionServices: any;

  // Types — surfaced as `any` since only the public shape is consumed.
  export type AgentSession = any;
  export type AgentSessionEvent = any;
  export type AgentSessionServices = any;
  export type BashToolInput = any;
  export type EditToolInput = any;
  export type FindToolInput = any;
  export type GrepToolInput = any;
  export type LsToolInput = any;
  export type ReadToolInput = any;
  export type ResourceLoader = any;
  export type ResolvedCommand = any;
  export type Skill = any;
  export type WriteToolInput = any;

  // Catch-all so additional named imports remain `any` rather than failing.
  const _default: any;
  export default _default;
}

declare module "@mariozechner/pi-agent-core" {
  export type ThinkingLevel = any;
  const _default: any;
  export default _default;
}

declare module "@mariozechner/pi-ai" {
  export type Api = any;
  export type ImageContent = any;
  export type Model<_TParam = any> = any;
  export type TextContent = any;
  export type ListModelsOptions = { [key: string]: any };
  const _default: any;
  export default _default;
}
