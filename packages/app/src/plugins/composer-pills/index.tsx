import { PluginClientStateProvider } from "@getpaseo/plugin/host";
import type { PluginComposerPillProps, PluginTheme } from "@getpaseo/plugin";
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { Platform, Pressable, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { composerPillStyles } from "@/composer/pill-styles";
import { useToast } from "@/contexts/toast-context";
import { useHostRuntimeClient, useHosts } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import { createPluginClientStateSource } from "../client-state/source";
import { PluginRuntimeBoundary } from "../runtime-boundary";
import { createPluginSurfaceRuntime } from "../surface-runtime";
import { SurfaceErrorBoundary } from "../surface-error-boundary";
import { toPluginTheme } from "../theme";
import type { InstalledPlugin, PluginComposerPillContribution } from "../types";
import { pluginComposerPillStore } from "./store";

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
  const press = useCallback(async () => {
    if (!runtime || pending) return;
    setPending(true);
    try {
      await contribution.onPress();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  }, [contribution, pending, runtime, toast]);
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
  workspaceId: string;
  agentId: string;
  compact: boolean;
}) {
  const registrations = useSyncExternalStore(
    pluginComposerPillStore.subscribe,
    pluginComposerPillStore.getSnapshot,
    pluginComposerPillStore.getSnapshot,
  );
  const hosts = useHosts();
  const visible = useMemo(
    () =>
      registrations.filter(
        ({ installation, contribution }) =>
          installation.serverId === serverId &&
          contribution.workspaceId === workspaceId &&
          contribution.agentId === agentId,
      ),
    [agentId, registrations, serverId, workspaceId],
  );
  const hostLabel = hosts.find((host) => host.serverId === serverId)?.label ?? serverId;
  return (
    <>
      {visible.map(({ installation, contribution }) => (
        <ThemedPluginComposerPill
          key={`${installation.id}/${contribution.id}`}
          plugin={installation}
          contribution={contribution}
          serverId={serverId}
          workspaceId={workspaceId}
          agentId={agentId}
          compact={compact}
          hostLabel={hostLabel}
          uniProps={pluginThemeMapping}
        />
      ))}
    </>
  );
}

export function useHasPluginComposerPills(
  serverId: string,
  workspaceId: string,
  agentId: string,
): boolean {
  const registrations = useSyncExternalStore(
    pluginComposerPillStore.subscribe,
    pluginComposerPillStore.getSnapshot,
    pluginComposerPillStore.getSnapshot,
  );
  return registrations.some(
    ({ installation, contribution }) =>
      installation.serverId === serverId &&
      contribution.workspaceId === workspaceId &&
      contribution.agentId === agentId,
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
