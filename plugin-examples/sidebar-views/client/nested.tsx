import { ScrollView, View } from "react-native";
import {
  useProjects,
  useWorkspaces,
  useAgents,
  useAgent,
  type AgentRef,
  type WorkspaceRef,
  type ProjectRef,
  type PluginSidebarViewProps,
} from "@getpaseo/plugin/client";
import { AgentRow, ProjectHeading, WorkspaceRow } from "./rows";
const indent = { paddingLeft: 12 };
function AgentTree({ reference, view }: { reference: AgentRef; view: PluginSidebarViewProps }) {
  const agent = useAgent(reference);
  const children = useAgents({
    where: (item) =>
      item.parentAgent?.key === reference.key && item.workspace.key === agent?.workspace.key,
    orderBy: "createdAt",
  });
  return (
    <View>
      <AgentRow reference={reference} view={view} />
      <View style={indent}>
        {children.map((child) => (
          <AgentTree key={child.key} reference={child} view={view} />
        ))}
      </View>
    </View>
  );
}
function RootWithParent({
  reference,
  parent,
  workspace,
  view,
}: {
  reference: AgentRef;
  parent: AgentRef;
  workspace: WorkspaceRef;
  view: PluginSidebarViewProps;
}) {
  const parents = useAgents({
    where: (item) => item.ref.key === parent.key && item.workspace.key === workspace.key,
  });
  return parents.length > 0 ? null : <AgentTree reference={reference} view={view} />;
}
function Root({
  reference,
  workspace,
  view,
}: {
  reference: AgentRef;
  workspace: WorkspaceRef;
  view: PluginSidebarViewProps;
}) {
  const agent = useAgent(reference);
  if (!agent) return null;
  return agent.parentAgent ? (
    <RootWithParent
      reference={reference}
      parent={agent.parentAgent}
      workspace={workspace}
      view={view}
    />
  ) : (
    <AgentTree reference={reference} view={view} />
  );
}
function Workspace({ reference, view }: { reference: WorkspaceRef; view: PluginSidebarViewProps }) {
  const agents = useAgents({
    where: (item) => item.workspace.key === reference.key,
    orderBy: "createdAt",
  });
  return (
    <View>
      <WorkspaceRow reference={reference} view={view} />
      <View style={indent}>
        {agents.map((agent) => (
          <Root key={agent.key} reference={agent} workspace={reference} view={view} />
        ))}
      </View>
    </View>
  );
}
function Project({ reference, view }: { reference: ProjectRef; view: PluginSidebarViewProps }) {
  const workspaces = useWorkspaces({
    where: (item) => item.project.key === reference.key,
    orderBy: "name",
  });
  return (
    <View>
      <ProjectHeading reference={reference} view={view} />
      {workspaces.map((workspace) => (
        <Workspace key={workspace.key} reference={workspace} view={view} />
      ))}
    </View>
  );
}
export function Nested(view: PluginSidebarViewProps) {
  const projects = useProjects({ orderBy: "displayName" });
  return (
    <ScrollView>
      {projects.map((reference) => (
        <Project key={reference.key} reference={reference} view={view} />
      ))}
    </ScrollView>
  );
}
