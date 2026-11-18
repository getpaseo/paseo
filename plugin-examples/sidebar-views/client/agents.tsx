import type { PluginAgentSnapshot } from "@getpaseo/plugin";
import { ScrollView, View } from "react-native";
import { useAgents, type PluginSidebarViewProps } from "@getpaseo/plugin/client";
import { AgentRow, Heading } from "./rows";
export function agentTask(agent: PluginAgentSnapshot) {
  if (agent.attentionReason === "permission") return "Respond";
  if (agent.status === "error") return "Review";
  // An agent whose turn ended still works while shells or monitors it started are live.
  if (
    agent.status === "running" ||
    agent.status === "initializing" ||
    agent.backgroundWork.count > 0
  )
    return "Wait";
  if (agent.requiresAttention) return "Review";
  return "Start";
}
function Task({ title, view }: { title: string; view: PluginSidebarViewProps }) {
  const agents = useAgents({
    // Background agents are helpers the user never opens; leave them out like the sidebar does.
    where: (item) => !item.background && agentTask(item) === title,
    orderBy: ["lastActivityAt", "desc"],
  });
  return (
    <View>
      <Heading title={title} view={view} />
      {agents.map((reference) => (
        <AgentRow key={reference.key} reference={reference} view={view} />
      ))}
    </View>
  );
}
export function Agents(view: PluginSidebarViewProps) {
  return (
    <ScrollView>
      <Task title="Respond" view={view} />
      <Task title="Review" view={view} />
      <Task title="Wait" view={view} />
      <Task title="Start" view={view} />
    </ScrollView>
  );
}
