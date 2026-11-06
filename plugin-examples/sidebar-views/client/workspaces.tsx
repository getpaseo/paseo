import { useCallback, useMemo } from "react";
import {
  useWorkspace,
  useWorkspaces,
  type WorkspaceRef,
  type PluginSidebarViewProps,
} from "@getpaseo/plugin/client";
import { Pressable, ScrollView, Text } from "react-native";

function WorkspaceRow({
  reference,
  view,
}: {
  reference: WorkspaceRef;
  view: PluginSidebarViewProps;
}) {
  const workspace = useWorkspace(reference);
  const open = useCallback(
    () => view.navigation.openWorkspace(reference),
    [view.navigation, reference],
  );
  const textStyle = useMemo(
    () => ({ color: view.theme.colors.foreground, fontSize: 12, lineHeight: 16 }),
    [view.theme],
  );
  const labelStyle = useMemo(
    () => ({ color: view.theme.colors.foregroundMuted, fontSize: 11 }),
    [view.theme],
  );
  if (!workspace) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${workspace.name}`}
      onPress={open}
      style={rowStyle}
    >
      <Text style={textStyle}>{workspace.title ?? workspace.name}</Text>
      <Text style={labelStyle}>{workspace.indicatorLabel}</Text>
    </Pressable>
  );
}
export function Workspaces(view: PluginSidebarViewProps) {
  const workspaces = useWorkspaces({ orderBy: "name" });
  return (
    <ScrollView>
      {workspaces.map((reference) => (
        <WorkspaceRow key={reference.key} reference={reference} view={view} />
      ))}
    </ScrollView>
  );
}

const rowStyle = { minHeight: 28, paddingHorizontal: 12, justifyContent: "center" } as const;
