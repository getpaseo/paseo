import type { PluginAgentSnapshot } from "@getpaseo/plugin";
import { ScrollView, View } from "react-native";
import { useAgents, type PluginSidebarViewProps } from "@getpaseo/plugin/client";
import { AgentRow, Heading } from "./rows";

const tasks: { title: string; indicators: PluginAgentSnapshot["indicator"][] }[] = [
  { title: "Respond", indicators: ["needs_input"] },
  { title: "Review", indicators: ["failed", "attention"] },
  { title: "Wait", indicators: ["running"] },
  { title: "Start", indicators: ["done"] },
];

function Task({
  title,
  indicators,
  view,
}: {
  title: string;
  indicators: PluginAgentSnapshot["indicator"][];
  view: PluginSidebarViewProps;
}) {
  // Background agents are helpers the user never opens; leave them out like the sidebar does.
  const agents = useAgents({
    where: (item) => !item.background && indicators.includes(item.indicator),
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
      {tasks.map((task) => (
        <Task key={task.title} title={task.title} indicators={task.indicators} view={view} />
      ))}
    </ScrollView>
  );
}
