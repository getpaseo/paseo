import type { PluginHandlerContext, PluginLifecycleEvents } from "@getpaseo/plugin/server";

export type PaseoApi = PluginHandlerContext["paseo"];
export type PaseoConfigActions = PaseoApi["config"];
export type AgentProfile = NonNullable<
  Awaited<ReturnType<PaseoConfigActions["get"]>>["config"]["agentProfiles"]
>[number];
export type PaseoAgentConfig = Parameters<
  ReturnType<PaseoApi["workspaces"]["ref"]>["agents"]["create"]
>[0]["config"];
export type AgentTimelineItem = PluginLifecycleEvents["agent.turn_ended"]["timeline"][number];
export type AgentPermissionRequest = PluginLifecycleEvents["agent.permission_requested"]["request"];
export type AgentPermissionResponse =
  PluginLifecycleEvents["agent.permission_resolved"]["resolution"];
