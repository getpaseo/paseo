import { PluginClientStateProvider } from "@getpaseo/plugin/host";
import type { PluginComposerPillProps, PluginTheme } from "@getpaseo/plugin";
import { useCallback, useMemo, useState } from "react";
import { Platform, Pressable, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { composerPillStyles } from "@/composer/pill-styles";
import { useToast } from "@/contexts/toast-context";
import { useHostRuntimeClient, useHosts } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import { createPluginAgentActionContext } from "../actions";
import { createPluginClientStateSource } from "../client-state/source";
import { createPluginNavigation } from "../navigation";
import { useInstalledPlugins } from "../registry";
import { PluginRuntimeBoundary } from "../runtime-boundary";
import { createPluginSurfaceRuntime } from "../surface-runtime";
import { SurfaceErrorBoundary } from "../surface-error-boundary";
import { toPluginTheme } from "../theme";
import type { InstalledPlugin, PluginComposerPillContribution } from "../types";

const pluginThemeMapping = (theme: Theme) => ({ theme: toPluginTheme(theme) });

function resolvePlatform(): PluginComposerPillProps["layout"]["platform"] {
  if (Platform.OS === "ios") return "ios";
  if (Platform.OS === "android") return "android";
  return "web";
}

function PluginComposerPill({
  plugin,
  contribution,
  serverId,
  workspaceId,
  agentId,
  compact,
  hostLabel,
  theme,
}: {
  plugin: InstalledPlugin;
  contribution: PluginComposerPillContribution;
  serverId: string;
  workspaceId: string;
  agentId: string;
  compact: boolean;
  hostLabel: string;
  theme: PluginTheme;
}) {
  const client = useHostRuntimeClient(serverId);
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const runtime = useMemo(() => createPluginSurfaceRuntime(client, plugin.id), [client, plugin.id]);
  const state = useMemo(() => createPluginClientStateSource(serverId), [serverId]);
  const navigation = useMemo(
    () => createPluginNavigation({ serverId, workspaceId }),
    [serverId, workspaceId],
  );
  const props = useMemo<PluginComposerPillProps>(
    () => ({
      theme,
      host: { id: serverId, label: hostLabel },
      layout: { compact, platform: resolvePlatform() },
      workspaceId,
      agentId,
    }),
    [agentId, compact, hostLabel, serverId, theme, workspaceId],
  );
  const press = useCallback(() => {
    if (!runtime || pending) return;
    const context = createPluginAgentActionContext({
      plugin,
      runtime,
      navigation,
      state,
      workspaceId,
      agentId,
    });
    if (!context) return;
    setPending(true);
    void Promise.resolve(contribution.onPress(context))
      .catch((error) => toast.error(error instanceof Error ? error.message : String(error)))
      .finally(() => setPending(false));
  }, [agentId, contribution, navigation, pending, plugin, runtime, state, toast, workspaceId]);
  const pillStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      composerPillStyles.body,
      styles.pill,
      (hovered || pressed) && composerPillStyles.bodyActive,
      pending && styles.disabled,
    ],
    [pending],
  );
  const accessibilityState = useMemo(() => ({ busy: pending, disabled: pending }), [pending]);
  if (!runtime) return null;
  const Component = contribution.Component;
  return (
    <SurfaceErrorBoundary installation={plugin} Surface={Component}>
      <PluginRuntimeBoundary plugin={plugin} runtime={runtime}>
        <PluginClientStateProvider source={state}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={contribution.title}
            accessibilityState={accessibilityState}
            disabled={pending}
            onPress={press}
            style={pillStyle}
          >
            <Component {...props} />
            {pending ? <LoadingSpinner size="small" color={theme.colors.foregroundMuted} /> : null}
          </Pressable>
        </PluginClientStateProvider>
      </PluginRuntimeBoundary>
    </SurfaceErrorBoundary>
  );
}

const ThemedPluginComposerPill = withUnistyles(PluginComposerPill);

export function PluginComposerPills({
  serverId,
  workspaceId,
  agentId,
  compact,
}: {
  serverId: string;
  workspaceId: string | null | undefined;
  agentId: string;
  compact: boolean;
}) {
  const installed = useInstalledPlugins();
  const hosts = useHosts();
  const state = useMemo(() => createPluginClientStateSource(serverId), [serverId]);
  const plugins = useMemo(
    () => installed.filter((plugin) => plugin.serverId === serverId),
    [installed, serverId],
  );
  if (!workspaceId || !state.getWorkspace(workspaceId) || !state.getAgent(agentId)) return null;
  const hostLabel = hosts.find((host) => host.serverId === serverId)?.label ?? serverId;
  return (
    <>
      {plugins.flatMap((plugin) =>
        plugin.composerPills.map((contribution) => (
          <ThemedPluginComposerPill
            key={`${plugin.id}/${contribution.id}`}
            plugin={plugin}
            contribution={contribution}
            serverId={serverId}
            workspaceId={workspaceId}
            agentId={agentId}
            compact={compact}
            hostLabel={hostLabel}
            uniProps={pluginThemeMapping}
          />
        )),
      )}
    </>
  );
}

export function useHasPluginComposerPills(serverId: string): boolean {
  return useInstalledPlugins().some(
    (plugin) => plugin.serverId === serverId && plugin.composerPills.length > 0,
  );
}

const styles = StyleSheet.create(() => ({
  pill: {
    flexShrink: 1,
    minWidth: 0,
  },
  disabled: {
    opacity: 0.5,
  },
}));
