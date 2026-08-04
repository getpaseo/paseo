import {
  Children,
  isValidElement,
  useCallback,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  Pressable,
  ScrollView,
  Text,
  View,
  type GestureResponderEvent,
  type PressableStateCallbackType,
} from "react-native";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MAX_CONTENT_WIDTH } from "@/constants/layout";
import type { Theme } from "@/styles/theme";
import { ComposerTrackRow, type ComposerTrackRowProps } from "./track-row";

export { ComposerTrackRow, type ComposerTrackRowProps };

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);

const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const TRACK_LIST_MAX_HEIGHT = 200;

/**
 * The lane above the composer input. Every contextual track an agent can have —
 * heartbeats, subagents — is a section of one card that tucks under the
 * composer's top edge, so tracks stack without each one claiming the seam.
 *
 * Sections are supplied as children and any of them may be absent; the caller
 * renders `null` for a track with nothing to show and the card disappears when
 * every track is empty.
 */
export function ComposerTracks({ children }: { children: ReactNode }): ReactElement | null {
  const sections = Children.toArray(children);
  if (sections.length === 0) {
    return null;
  }

  return (
    <View style={styles.outer} testID="composer-tracks">
      <View style={styles.track}>
        <View style={styles.surface}>
          {sections.map((section, index) => (
            <View
              key={isValidElement(section) ? String(section.key) : index}
              style={index === 0 ? undefined : styles.sectionDivided}
            >
              {section}
            </View>
          ))}
        </View>
      </View>
    </View>
  );
}

export interface ComposerTrackSectionProps {
  /** Names the track and its disclosure control: "2 subagents", "1 heartbeat". */
  label: string;
  testID: string;
  headerTestID: string;
  /** Optional control on the header row, e.g. a bulk action for the whole track. */
  renderHeaderAction?: () => ReactNode;
  children: ReactNode;
}

/**
 * One track: a disclosure header that names the track, and its rows. Collapsed
 * by default so a busy agent does not push the composer down the screen.
 */
export function ComposerTrackSection({
  label,
  testID,
  headerTestID,
  renderHeaderAction,
  children,
}: ComposerTrackSectionProps): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const toggleExpanded = useCallback(() => {
    setExpanded((current) => !current);
  }, []);

  const headerStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType) => [
      styles.headerToggle,
      (hovered || pressed) && styles.headerActive,
    ],
    [],
  );

  return (
    <View testID={testID}>
      <View style={expanded ? styles.headerExpanded : styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={expandedAccessibilityState(expanded)}
          testID={headerTestID}
          onPress={toggleExpanded}
          style={headerStyle}
        >
          {expanded ? (
            <ThemedChevronDown size={12} uniProps={foregroundMutedColorMapping} />
          ) : (
            <ThemedChevronRight size={12} uniProps={foregroundMutedColorMapping} />
          )}
          <Text style={styles.headerLabel} numberOfLines={1}>
            {label}
          </Text>
        </Pressable>
        {renderHeaderAction ? (
          <View style={styles.headerAction}>{renderHeaderAction()}</View>
        ) : null}
      </View>
      {expanded ? (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          nestedScrollEnabled
        >
          {children}
        </ScrollView>
      ) : null}
    </View>
  );
}

const EXPANDED_STATE = { expanded: true } as const;
const COLLAPSED_STATE = { expanded: false } as const;

function expandedAccessibilityState(expanded: boolean) {
  return expanded ? EXPANDED_STATE : COLLAPSED_STATE;
}

export interface ComposerTrackActionButtonProps {
  accessibilityLabel: string;
  testID: string;
  tooltipLabel: string;
  /** Callers own their themed icon so it re-renders alone on theme change. */
  renderIcon: (isActive: boolean) => ReactElement;
  onPress: () => void;
}

export function ComposerTrackActionButton({
  accessibilityLabel,
  testID,
  tooltipLabel,
  renderIcon,
  onPress,
}: ComposerTrackActionButtonProps): ReactElement {
  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      onPress();
    },
    [onPress],
  );

  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          testID={testID}
          onPress={handlePress}
          style={styles.actionButton}
          hitSlop={8}
        >
          {({ hovered, pressed }) => renderIcon(hovered || pressed)}
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <Text style={styles.tooltipText}>{tooltipLabel}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  outer: {
    width: "100%",
    alignItems: "center",
    paddingHorizontal: theme.spacing[4],
  },
  track: {
    width: "100%",
    maxWidth: MAX_CONTENT_WIDTH,
    // The composer overlaps the card's bottom edge, which is what makes the
    // tracks read as one surface with it.
    marginBottom: -theme.spacing[4],
  },
  surface: {
    alignSelf: "stretch",
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    borderBottomWidth: 0,
    borderTopLeftRadius: theme.borderRadius["2xl"],
    borderTopRightRadius: theme.borderRadius["2xl"],
    overflow: "hidden",
    paddingBottom: theme.spacing[4],
  },
  sectionDivided: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
  },
  headerExpanded: {
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  headerToggle: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingLeft: theme.spacing[3],
    paddingRight: theme.spacing[1],
    paddingVertical: theme.spacing[2],
  },
  headerAction: {
    paddingRight: theme.spacing[2],
  },
  headerActive: {
    backgroundColor: theme.colors.surface2,
  },
  headerLabel: {
    flexShrink: 1,
    minWidth: 0,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  scroll: {
    maxHeight: TRACK_LIST_MAX_HEIGHT,
  },
  scrollContent: {
    paddingVertical: theme.spacing[1],
  },
  actionButton: {
    padding: theme.spacing[1],
    alignItems: "center",
    justifyContent: "center",
  },
  tooltipText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
  },
}));
