import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import type {
  PluginResponseActionContext,
  PluginResponseActionContribution,
  PluginResponseActionItem,
} from "@getpaseo/plugin/client";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useToast } from "@/contexts/toast-api-context";
import { useInstalledPlugins } from "./registry";
import { PluginRuntimeBoundary } from "./runtime-boundary";
import { SurfaceErrorBoundary } from "./surface-error-boundary";
import { Icon } from "./icons";
import { useSpeech } from "./speech";
import type { Theme } from "@/styles/theme";
import { LoadingSpinner } from "@/components/ui/loading-spinner";

const ThemedIcon = withUnistyles(Icon);
const ThemedSpinner = withUnistyles(LoadingSpinner);
const muted = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const active = (theme: Theme) => ({ color: theme.colors.accent });

function ResponseMenuItem({
  testID,
  item,
  context,
  close,
}: {
  testID: string;
  item: PluginResponseActionItem;
  context: PluginResponseActionContext;
  close(): void;
}) {
  const toast = useToast();
  const leading = useMemo(
    () => (item.icon ? <ThemedIcon name={item.icon} size={16} uniProps={muted} /> : undefined),
    [item.icon],
  );
  const select = useCallback(() => {
    close();
    // Invoke synchronously to preserve the browser's audio user activation.
    try {
      void Promise.resolve(item.onSelect(context)).catch((error) =>
        toast.error(error instanceof Error ? error.message : String(error)),
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }, [close, item, context, toast]);
  return (
    <DropdownMenuItem testID={testID} disabled={item.disabled} leading={leading} onSelect={select}>
      {item.title}
    </DropdownMenuItem>
  );
}

function ResponseMenu(props: {
  action: PluginResponseActionContribution;
  agentId: string;
  responseId: string;
  getContent(): string;
}) {
  const speech = useSpeech();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const context = useMemo<PluginResponseActionContext>(
    () => ({
      agentId: props.agentId,
      responseId: props.responseId,
      getContent: props.getContent,
      speech,
    }),
    [props.agentId, props.responseId, props.getContent, speech],
  );
  const items = props.action.items(context);
  const activity = props.action.activity?.(context);
  if (!items.length) return null;
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        accessibilityRole="button"
        accessibilityLabel={
          activity ? `${props.action.title}: ${activity.label}` : props.action.title
        }
        aria-busy={activity?.status === "loading"}
        style={[styles.trigger, activity ? styles.activeTrigger : undefined]}
        testID={`response-action-${props.action.id}`}
      >
        {activity?.status === "loading" ? (
          <View style={styles.indicator}>
            <ThemedSpinner size="small" uniProps={active} />
          </View>
        ) : (
          <ThemedIcon name={props.action.icon} size={16} uniProps={activity ? active : muted} />
        )}
        {activity ? (
          <Text style={styles.activityLabel} accessibilityLiveRegion="polite">
            {activity.label}
          </Text>
        ) : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent side="bottom" align="start" minWidth={220}>
        {items.map((item) => (
          <ResponseMenuItem
            key={item.id}
            testID={`response-action-${props.action.id}-${item.id}`}
            item={item}
            context={context}
            close={close}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function PluginResponseActions(props: {
  serverId: string;
  agentId: string;
  responseId: string;
  getContent(): string;
}) {
  const installed = useInstalledPlugins();
  const client = useHostRuntimeClient(props.serverId);
  if (!client) return null;
  return (
    <>
      {installed
        .filter((plugin) => plugin.serverId === props.serverId)
        .flatMap((plugin) =>
          (plugin.responseActions ?? []).map((action) => (
            <SurfaceErrorBoundary
              key={`${plugin.id}/${action.id}`}
              installation={plugin}
              Surface={ResponseMenu}
              resetKey={props.responseId}
            >
              <PluginRuntimeBoundary plugin={plugin} client={client}>
                <ResponseMenu {...props} action={action} />
              </PluginRuntimeBoundary>
            </SurfaceErrorBoundary>
          )),
        )}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    padding: theme.spacing[1],
    flexDirection: "row",
    gap: theme.spacing[1],
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.sm,
  },
  activeTrigger: { backgroundColor: theme.colors.interactionHighlight },
  indicator: { width: 16, height: 16, alignItems: "center", justifyContent: "center" },
  activityLabel: { color: theme.colors.accent, fontSize: theme.fontSize.sm },
}));
