import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  useSubagentPresentation,
  useSubagents,
  useWorkspaceTabs,
  useWorkspaces,
  type AgentRef,
  type PluginSidebarViewProps,
  type PluginSubagent,
  type PluginTabPresentation,
  type PluginWorkspaceTab,
  type WorkspaceRef,
} from "@getpaseo/plugin/client";
import {
  SubagentMenu,
  WorkspaceTabMenu,
  WorkspaceTabPresentation,
} from "@getpaseo/plugin/client/ui";
import { WorkspaceRow } from "./rows";

const rowStyle = {
  minHeight: 28,
  paddingHorizontal: 12,
  flexDirection: "row",
  alignItems: "center",
  gap: 8,
} as const;
const pressStyle = { flex: 1, flexDirection: "row", alignItems: "center", gap: 8 } as const;
const indent = { paddingLeft: 16 };
const workspaceLine = { flexDirection: "row", alignItems: "center" } as const;
const grow = { flex: 1 };

type Theme = PluginSidebarViewProps["theme"];

function indicatorColor(theme: Theme, presentation: PluginTabPresentation): string | null {
  switch (presentation.indicator) {
    case "needs_input":
      return theme.colors.statusWarning;
    case "failed":
      return theme.colors.statusDanger;
    case "running":
      return theme.colors.accent;
    default:
      return null;
  }
}

function Row({
  presentation,
  active,
  theme,
  onPress,
  children,
}: {
  presentation: PluginTabPresentation;
  active: boolean;
  theme: Theme;
  onPress(): void;
  /** The row's menu, beside its pressable. */
  children: ReactNode;
}) {
  const dot = indicatorColor(theme, presentation);
  const styles = useMemo(
    () => ({
      row: { ...rowStyle, backgroundColor: active ? theme.colors.surface2 : undefined },
      label: { flex: 1, color: theme.colors.foreground, fontSize: 12, lineHeight: 16 },
      dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: dot ?? undefined },
    }),
    [active, theme, dot],
  );
  const Icon = presentation.Icon;
  return (
    <View style={styles.row}>
      <Pressable
        style={pressStyle}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={presentation.label}
      >
        <Icon size={14} color={active ? theme.colors.foreground : theme.colors.foregroundMuted} />
        <Text numberOfLines={1} style={styles.label}>
          {presentation.loading ? "…" : presentation.label}
        </Text>
        {dot ? <View style={styles.dot} /> : null}
      </Pressable>
      {children}
    </View>
  );
}

function SubagentRow({
  subagent,
  parentTab,
  view,
}: {
  subagent: PluginSubagent;
  parentTab: PluginWorkspaceTab;
  view: PluginSidebarViewProps;
}) {
  const presentation = useSubagentPresentation(subagent);
  const open = useCallback(
    () => view.navigation.openSubagent(subagent, { parentTab }),
    [view.navigation, subagent, parentTab],
  );
  const active = subagent.kind === "agent" && view.active.agent?.key === subagent.agent.key;
  return (
    <Row presentation={presentation} active={active} theme={view.theme} onPress={open}>
      <SubagentMenu
        subagent={subagent}
        workspace={parentTab.workspace}
        label={presentation.label}
      />
    </Row>
  );
}

function Subagents({
  agent,
  tab,
  view,
}: {
  agent: AgentRef;
  tab: PluginWorkspaceTab;
  view: PluginSidebarViewProps;
}) {
  const subagents = useSubagents(agent);
  if (subagents.length === 0) return null;
  return (
    <View style={indent}>
      {subagents.map((subagent) => (
        <SubagentRow
          key={subagent.kind === "agent" ? subagent.agent.key : subagent.ref.id}
          subagent={subagent}
          parentTab={tab}
          view={view}
        />
      ))}
    </View>
  );
}

function TabRow({
  tab,
  active,
  view,
}: {
  tab: PluginWorkspaceTab;
  active: boolean;
  view: PluginSidebarViewProps;
}) {
  const open = useCallback(() => view.navigation.openTab(tab), [view.navigation, tab]);
  const render = useCallback(
    (presentation: PluginTabPresentation) => (
      <Row presentation={presentation} active={active} theme={view.theme} onPress={open}>
        <WorkspaceTabMenu tab={tab} label={presentation.label} />
      </Row>
    ),
    [active, view.theme, open, tab],
  );
  return (
    <View>
      <WorkspaceTabPresentation tab={tab}>{render}</WorkspaceTabPresentation>
      {tab.agent ? <Subagents agent={tab.agent} tab={tab} view={view} /> : null}
    </View>
  );
}

function Workspace({ reference, view }: { reference: WorkspaceRef; view: PluginSidebarViewProps }) {
  const [expanded, setExpanded] = useState(false);
  const { tabs, activeTabId } = useWorkspaceTabs(reference);
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  const isActiveWorkspace = view.active.workspace?.key === reference.key;
  const countStyle = useMemo(
    () => ({ color: view.theme.colors.foregroundMuted, fontSize: 11, paddingHorizontal: 12 }),
    [view.theme],
  );
  const expandedState = useMemo(() => ({ expanded }), [expanded]);
  return (
    <View>
      <View style={workspaceLine}>
        <View style={grow}>
          <WorkspaceRow reference={reference} view={view} />
        </View>
        {tabs.length > 0 ? (
          <Pressable
            onPress={toggle}
            accessibilityRole="button"
            accessibilityState={expandedState}
            accessibilityLabel={`${tabs.length} open tabs`}
            testID={`example-tabs-toggle-${reference.id}`}
          >
            <Text style={countStyle}>
              {tabs.length} {expanded ? "▾" : "›"}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {expanded ? (
        <View style={indent}>
          {tabs.map((tab) => (
            <TabRow
              key={tab.id}
              tab={tab}
              active={isActiveWorkspace && tab.id === activeTabId}
              view={view}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** Workspaces whose rows expand into their open tabs, with each agent tab's subagents. */
export function Tabs(view: PluginSidebarViewProps) {
  const workspaces = useWorkspaces({ orderBy: ["lastPromptAt", "desc"] });
  return (
    <ScrollView>
      {workspaces.map((reference) => (
        <Workspace key={reference.key} reference={reference} view={view} />
      ))}
    </ScrollView>
  );
}
