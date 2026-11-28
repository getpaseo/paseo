import { useTranslation } from "react-i18next";
import { SidebarViewFrame } from "./frame";
import type { PluginSidebarViewProps } from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import { router } from "expo-router";
import { useMemo, useCallback, type ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useToast } from "@/contexts/toast-context";
import {
  navigateToWorkspace,
  useActiveWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import { buildNewWorkspaceRoute } from "@/utils/host-routes";
import type { Theme } from "@/styles/theme";
import { createPluginClientStateSource } from "../client-state/source";
import { entityRefs } from "../client-state/refs";
import { PluginEnvironmentProvider } from "../popover";
import { resolvePluginPlatform } from "../platform";
import { useInstalledPlugins } from "../registry";
import { SurfaceErrorBoundary } from "../surface-error-boundary";
import { toPluginTheme } from "../theme";
import { sidebarViews, type SidebarViewEntry } from "./catalog";
import { useSidebarViewSelection } from "./selection";

const source = createPluginClientStateSource();
const themeMapping = (theme: Theme) => ({ theme: toPluginTheme(theme) });

export function SidebarViewSlot({ children, dismiss }: { children: ReactNode; dismiss(): void }) {
  const { t } = useTranslation();
  const installed = useInstalledPlugins();
  const { state, reload, setSelection, pending, error } = useSidebarViewSelection();
  const restoreDefault = useCallback(() => setSelection("default"), [setSelection]);
  const renderError = useCallback(
    () => (
      <View style={styles.placeholder}>
        <Text style={styles.text}>{t("sidebar.view.failed")}</Text>
        <Button onPress={restoreDefault} disabled={pending}>
          {t("sidebar.view.useDefault")}
        </Button>
        {error ? <Text style={styles.text}>{error.message}</Text> : null}
      </View>
    ),
    [restoreDefault, pending, error, t],
  );
  const entry =
    state.status === "ready"
      ? sidebarViews(installed).find((view) => view.id === state.selection)
      : undefined;
  const view = entry ? (
    <View style={styles.content} testID="plugin-sidebar-view">
      <SurfaceErrorBoundary
        installation={entry.plugin}
        Surface={entry.view.Component}
        renderError={renderError}
      >
        <ThemedSidebarView entry={entry} dismiss={dismiss} uniProps={themeMapping} />
      </SurfaceErrorBoundary>
    </View>
  ) : null;
  return (
    <SidebarViewFrame state={state} fallback={children} reload={reload}>
      {view}
    </SidebarViewFrame>
  );
}

function SidebarView({
  entry,
  dismiss,
  theme,
}: {
  entry: SidebarViewEntry;
  dismiss(): void;
  theme: PluginTheme;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const compact = useIsCompactFormFactor();
  const selection = useActiveWorkspaceSelection();
  const focusedAgentId = useSessionStore((state) =>
    selection ? (state.sessions[selection.serverId]?.focusedAgentId ?? null) : null,
  );
  const activeWorkspace = selection
    ? entityRefs.workspace(selection.serverId, selection.workspaceId)
    : null;
  const activeAgent =
    selection && focusedAgentId ? entityRefs.agent(selection.serverId, focusedAgentId) : null;
  const environment = useMemo(
    () => ({ installation: entry.plugin, state: source, toast }),
    [entry.plugin, toast],
  );
  const navigation = useMemo<PluginSidebarViewProps["navigation"]>(
    () => ({
      openWorkspace(ref) {
        navigateToWorkspace({ serverId: ref.hostId, workspaceId: ref.id });
        dismiss();
      },
      openAgent(ref) {
        const agent = source.getAgent(ref);
        if (!agent) {
          toast.error(t("sidebar.view.agentUnavailable"));
          return;
        }
        navigateToWorkspace({
          serverId: ref.hostId,
          workspaceId: agent.workspace.id,
          target: { kind: "agent", agentId: ref.id },
        });
        dismiss();
      },
      openTerminal(ref) {
        const terminal = source.getTerminal(ref);
        if (!terminal) {
          toast.error(t("sidebar.view.terminalUnavailable"));
          return;
        }
        navigateToWorkspace({
          serverId: ref.hostId,
          workspaceId: terminal.workspace.id,
          target: { kind: "terminal", terminalId: ref.id },
        });
        dismiss();
      },
      openProject(ref) {
        const project = source.getProject(ref);
        if (!project) {
          toast.error(t("sidebar.view.projectUnavailable"));
          return;
        }
        router.push(
          buildNewWorkspaceRoute({
            serverId: ref.hostId,
            projectId: ref.id,
            sourceDirectory: project.rootPath,
            displayName: project.displayName,
          }),
        );
        dismiss();
      },
    }),
    [dismiss, toast, t],
  );
  const layout = useMemo(() => ({ compact, platform: resolvePluginPlatform() }), [compact]);
  const active = useMemo(
    () => ({ workspace: activeWorkspace, agent: activeAgent }),
    [activeWorkspace, activeAgent],
  );
  const Component = entry.view.Component;
  return (
    <PluginEnvironmentProvider environment={environment}>
      <Component
        theme={theme}
        layout={layout}
        active={active}
        navigation={navigation}
        dismiss={dismiss}
      />
    </PluginEnvironmentProvider>
  );
}
const ThemedSidebarView = withUnistyles(SidebarView);

const styles = StyleSheet.create((theme) => ({
  content: { flex: 1 },
  placeholder: { padding: theme.spacing[4], gap: theme.spacing[3] },
  text: { color: theme.colors.foreground },
}));

export { SidebarViewPicker } from "./picker";
