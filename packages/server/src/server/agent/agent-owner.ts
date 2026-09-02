import { z } from "zod";

export const AgentOwnerSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("daemon"),
    daemonId: z.string(),
    executionId: z.string(),
    // An opaque, daemon-local hash. The raw Hub affinity key is never persisted in agent state.
    workspaceAffinityId: z.string().optional(),
  }),
]);

export type AgentOwner = z.infer<typeof AgentOwnerSchema>;
export type DaemonAgentOwner = Extract<AgentOwner, { kind: "daemon" }>;

export function daemonExecutionKey(owner: DaemonAgentOwner): string {
  return `${owner.daemonId}\0${owner.executionId}`;
}
