import { useState, useCallback, useMemo, type ReactNode } from "react";
import { View, type LayoutChangeEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { AgentMessage } from "@getpaseo/protocol/agent-message";
import { Button } from "@/components/ui/button";
import { EdgeFade } from "@/components/ui/edge-fade";
import { useProviderIcon } from "@/components/provider-icons";
import { useSessionStore } from "@/stores/session-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";

const PREVIEW_HEIGHT = 240;

export function MessagePreview({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [height, setHeight] = useState(0);
  const overflowing = height > PREVIEW_HEIGHT;
  const measure = useCallback(
    (event: LayoutChangeEvent) => setHeight(event.nativeEvent.layout.height),
    [],
  );
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  return (
    <>
      <View style={!expanded && styles.preview}>
        <View style={styles.body} onLayout={measure}>
          {children}
        </View>
        {overflowing && !expanded ? (
          <EdgeFade edge="bottom" solidFraction={0} backdrop="surface3" style={styles.fade} />
        ) : null}
      </View>
      {overflowing ? (
        <Button
          variant="ghost"
          size="sm"
          style={[styles.toggle, expanded && styles.expandedToggle]}
          accessibilityState={accessibilityState}
          onPress={toggle}
        >
          {t(expanded ? "turnSummary.showLess" : "turnSummary.showMore")}
        </Button>
      ) : null}
    </>
  );
}

export function MessageSender({
  sender,
  serverId,
}: {
  sender: AgentMessage["sender"];
  serverId?: string;
}) {
  const { t } = useTranslation();
  const host = sender.serverId ?? serverId;
  const agent = useSessionStore((state) => {
    const session = host ? state.sessions[host] : undefined;
    return session?.agents.get(sender.id) ?? session?.agentDetails.get(sender.id);
  });
  const ProviderIcon = useProviderIcon(agent?.provider ?? "", host);
  const renderProviderIcon = useCallback(
    (color: string) => <ProviderIcon size={16} color={color} />,
    [ProviderIcon],
  );
  const openSender = useCallback(() => {
    if (host) navigateToAgent({ serverId: host, agentId: sender.id });
  }, [host, sender.id]);
  return (
    <Button
      variant="ghost"
      size="sm"
      leftIcon={renderProviderIcon}
      style={styles.sender}
      disabled={!host}
      onPress={openSender}
    >
      {t("turnSummary.sentBy", { name: agent?.title ?? sender.title ?? sender.id })}
    </Button>
  );
}

const styles = StyleSheet.create((theme) => ({
  preview: { maxHeight: PREVIEW_HEIGHT, overflow: "hidden" },
  body: { flexShrink: 0 },
  sender: { paddingRight: 0, borderRightWidth: 0 },
  toggle: { alignSelf: "flex-start", paddingHorizontal: 0, minHeight: 0, borderWidth: 0 },
  expandedToggle: { marginTop: theme.spacing[2] },
  fade: { position: "absolute", bottom: 0, left: 0, right: 0, height: theme.spacing[12] },
}));
