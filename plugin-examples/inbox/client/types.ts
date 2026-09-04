import type { usePaseo } from "@getpaseo/plugin";

export type PaseoApi = ReturnType<typeof usePaseo>;
export type AgentHandle = ReturnType<PaseoApi["agents"]["ref"]>;
export type Agent = NonNullable<ReturnType<AgentHandle["current"]>>;
export type Workspace = NonNullable<
  ReturnType<ReturnType<PaseoApi["workspaces"]["ref"]>["current"]>
>;
export type PermissionRequest = Agent["pendingPermissions"][number];
export type PermissionResponse = Parameters<AgentHandle["respondToPermission"]>[1];
export type TimelineEntry = Awaited<
  ReturnType<AgentHandle["timeline"]["refetch"]>
>["entries"][number];
export type TimelineItem = TimelineEntry["item"];
