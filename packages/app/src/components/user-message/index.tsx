import { useState, useCallback, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { View, type LayoutChangeEvent, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { AgentMessage } from "@getpaseo/protocol/agent-message";
import { Button } from "@/components/ui/button";
import { EdgeFade } from "@/components/ui/edge-fade";
import { useProviderIcon } from "@/components/provider-icons";
import { useSessionStore } from "@/stores/session-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { isNative } from "@/constants/platform";
import { useDisclosureHold } from "@/agent-stream/disclosure";
import { useUserMessageExpanded } from "./expansion-context";

const PREVIEW_HEIGHT = 240;
// Show more and show less sit under the text they open and close.
const TRIGGER_BELOW_CONTENT = { triggerEdge: "bottom" } as const;
// Native View still clips with "scroll", but Yoga measures its children without
// the height cap. "hidden" caps the measured body too, hiding the expand control.
const previewStyle: ViewStyle = {
  maxHeight: PREVIEW_HEIGHT,
  overflow: isNative ? "scroll" : "hidden",
};

/** Caps a long message at the preview height, with a control to read the rest. */
export function MessagePreview({ itemId, children }: { itemId: string; children: ReactNode }) {
  const { t } = useTranslation();
  const { expanded, toggle: toggleExpanded } = useUserMessageExpanded(itemId);
  const bodyRef = useRef<View>(null);
  const [overflowing, setOverflowing] = useState(false);
  // A hidden panel lays out at zero height, which says nothing about the message.
  const applyBodyHeight = useCallback((height: number) => {
    if (height > 0) setOverflowing(height > PREVIEW_HEIGHT);
  }, []);
  // Measure in the commit that mounts the body: an update from a layout effect paints with it, so
  // the first frame already shows the fade and the control. `onLayout` only lands after paint.
  useLayoutEffect(() => {
    applyBodyHeight(bodyRef.current!.getBoundingClientRect().height);
  }, [applyBodyHeight]);
  const measure = useCallback(
    (event: LayoutChangeEvent) => applyBodyHeight(event.nativeEvent.layout.height),
    [applyBodyHeight],
  );
  const hold = useDisclosureHold();
  const toggle = useCallback(
    () => hold(toggleExpanded, TRIGGER_BELOW_CONTENT),
    [hold, toggleExpanded],
  );
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  return (
    <>
      <View style={!expanded && previewStyle}>
        <View ref={bodyRef} style={styles.body} onLayout={measure}>
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
      textStyle={styles.senderText}
      numberOfLines={1}
      disabled={!host}
      onPress={openSender}
    >
      {t("turnSummary.sentBy", { name: agent?.title ?? sender.title ?? sender.id })}
    </Button>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { flexShrink: 0 },
  sender: { paddingRight: 0, borderRightWidth: 0, maxWidth: "100%" },
  senderText: { flexShrink: 1 },
  toggle: { alignSelf: "flex-start", paddingHorizontal: 0, minHeight: 0, borderWidth: 0 },
  expandedToggle: { marginTop: theme.spacing[2] },
  fade: { position: "absolute", bottom: 0, left: 0, right: 0, height: theme.spacing[12] },
}));
