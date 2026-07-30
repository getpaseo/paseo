import { useCallback, useEffect, useMemo, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Square, Volume2 } from "lucide-react-native";
import { useLocalSearchParams, usePathname } from "expo-router";

import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { getOverlayRoot, OVERLAY_Z } from "@/lib/overlay-root";
import { decidePlacement } from "@/read-aloud/read-aloud-placement";
import {
  READ_ALOUD_RATES,
  setReadAloudRate,
  startReadAloud,
  stopReadAloud,
  useReadAloudSnapshot,
  type ReadAloudFailure,
  type ReadAloudRate,
  type ReadAloudSnapshot,
} from "@/read-aloud/read-aloud-store";
import {
  READ_ALOUD_BUBBLE_DATASET,
  useSelectionAnchor,
} from "@/read-aloud/use-selection-anchor.web";
import { useHostFeatureMap } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { parseActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store/navigation";

const BUBBLE_HEIGHT = 32;
/** Icon-only: the speaker says "read this" without a caption. */
const BUBBLE_WIDTH = 32;
/** A failure is the one case that earns words, so it can explain itself. */
const FAILED_BUBBLE_WIDTH = 220;
/** The pill draws a 1px border, so its content box is 2px narrower than the pill. */
const BUBBLE_BORDER = 1;
const ICON_BUTTON_WIDTH = BUBBLE_WIDTH - BUBBLE_BORDER * 2;
/** Width of one speed chip, and the gap the row adds around them. */
const RATE_CHIP_WIDTH = 34;
const RATE_ROW_GAP = 2;
const RATE_ROW_PADDING = 4;
/**
 * Total width once the speed chips are showing. They sit in the same pill as
 * the stop button, so the whole thing has to be measured for the anchor math.
 */
const SPEAKING_BUBBLE_WIDTH =
  BUBBLE_BORDER * 2 +
  ICON_BUTTON_WIDTH +
  READ_ALOUD_RATES.length * (RATE_CHIP_WIDTH + RATE_ROW_GAP) +
  RATE_ROW_PADDING;

function formatRate(rate: ReadAloudRate): string {
  return `${rate}x`;
}

function useRouteServerId(): string | null {
  const params = useLocalSearchParams<{
    serverId?: string | string[];
    workspaceId?: string | string[];
  }>();
  const pathname = usePathname();
  // Read-only: unlike `useActiveWorkspaceSelection`, this must not also record
  // the workspace as "last visited" — that stays owned by the workspace screen.
  return parseActiveWorkspaceSelection({ pathname, params })?.serverId ?? null;
}

/**
 * Which host synthesizes the speech.
 *
 * The selection is spoken by the host that owns the route it came from, never
 * another paired daemon. The text being read *is* workspace content — code,
 * agent output — so sending it to a different host would disclose it across an
 * independently paired daemon boundary. There is deliberately no fallback: a
 * route host that doesn't advertise the capability shows no button, and so does
 * a route with no host at all (settings, history).
 *
 * Reachability is not checked here: the daemon client resolves to `null` before
 * it has a transport, and a host that drops mid-request surfaces the failure on
 * the bubble.
 */
function useReadAloudServerId(): string | null {
  const routeServerId = useRouteServerId();
  const serverIds = useMemo(() => (routeServerId ? [routeServerId] : []), [routeServerId]);
  const featureByServerId = useHostFeatureMap(serverIds, "readAloud");

  if (!routeServerId) {
    return null;
  }
  return featureByServerId.get(routeServerId) === true ? routeServerId : null;
}

function renderStatusIcon(status: ReadAloudSnapshot["status"], color: string): ReactNode {
  if (status === "loading") {
    return <LoadingSpinner size="small" color={color} />;
  }
  if (status === "speaking") {
    return <Square size={14} color={color} fill={color} />;
  }
  return <Volume2 size={14} color={color} />;
}

function useFailureLabel(failure: ReadAloudFailure | null): string | null {
  const { t } = useTranslation();
  if (!failure) {
    return null;
  }
  switch (failure.code) {
    case "tts_unavailable":
      return t("readAloud.errors.ttsUnavailable");
    case "text_too_long":
      return t("readAloud.errors.tooLong");
    case "empty_text":
      return t("readAloud.errors.empty");
    case "unsupported_platform":
      return t("readAloud.errors.unsupported");
    default:
      return t("readAloud.errors.failed");
  }
}

/**
 * The pill takes one of three shapes: a round icon, a wide pill with the speed
 * chips, or a labelled failure. A function rather than a reassigned variable —
 * the three styles have different shapes, so the first assignment would pin the
 * variable's type and reject the rest.
 */
function pickContainerStyle(hasFailure: boolean, showRates: boolean) {
  if (hasFailure) {
    return styles.failedBubble;
  }
  return showRates ? styles.speakingBubble : styles.bubble;
}

/**
 * One speed button. Split out of the bubble so the press handler and the
 * accessibility state are stable per rate instead of rebuilt on every render.
 */
function RateChip({ rate, isActive }: { rate: ReadAloudRate; isActive: boolean }): ReactElement {
  const { t } = useTranslation();
  const handlePress = useCallback(() => setReadAloudRate(rate), [rate]);
  const accessibilityState = useMemo(() => ({ selected: isActive }), [isActive]);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      accessibilityLabel={t("readAloud.speed", { rate: formatRate(rate) })}
      onPress={handlePress}
      style={isActive ? styles.rateChipActive : styles.rateChip}
    >
      <Text style={isActive ? styles.rateLabelActive : styles.rateLabel}>{formatRate(rate)}</Text>
    </Pressable>
  );
}

