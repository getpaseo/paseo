import { useCallback, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import {
  useWorkspace,
  useAgent,
  useProject,
  type WorkspaceRef,
  type AgentRef,
  type ProjectRef,
  type PluginSidebarViewProps,
} from "@getpaseo/plugin/client";

export function Heading({ title, view }: { title: string; view: PluginSidebarViewProps }) {
  const style = useMemo(
    () => ({
      color: view.theme.colors.foregroundMuted,
      fontSize: 11,
      paddingHorizontal: 12,
      paddingTop: 12,
      paddingBottom: 4,
    }),
    [view.theme],
  );
  return (
    <Text accessibilityRole="header" style={style}>
      {title}
    </Text>
  );
}
export function WorkspaceRow({
  reference,
  view,
  onLongPress,
}: {
  reference: WorkspaceRef;
  view: PluginSidebarViewProps;
  onLongPress?: () => void;
}) {
  const workspace = useWorkspace(reference);
  const open = useCallback(
    () => view.navigation.openWorkspace(reference),
    [view.navigation, reference],
  );
  const style = useMemo(
    () => ({ color: view.theme.colors.foreground, fontSize: 12, lineHeight: 16 }),
    [view.theme],
  );
  const detail = useMemo(
    () => ({ color: view.theme.colors.foregroundMuted, fontSize: 11 }),
    [view.theme],
  );
  const background = useMemo(
    () => ({
      ...rowStyle,
      backgroundColor:
        view.active.workspace?.key === reference.key ? view.theme.colors.surface2 : undefined,
    }),
    [view.active.workspace, view.theme, reference],
  );
  if (!workspace) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${workspace.title ?? workspace.name}`}
      onPress={open}
      onLongPress={onLongPress}
      style={background}
    >
      <Text numberOfLines={1} style={style}>
        {workspace.title ?? workspace.name}
      </Text>
      <Text numberOfLines={1} style={detail}>
        {workspace.indicatorLabel}
      </Text>
    </Pressable>
  );
}
export function AgentRow({
  reference,
  view,
}: {
  reference: AgentRef;
  view: PluginSidebarViewProps;
}) {
  const agent = useAgent(reference);
  const open = useCallback(
    () => view.navigation.openAgent(reference),
    [view.navigation, reference],
  );
  const style = useMemo(
    () => ({ color: view.theme.colors.foreground, fontSize: 12 }),
    [view.theme],
  );
  if (!agent) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open agent ${agent.title ?? agent.provider}`}
      onPress={open}
      style={rowStyle}
    >
      <Text numberOfLines={1} style={style}>
        {agent.title ?? agent.provider}
      </Text>
    </Pressable>
  );
}
export function ProjectHeading({
  reference,
  view,
}: {
  reference: ProjectRef;
  view: PluginSidebarViewProps;
}) {
  const project = useProject(reference);
  const open = useCallback(
    () => view.navigation.openProject(reference),
    [view.navigation, reference],
  );
  if (!project) return null;
  return (
    <View>
      <Heading title={project.displayName} view={view} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`New workspace in ${project.displayName}`}
        onPress={open}
      >
        <Heading title="+ New workspace" view={view} />
      </Pressable>
    </View>
  );
}
const rowStyle = {
  minHeight: 28,
  paddingHorizontal: 12,
  paddingVertical: 4,
  justifyContent: "center",
} as const;
