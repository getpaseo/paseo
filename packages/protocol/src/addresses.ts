/** Agent identity is qualified by its daemon; transport and reachability are separate. */
export interface AgentAddress {
  serverId: string;
  agentId: string;
}