export function ReadAloudSelectionBubble(): ReactElement | null {
  const { t } = useTranslation();
  // COMPAT(readAloud): added in v0.2.5, drop the gate when floor >= v0.2.5.
  // `useReadAloudServerId` only returns hosts that advertise the RPC, so hosts
  // without it simply get no bubble — an upgrade prompt on every text selection
  // would be worse than the feature being absent.
  const serverId = useReadAloudServerId();
  const client = useHostRuntimeClient(serverId ?? "");
  const enabled = serverId !== null && client !== null;

  const snapshot = useReadAloudSnapshot();
  const failureLabel = useFailureLabel(snapshot.failure);
  const isBusy = snapshot.status !== "idle";

  // While something is playing the anchor outlives its range, so scrolling the
  // selected rows out of the virtualizer no longer kills the read.
  const anchor = useSelectionAnchor(enabled, isBusy);
  const anchorText = anchor?.text ?? null;

  // Playback stops on intent, not on geometry: the selection was replaced, or
  // the user clicked away (which drops the anchor even while retaining). A
  // selection merely scrolled out of view keeps reading.
  useEffect(() => {
    stopReadAloud();
  }, [anchorText]);

  useEffect(() => {
    if (!enabled) {
      stopReadAloud();
    }
  }, [enabled]);

  // A boolean, not the anchor itself: the anchor is a fresh object on every
  // scroll frame, which would re-register this listener 60 times a second.
  const hasAnchor = anchor !== null;
  useEffect(() => {
    if (!hasAnchor) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      stopReadAloud();
      // Dropping the selection dismisses the bubble too — Escape means "done
      // with this", not just "be quiet".
      window.getSelection()?.removeAllRanges();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [hasAnchor]);

  const setContainerRef = useCallback((node: View | null) => {
    const element = node as unknown as HTMLElement | null;
    if (!element) {
      return;
    }
    // Web-only file: a mousedown that reaches the browser collapses the
    // selection before the press handler runs, and the selection is what the
    // bubble is anchored to.
    const preventSelectionCollapse = (event: MouseEvent) => event.preventDefault();
    element.addEventListener("mousedown", preventSelectionCollapse);
    return () => element.removeEventListener("mousedown", preventSelectionCollapse);
  }, []);

  const handlePress = useCallback(() => {
    if (!client || !anchor) {
      return;
    }
    if (isBusy) {
      stopReadAloud();
      return;
    }
    // A press after a failure is a retry; `startReadAloud` clears the failure.
    startReadAloud({ client, text: anchor.text });
  }, [anchor, client, isBusy]);

  // The speed chips only appear once there is something to speed up, so an
  // ordinary text selection still gets the small icon-only bubble.
  const showRates = failureLabel === null && isBusy;
  let width = BUBBLE_WIDTH;
  if (failureLabel !== null) {
    width = FAILED_BUBBLE_WIDTH;
  } else if (showRates) {
    width = SPEAKING_BUBBLE_WIDTH;
  }

  const position = useMemo(() => {
    if (!anchor) {
      return null;
    }
    return decidePlacement({
      firstRect: anchor.firstRect,
      lastRect: anchor.lastRect,
      visibleBox: anchor.visibleBox,
      width,
      height: BUBBLE_HEIGHT,
    });
  }, [anchor, width]);

  if (!enabled || !anchor || !position) {
    return null;
  }
  // Out of view and nothing playing: there is nothing to point at and nothing
  // to stop. Mid-read the bubble stays, parked at the edge of its pane.
  if (position.isOffscreen && !isBusy) {
    return null;
  }

  const label = failureLabel ?? (isBusy ? t("readAloud.stop") : t("readAloud.action"));
  const containerStyle = pickContainerStyle(failureLabel !== null, showRates);

  return createPortal(
    <View
      ref={setContainerRef}
      dataSet={READ_ALOUD_BUBBLE_DATASET}
      style={[styles.anchorLayer, { left: position.left, top: position.top }]}
    >
      <View style={containerStyle}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          onPress={handlePress}
          style={failureLabel === null ? styles.iconButton : styles.failedContent}
        >
          {renderStatusIcon(
            snapshot.status,
            failureLabel === null ? styles.icon.color : styles.failedIcon.color,
          )}
          {/* The icon carries the action on its own; only a failure needs words. */}
          {failureLabel === null ? null : (
            <Text numberOfLines={1} style={styles.label}>
              {failureLabel}
            </Text>
          )}
        </Pressable>
        {!showRates
          ? null
          : READ_ALOUD_RATES.map((rate) => (
              <RateChip key={rate} rate={rate} isActive={rate === snapshot.rate} />
            ))}
      </View>
    </View>,
    getOverlayRoot(),
  );
}

const styles = StyleSheet.create((theme) => ({
  anchorLayer: {
    position: "absolute",
    zIndex: OVERLAY_Z.toast,
    // The shared overlay root is `pointer-events: none`; opt this subtree back in.
    pointerEvents: "auto",
  },
  bubble: {
    alignItems: "center",
    justifyContent: "center",
    height: BUBBLE_HEIGHT,
    width: BUBBLE_WIDTH,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.popover,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    ...theme.shadow.md,
  },
  speakingBubble: {
    flexDirection: "row",
    alignItems: "center",
    gap: RATE_ROW_GAP,
    height: BUBBLE_HEIGHT,
    // The stop button keeps the pill's full round end; only the chip side needs
    // breathing room, so the padding is asymmetric.
    paddingRight: RATE_ROW_PADDING,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.popover,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    ...theme.shadow.md,
  },
  failedBubble: {
    flexDirection: "row",
    alignItems: "center",
    height: BUBBLE_HEIGHT,
    maxWidth: FAILED_BUBBLE_WIDTH,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.popover,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    ...theme.shadow.md,
  },
  iconButton: {
    alignItems: "center",
    justifyContent: "center",
    // Stretch rather than a fixed height: the pill owns the border, so the
    // content box is shorter than BUBBLE_HEIGHT and a fixed child would spill.
    alignSelf: "stretch",
    width: ICON_BUTTON_WIDTH,
    flexShrink: 0,
  },
  failedContent: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "stretch",
    gap: theme.spacing[1],
  },
  rateChip: {
    alignItems: "center",
    justifyContent: "center",
    width: RATE_CHIP_WIDTH,
    height: BUBBLE_HEIGHT - RATE_ROW_PADDING * 2,
    borderRadius: theme.borderRadius.full,
  },
  rateChipActive: {
    alignItems: "center",
    justifyContent: "center",
    width: RATE_CHIP_WIDTH,
    height: BUBBLE_HEIGHT - RATE_ROW_PADDING * 2,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.accent,
  },
  rateLabel: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.xs,
    fontWeight: "500",
  },
  rateLabelActive: {
    color: theme.colors.accentForeground,
    fontSize: theme.fontSize.xs,
    fontWeight: "600",
  },
  icon: {
    color: theme.colors.foreground,
  },
  failedIcon: {
    color: theme.colors.destructive,
  },
  label: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: "500",
  },
}));
