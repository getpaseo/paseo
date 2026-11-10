import { ScrollView, View } from "react-native";
import {
  useProjects,
  useWorkspaces,
  type ProjectRef,
  type PluginSidebarViewProps,
} from "@getpaseo/plugin/client";
import { Heading, ProjectHeading, WorkspaceRow } from "./rows";
function Project({ reference, view }: { reference: ProjectRef; view: PluginSidebarViewProps }) {
  const workspaces = useWorkspaces({
    where: (item) => item.project.key === reference.key && !item.pinnedAt,
    orderBy: "name",
  });
  return (
    <View>
      <ProjectHeading reference={reference} view={view} />
      {workspaces.map((workspace) => (
        <WorkspaceRow key={workspace.key} reference={workspace} view={view} />
      ))}
    </View>
  );
}
export function Workspaces(view: PluginSidebarViewProps) {
  const projects = useProjects({ orderBy: "displayName" });
  const pinned = useWorkspaces({ where: (item) => !!item.pinnedAt, orderBy: "name" });
  return (
    <ScrollView>
      {pinned.length ? <Heading title="Pinned" view={view} /> : null}
      {pinned.map((reference) => (
        <WorkspaceRow key={reference.key} reference={reference} view={view} />
      ))}
      {projects.map((reference) => (
        <Project key={reference.key} reference={reference} view={view} />
      ))}
    </ScrollView>
  );
}
