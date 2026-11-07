import type { PluginAgentSnapshot } from "@getpaseo/plugin";
import { ScrollView, View } from "react-native";
import { useAgents, type PluginSidebarViewProps } from "@getpaseo/plugin/client";
import { AgentRow, Heading } from "./rows";
export function agentTask(agent: PluginAgentSnapshot) {
  if (agent.attentionReason === "permission") return "Respond";
  if (agent.requiresAttention || agent.status === "error") return "Review";
  if (agent.status === "running" || agent.status === "initializing") return "Wait";
  return "Start";
}
function Task({ title, view }: { title: string; view: PluginSidebarViewProps }) {
  const agents = useAgents({
    where: (item) => agentTask(item) === title,
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
