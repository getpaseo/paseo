import {
  View,
  Text,
  Pressable,
  ActivityIndicator,
  LayoutChangeEvent,
  StyleProp,
  ViewStyle,
  Platform,
} from "react-native";
import {
  useState,
  useEffect,
  useRef,
  memo,
  useMemo,
  useCallback,
  createContext,
  useContext,
} from "react";
import type { ReactNode, ComponentType } from "react";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  Easing,
  cancelAnimation,
} from "react-native-reanimated";
import Svg, {
  Defs,
  LinearGradient,
  Stop,
  Rect,
} from "react-native-svg";
import Markdown, { MarkdownIt } from "react-native-markdown-display";
import * as Linking from "expo-linking";
import {
  Circle,
  Info,
  CheckCircle,
  XCircle,
  FileText,
  ChevronRight,
  ChevronDown,
  Check,
  CheckSquare,
  X,
  Copy,
  TriangleAlertIcon,
  Scissors,
} from "lucide-react-native";
import {
  StyleSheet,
  useUnistyles,
  UnistylesRuntime,
} from "react-native-unistyles";
import { theme } from "@/styles/theme";
import {
  createMarkdownStyles,
} from "@/styles/markdown-styles";
import { Colors, Fonts } from "@/constants/theme";
import * as Clipboard from "expo-clipboard";
import type { TodoEntry } from "@/types/stream";
import type { ToolCallDetail } from "@server/server/agent/agent-sdk-types";
import {
  buildToolCallDisplayModel,
} from "@/utils/tool-call-display";
import { resolveToolCallIcon } from "@/utils/tool-call-icon";
import { getNowMs, isPerfLoggingEnabled, perfLog } from "@/utils/perf";
import { parseInlinePathToken, type InlinePathTarget } from "@/utils/inline-path";
export type { InlinePathTarget } from "@/utils/inline-path";
import { useToolCallSheet } from "./tool-call-sheet";
import { ToolCallDetailsContent } from "./tool-call-details";

interface UserMessageProps {
  message: string;
  timestamp: number;
  isFirstInGroup?: boolean;
  isLastInGroup?: boolean;
  disableOuterSpacing?: boolean;
}

const MessageOuterSpacingContext = createContext(false);

export function MessageOuterSpacingProvider({
  disableOuterSpacing,
  children,
}: {
  disableOuterSpacing: boolean;
  children: ReactNode;
}) {
  return (
    <MessageOuterSpacingContext.Provider value={disableOuterSpacing}>
      {children}
    </MessageOuterSpacingContext.Provider>
  );
}

function useDisableOuterSpacing(disableOuterSpacing: boolean | undefined) {
  const contextValue = useContext(MessageOuterSpacingContext);
  return disableOuterSpacing ?? contextValue;
}

const userMessageStylesheet = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    justifyContent: "flex-end",
    paddingHorizontal: theme.spacing[2],
  },
  content: {
    alignItems: "flex-end",
    maxWidth: "100%",
  },
  containerSpacing: {
    marginBottom: theme.spacing[1],
  },
  containerFirstInGroup: {
    marginTop: theme.spacing[4],
  },
  containerLastInGroup: {
    marginBottom: theme.spacing[4],
  },
  bubble: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius["2xl"],
    borderTopRightRadius: theme.borderRadius.sm,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[4],
    minWidth: 0,
    flexShrink: 1,
  },
  text: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: 22,
    overflowWrap: "anywhere",
  },
  copyButton: {
    alignSelf: "flex-end",
    padding: theme.spacing[1],
    marginTop: theme.spacing[2],
  },
  copyButtonHidden: {
    opacity: 0,
  },
  copyButtonVisible: {
    opacity: 1,
  },
}));

export const UserMessage = memo(function UserMessage({
  message,
  timestamp,
  isFirstInGroup = true,
  isLastInGroup = true,
  disableOuterSpacing,
}: UserMessageProps) {
  const [messageHovered, setMessageHovered] = useState(false);
  const [copyButtonHovered, setCopyButtonHovered] = useState(false);
  const resolvedDisableOuterSpacing =
    useDisableOuterSpacing(disableOuterSpacing);
  const showCopyButton =
    Platform.OS !== "web" || messageHovered || copyButtonHovered;

  return (
    <View
      style={[
        userMessageStylesheet.container,
        !resolvedDisableOuterSpacing && [
          isFirstInGroup && { marginTop: theme.spacing[4] },
          isLastInGroup && { marginBottom: theme.spacing[4] },
          !isFirstInGroup || !isLastInGroup
            ? { marginBottom: theme.spacing[1] }
            : undefined,
        ],
      ]}
    >
      <Pressable
        style={userMessageStylesheet.content}
        onHoverIn={
          Platform.OS === "web" ? () => setMessageHovered(true) : undefined
        }
        onHoverOut={
          Platform.OS === "web" ? () => setMessageHovered(false) : undefined
        }
      >
        <View style={userMessageStylesheet.bubble}>
          <Text selectable style={userMessageStylesheet.text}>
            {message}
          </Text>
        </View>
        <TurnCopyButton
          getContent={() => message}
          containerStyle={[
            userMessageStylesheet.copyButton,
            showCopyButton
              ? userMessageStylesheet.copyButtonVisible
              : userMessageStylesheet.copyButtonHidden,
          ]}
          accessibilityLabel="Copy message"
          onHoverChange={setCopyButtonHovered}
        />
      </Pressable>
    </View>
  );
});

interface AssistantMessageProps {
  message: string;
  timestamp: number;
  onInlinePathPress?: (target: InlinePathTarget) => void;
  disableOuterSpacing?: boolean;
}

export const assistantMessageStylesheet = StyleSheet.create((theme) => ({
  container: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[3],
  },
  containerSpacing: {
    marginBottom: theme.spacing[4],
  },
  // Used in custom markdownRules for inline code styling
  markdownCodeInline: {
    backgroundColor: theme.colors.surface2,
    color: theme.colors.foreground,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    borderRadius: theme.borderRadius.sm,
    fontFamily: Fonts.mono,
    fontSize: 13,
  },
  // Used in custom markdownRules for path chip styling
  pathChip: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.full,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    marginRight: theme.spacing[1],
    marginVertical: 2,
  },
  pathChipText: {
    color: theme.colors.foreground,
    fontFamily: Fonts.mono,
    fontSize: 13,
  },
}));

const turnCopyButtonStylesheet = StyleSheet.create((theme) => ({
  container: {
    alignSelf: "flex-start",
    padding: theme.spacing[2],
    paddingTop: 0,
  },
  iconColor: {
    color: theme.colors.foregroundMuted,
  },
  iconHoveredColor: {
    color: theme.colors.foreground,
  },
}));

interface TurnCopyButtonProps {
  getContent: () => string;
  containerStyle?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  copiedAccessibilityLabel?: string;
  onHoverChange?: (hovered: boolean) => void;
}

export const TurnCopyButton = memo(function TurnCopyButton({
  getContent,
  containerStyle,
  accessibilityLabel,
  copiedAccessibilityLabel,
  onHoverChange,
}: TurnCopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCopy = useCallback(async () => {
    const content = getContent();
    if (!content) {
      return;
    }

    await Clipboard.setStringAsync(content);
    setCopied(true);

    if (copyTimeoutRef.current) {
      clearTimeout(copyTimeoutRef.current);
    }

    copyTimeoutRef.current = setTimeout(() => {
      setCopied(false);
      copyTimeoutRef.current = null;
    }, 1500);
  }, [getContent]);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  return (
    <Pressable
      onPress={handleCopy}
      onHoverIn={Platform.OS === "web" ? () => onHoverChange?.(true) : undefined}
      onHoverOut={Platform.OS === "web" ? () => onHoverChange?.(false) : undefined}
      style={[turnCopyButtonStylesheet.container, containerStyle]}
      accessibilityRole="button"
      accessibilityLabel={
        copied
          ? (copiedAccessibilityLabel ?? "Copied")
          : (accessibilityLabel ?? "Copy turn")
      }
    >
      {({ hovered }) => {
        const iconColor = hovered
          ? turnCopyButtonStylesheet.iconHoveredColor.color
          : turnCopyButtonStylesheet.iconColor.color;
        return copied ? (
          <Check size={18} color={iconColor} />
        ) : (
          <Copy size={18} color={iconColor} />
        );
      }}
    </Pressable>
  );
});

const expandableBadgeStylesheet = StyleSheet.create((theme) => ({
  container: {
    marginHorizontal: theme.spacing[2],
  },
  containerSpacing: {
    marginBottom: theme.spacing[1],
  },
  containerLastInSequence: {
    marginBottom: theme.spacing[4],
  },
  pressable: {
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    overflow: "hidden",
  },
  pressablePressed: {
    opacity: 0.9,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  labelRow: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    overflow: "hidden",
  },
  iconBadge: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
    marginRight: theme.spacing[2],
    backgroundColor: "transparent",
  },
  label: {
    color: theme.colors.foreground,
    opacity: 0.88,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    flexShrink: 0,
  },
  secondaryLabel: {
    flex: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    marginLeft: theme.spacing[2],
  },
  spacer: {
    flex: 1,
  },
  chevron: {
    marginLeft: theme.spacing[1],
    flexShrink: 0,
  },
  detailWrapper: {
    borderBottomLeftRadius: theme.borderRadius.lg,
    borderBottomRightRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderTopWidth: 0,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    padding: 0,
    gap: 0,
    flexShrink: 1,
    minWidth: 0,
    overflow: "hidden",
  },
  pressableExpanded: {
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
  },
  shimmerOverlay: {
    position: "absolute",
    top: 0,
    bottom: 0,
  },
}));

export const AssistantMessage = memo(function AssistantMessage({
  message,
  timestamp,
  onInlinePathPress,
  disableOuterSpacing,
}: AssistantMessageProps) {
  const { theme } = useUnistyles();
  const resolvedDisableOuterSpacing =
    useDisableOuterSpacing(disableOuterSpacing);

  const markdownStyles = useMemo(() => createMarkdownStyles(theme), [theme]);

  const markdownParser = useMemo(
    () => MarkdownIt({ typographer: true, linkify: true }),
    []
  );

  const handleLinkPress = useCallback((url: string) => {
    if (Platform.OS === "web") {
      window.open(url, "_blank", "noopener,noreferrer");
    } else {
      void Linking.openURL(url);
    }
    return true;
  }, []);

  const markdownRules = useMemo(() => {
    return {
      text: (
        node: any,
        _children: ReactNode[],
        _parent: any,
        styles: any,
        inheritedStyles: any = {}
      ) => (
        <Text key={node.key} style={[inheritedStyles, styles.text]}>
          {node.content}
        </Text>
      ),
      textgroup: (
        node: any,
        children: ReactNode[],
        _parent: any,
        styles: any,
        inheritedStyles: any = {}
      ) => (
        <Text
          key={node.key}
          style={[inheritedStyles, styles.textgroup]}
        >
          {children}
        </Text>
      ),
      code_block: (
        node: any,
        _children: ReactNode[],
        _parent: any,
        styles: any,
        inheritedStyles: any = {}
      ) => (
        <Text
          key={node.key}
          style={[inheritedStyles, styles.code_block]}
        >
          {node.content}
        </Text>
      ),
      fence: (
        node: any,
        _children: ReactNode[],
        _parent: any,
        styles: any,
        inheritedStyles: any = {}
      ) => (
        <Text key={node.key} style={[inheritedStyles, styles.fence]}>
          {node.content}
        </Text>
      ),
      code_inline: (
        node: any,
        _children: ReactNode[],
        _parent: any,
        _styles: any,
        inheritedStyles: any = {}
      ) => {
        const content = node.content ?? "";
        const parsed = onInlinePathPress
          ? parseInlinePathToken(content)
          : null;

        if (!parsed) {
          return (
            <Text
              key={node.key}
              style={[
                inheritedStyles,
                assistantMessageStylesheet.markdownCodeInline,
              ]}
            >
              {content}
            </Text>
          );
        }

        return (
          <Text
            key={node.key}
            onPress={() => parsed && onInlinePathPress?.(parsed)}
            selectable={false}
            style={[
              assistantMessageStylesheet.pathChip,
              assistantMessageStylesheet.pathChipText,
            ]}
          >
            {content}
          </Text>
        );
      },
      bullet_list: (
        node: any,
        children: ReactNode[],
        _parent: any,
        styles: any
      ) => (
        <View key={node.key} style={styles.bullet_list}>
          {children}
        </View>
      ),
      ordered_list: (
        node: any,
        children: ReactNode[],
        _parent: any,
        styles: any
      ) => (
        <View key={node.key} style={styles.ordered_list}>
          {children}
        </View>
      ),
      list_item: (
        node: any,
        children: ReactNode[],
        parent: any,
        styles: any
      ) => {
        const isOrdered = parent?.type === "ordered_list";
        const index = parent?.children?.indexOf(node) ?? 0;
        const bullet = isOrdered ? `${index + 1}.` : "•";
        const iconStyle = isOrdered
          ? styles.ordered_list_icon
          : styles.bullet_list_icon;
        const contentStyle = isOrdered
          ? styles.ordered_list_content
          : styles.bullet_list_content;

        return (
          <View key={node.key} style={styles.list_item}>
            <Text style={iconStyle}>{bullet}</Text>
            <View
              style={[contentStyle, { flex: 1, flexShrink: 1, minWidth: 0 }]}
            >
              {children}
            </View>
          </View>
        );
      },
    };
  }, [onInlinePathPress]);

  return (
    <View
      testID="assistant-message"
      style={[
        assistantMessageStylesheet.container,
        !resolvedDisableOuterSpacing &&
          assistantMessageStylesheet.containerSpacing,
      ]}
    >
      <Markdown
        style={markdownStyles}
        rules={markdownRules}
        markdownit={markdownParser}
        onLinkPress={handleLinkPress}
      >
        {message}
      </Markdown>
    </View>
  );
});

interface ActivityLogProps {
  type: "system" | "info" | "success" | "error" | "artifact";
  message: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
  artifactId?: string;
  artifactType?: string;
  title?: string;
  onArtifactClick?: (artifactId: string) => void;
  disableOuterSpacing?: boolean;
}

const activityLogStylesheet = StyleSheet.create((theme) => ({
  pressable: {
    marginHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    overflow: "hidden",
  },
  pressableSpacing: {
    marginBottom: theme.spacing[1],
  },
  pressableActive: {
    opacity: 0.7,
  },
  systemBg: {
    backgroundColor: "rgba(39, 39, 42, 0.5)",
  },
  infoBg: {
    backgroundColor: "rgba(30, 58, 138, 0.3)",
  },
  successBg: {
    backgroundColor: "rgba(20, 83, 45, 0.3)",
  },
  errorBg: {
    backgroundColor: "rgba(127, 29, 29, 0.3)",
  },
  artifactBg: {
    backgroundColor: "rgba(30, 58, 138, 0.4)",
  },
  content: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: 10,
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
  },
  iconContainer: {
    flexShrink: 0,
  },
  textContainer: {
    flex: 1,
  },
  messageText: {
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
  },
  detailsRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: theme.spacing[1],
  },
  detailsText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    marginRight: theme.spacing[1],
  },
  metadataContainer: {
    marginTop: theme.spacing[2],
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    borderRadius: theme.borderRadius.base,
    padding: theme.spacing[2],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  metadataText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    fontFamily: Fonts.mono,
    lineHeight: 16,
  },
}));

export const ActivityLog = memo(function ActivityLog({
  type,
  message,
  timestamp,
  metadata,
  artifactId,
  artifactType,
  title,
  onArtifactClick,
  disableOuterSpacing,
}: ActivityLogProps) {
  const resolvedDisableOuterSpacing =
    useDisableOuterSpacing(disableOuterSpacing);
  const [isExpanded, setIsExpanded] = useState(false);

  const typeConfig = {
    system: {
      bg: activityLogStylesheet.systemBg,
      color: "#a1a1aa",
      Icon: Circle,
    },
    info: { bg: activityLogStylesheet.infoBg, color: "#60a5fa", Icon: Info },
    success: {
      bg: activityLogStylesheet.successBg,
      color: "#4ade80",
      Icon: CheckCircle,
    },
    error: {
      bg: activityLogStylesheet.errorBg,
      color: "#f87171",
      Icon: XCircle,
    },
    artifact: {
      bg: activityLogStylesheet.artifactBg,
      color: "#93c5fd",
      Icon: FileText,
    },
  };

  const config = typeConfig[type];
  const IconComponent = config.Icon;

  const handlePress = () => {
    if (type === "artifact" && artifactId && onArtifactClick) {
      onArtifactClick(artifactId);
    } else if (metadata) {
      setIsExpanded(!isExpanded);
    }
  };

  const displayMessage =
    type === "artifact" && artifactType && title
      ? `${artifactType}: ${title}`
      : message;

  const isInteractive = type === "artifact" || metadata;

  return (
    <Pressable
      onPress={handlePress}
      disabled={!isInteractive}
      style={[
        activityLogStylesheet.pressable,
        !resolvedDisableOuterSpacing && activityLogStylesheet.pressableSpacing,
        config.bg,
        isInteractive && activityLogStylesheet.pressableActive,
      ]}
    >
      <View style={activityLogStylesheet.content}>
        <View style={activityLogStylesheet.row}>
          <View style={activityLogStylesheet.iconContainer}>
            <IconComponent size={16} color={config.color} />
          </View>
          <View style={activityLogStylesheet.textContainer}>
            <Text
              style={[
                activityLogStylesheet.messageText,
                { color: config.color },
              ]}
            >
              {displayMessage}
            </Text>
            {metadata && (
              <View style={activityLogStylesheet.detailsRow}>
                <Text style={activityLogStylesheet.detailsText}>Details</Text>
                {isExpanded ? (
                  <ChevronDown size={12} color="#71717a" />
                ) : (
                  <ChevronRight size={12} color="#71717a" />
                )}
              </View>
            )}
          </View>
        </View>
        {isExpanded && metadata && (
          <View style={activityLogStylesheet.metadataContainer}>
            <Text style={activityLogStylesheet.metadataText}>
              {JSON.stringify(metadata, null, 2)}
            </Text>
          </View>
        )}
      </View>
    </Pressable>
  );
});

interface CompactionMarkerProps {
  status: "loading" | "completed";
  preTokens?: number;
}

const compactionStylesheet = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    gap: theme.spacing[2],
  },
  line: {
    flex: 1,
    height: 1,
    backgroundColor: theme.colors.border,
  },
  label: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  text: {
    fontFamily: Fonts.sans,
    fontSize: 13,
    color: theme.colors.foregroundMuted,
  },
}));

export const CompactionMarker = memo(function CompactionMarker({
  status,
  preTokens,
}: CompactionMarkerProps) {
  const label =
    status === "loading"
      ? "Compacting..."
      : preTokens
        ? `Context compacted (${Math.round(preTokens / 1000)}K tokens)`
        : "Context compacted";

  return (
    <View style={compactionStylesheet.container}>
      <View style={compactionStylesheet.line} />
      <View style={compactionStylesheet.label}>
        {status === "loading" ? (
          <ActivityIndicator size="small" color="#a1a1aa" />
        ) : (
          <Scissors size={12} color="#a1a1aa" />
        )}
        <Text style={compactionStylesheet.text}>{label}</Text>
      </View>
      <View style={compactionStylesheet.line} />
    </View>
  );
});

interface TodoListCardProps {
  items: TodoEntry[];
  disableOuterSpacing?: boolean;
}

const todoListCardStylesheet = StyleSheet.create((theme) => ({
  detailsWrapper: {
    padding: theme.spacing[2],
  },
  list: {
    gap: theme.spacing[1],
  },
  itemRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  radioBadge: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: theme.colors.foregroundMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  radioBadgeIncomplete: {
    opacity: 0.55,
  },
  radioBadgeComplete: {
    opacity: 0.95,
  },
  itemText: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  itemTextCompleted: {
    color: theme.colors.foregroundMuted,
    textDecorationLine: "line-through",
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
}));

export const TodoListCard = memo(function TodoListCard({
  items,
  disableOuterSpacing,
}: TodoListCardProps) {
  const { theme: unistylesTheme } = useUnistyles();
  const [isExpanded, setIsExpanded] = useState(false);

  const nextTask = useMemo(() => items.find((item) => !item.completed)?.text, [items]);

  const handleToggle = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  const renderDetails = useCallback(() => {
    return (
      <View style={todoListCardStylesheet.detailsWrapper}>
        <View style={todoListCardStylesheet.list}>
          {items.length === 0 ? (
            <Text style={todoListCardStylesheet.emptyText}>No tasks yet.</Text>
          ) : (
            items.map((item, idx) => (
              <View key={`${item.text}-${idx}`} style={todoListCardStylesheet.itemRow}>
                <View
                  style={[
                    todoListCardStylesheet.radioBadge,
                    item.completed
                      ? todoListCardStylesheet.radioBadgeComplete
                      : todoListCardStylesheet.radioBadgeIncomplete,
                  ]}
                >
                  {item.completed ? (
                    <Check size={12} color={unistylesTheme.colors.primaryForeground} />
                  ) : null}
                </View>
                <Text
                  style={[
                    todoListCardStylesheet.itemText,
                    item.completed && todoListCardStylesheet.itemTextCompleted,
                  ]}
                >
                  {item.text}
                </Text>
              </View>
            ))
          )}
        </View>
      </View>
    );
  }, [items]);

  return (
    <ExpandableBadge
      label="Tasks"
      secondaryLabel={nextTask}
      icon={CheckSquare}
      isExpanded={isExpanded}
      onToggle={handleToggle}
      renderDetails={renderDetails}
      disableOuterSpacing={disableOuterSpacing}
    />
  );
});

interface ExpandableBadgeProps {
  label: string;
  secondaryLabel?: string;
  icon?: ComponentType<{ size?: number; color?: string }>;
  isExpanded: boolean;
  style?: StyleProp<ViewStyle>;
  onToggle?: () => void;
  onDetailHoverChange?: (hovered: boolean) => void;
  renderDetails?: () => ReactNode;
  isLoading?: boolean;
  isError?: boolean;
  isLastInSequence?: boolean;
  disableOuterSpacing?: boolean;
  testID?: string;
}

const ExpandableBadge = memo(function ExpandableBadge({
  label,
  style,
  secondaryLabel,
  icon,
  isExpanded,
  onToggle,
  onDetailHoverChange,
  renderDetails,
  isLoading = false,
  isError = false,
  isLastInSequence = false,
  disableOuterSpacing,
  testID,
}: ExpandableBadgeProps) {
  const { theme } = useUnistyles();
  const resolvedDisableOuterSpacing =
    useDisableOuterSpacing(disableOuterSpacing);
  const hasDetails = Boolean(renderDetails);
  const detailContent = hasDetails && isExpanded ? renderDetails?.() : null;

  const [badgeWidth, setBadgeWidth] = useState(0);
  const handleLayout = useCallback((e: LayoutChangeEvent) => {
    setBadgeWidth(e.nativeEvent.layout.width);
  }, []);

  const shimmer = useSharedValue(-1);

  useEffect(() => {
    if (isLoading) {
      shimmer.value = -1;
      shimmer.value = withRepeat(
        withTiming(1, { duration: 2400, easing: Easing.bezier(0.4, 0, 0.6, 1) }),
        -1
      );
    } else {
      cancelAnimation(shimmer);
      shimmer.value = -1;
    }
  }, [isLoading]);

  const shimmerBandWidth = 18;
  const shimmerStyle = useAnimatedStyle(() => {
    const travel = badgeWidth + shimmerBandWidth;
    return {
      transform: [
        {
          translateX:
            -shimmerBandWidth + ((shimmer.value + 1) / 2) * travel,
        },
      ],
    };
  });

  const IconComponent = icon;
  const iconColor = isError
    ? theme.colors.destructive
    : theme.colors.mutedForeground;

  let iconNode: ReactNode = null;
  if (isError) {
    iconNode = <TriangleAlertIcon size={12} color={iconColor} opacity={0.8} />;
  } else if (IconComponent) {
    iconNode = <IconComponent size={12} color={iconColor} />;
  }

  return (
    <View
      style={[
        expandableBadgeStylesheet.container,
        !resolvedDisableOuterSpacing &&
          (isLastInSequence
            ? expandableBadgeStylesheet.containerLastInSequence
            : expandableBadgeStylesheet.containerSpacing),
        style,
      ]}
      testID={testID}
    >
      <Pressable
        onPress={hasDetails ? onToggle : undefined}
        onLayout={handleLayout}
        disabled={!hasDetails}
        accessibilityRole={hasDetails ? "button" : undefined}
        accessibilityState={hasDetails ? { expanded: isExpanded } : undefined}
        style={({ pressed }) => [
          expandableBadgeStylesheet.pressable,
          pressed && hasDetails
            ? expandableBadgeStylesheet.pressablePressed
            : null,
          isExpanded && expandableBadgeStylesheet.pressableExpanded,
        ]}
      >
        {({ hovered }) => (
          <>
            <View style={expandableBadgeStylesheet.headerRow}>
              <View style={expandableBadgeStylesheet.iconBadge}>{iconNode}</View>
              <View style={expandableBadgeStylesheet.labelRow}>
                <Text style={expandableBadgeStylesheet.label} numberOfLines={1}>
                  {label}
                </Text>
                {secondaryLabel ? (
                  <Text
                    style={expandableBadgeStylesheet.secondaryLabel}
                    numberOfLines={1}
                  >
                    {secondaryLabel}
                  </Text>
                ) : (
                  <View style={expandableBadgeStylesheet.spacer} />
                )}
                {isLoading && badgeWidth > 0 ? (
                  <Animated.View
                    pointerEvents="none"
                    style={[
                      expandableBadgeStylesheet.shimmerOverlay,
                      { width: shimmerBandWidth },
                      shimmerStyle,
                    ]}
                  >
                    <Svg width="100%" height="100%" preserveAspectRatio="none">
                      <Defs>
                        <LinearGradient
                          id="shimmerGrad"
                          x1="0"
                          y1="0"
                          x2="1"
                          y2="0"
                        >
                          <Stop offset="0" stopColor={theme.colors.surface1} stopOpacity="0" />
                          <Stop offset="0.42" stopColor={theme.colors.surface1} stopOpacity="0" />
                          <Stop offset="0.48" stopColor={theme.colors.surface1} stopOpacity="0.35" />
                          <Stop offset="0.5" stopColor={theme.colors.surface1} stopOpacity="1" />
                          <Stop offset="0.52" stopColor={theme.colors.surface1} stopOpacity="0.35" />
                          <Stop offset="0.58" stopColor={theme.colors.surface1} stopOpacity="0" />
                          <Stop offset="1" stopColor={theme.colors.surface1} stopOpacity="0" />
                        </LinearGradient>
                      </Defs>
                      <Rect width="100%" height="100%" fill="url(#shimmerGrad)" />
                    </Svg>
                  </Animated.View>
                ) : null}
              </View>
              {hasDetails && hovered ? (
                <ChevronRight
                  size={14}
                  color={theme.colors.foregroundMuted}
                  style={[
                    expandableBadgeStylesheet.chevron,
                    { transform: [{ rotate: isExpanded ? "90deg" : "0deg" }] },
                  ]}
                />
              ) : null}
            </View>
          </>
        )}
      </Pressable>
      {detailContent ? (
        <Pressable
          style={expandableBadgeStylesheet.detailWrapper}
          onHoverIn={() => onDetailHoverChange?.(true)}
          onHoverOut={() => onDetailHoverChange?.(false)}
        >
          {detailContent}
        </Pressable>
      ) : null}
    </View>
  );
});

interface ToolCallProps {
  toolName: string;
  args?: unknown | null;
  result?: unknown | null;
  error?: unknown | null;
  status: "executing" | "running" | "completed" | "failed" | "canceled";
  detail?: ToolCallDetail;
  cwd?: string;
  metadata?: Record<string, unknown>;
  isLastInSequence?: boolean;
  disableOuterSpacing?: boolean;
  onInlineDetailsHoverChange?: (hovered: boolean) => void;
  onInlineDetailsExpandedChange?: (expanded: boolean) => void;
}

const TOOL_CALL_LOG_TAG = "[ToolCall]";
const TOOL_CALL_COMMIT_THRESHOLD_MS = 16;


export const ToolCall = memo(function ToolCall({
  toolName,
  args,
  result,
  error,
  status,
  detail,
  cwd,
  metadata,
  isLastInSequence = false,
  disableOuterSpacing,
  onInlineDetailsHoverChange,
  onInlineDetailsExpandedChange,
}: ToolCallProps) {
  const { openToolCall } = useToolCallSheet();
  const [isExpanded, setIsExpanded] = useState(false);
  const toggleStartRef = useRef<number | null>(null);

  // Check if we're on mobile (use bottom sheet) or desktop (inline expand)
  const isMobile =
    UnistylesRuntime.breakpoint === "xs" ||
    UnistylesRuntime.breakpoint === "sm";

  const effectiveDetail = useMemo<ToolCallDetail | undefined>(() => {
    if (detail) {
      return detail;
    }
    if (args !== undefined || result !== undefined) {
      return {
        type: "unknown",
        rawInput: args ?? null,
        rawOutput: result ?? null,
      };
    }
    return undefined;
  }, [detail, args, result]);

  const displayDetail =
    effectiveDetail ?? {
      type: "unknown",
      rawInput: null,
      rawOutput: null,
    };

  const displayModel = useMemo(
    () =>
      buildToolCallDisplayModel({
        name: toolName,
        status: status === "executing" ? "running" : status,
        error: error ?? null,
        detail: displayDetail,
        metadata,
        cwd,
      }),
    [toolName, status, error, displayDetail, metadata, cwd]
  );
  const displayName = displayModel.displayName;
  const summary = displayModel.summary;
  const errorText = displayModel.errorText;
  const iconCategory = effectiveDetail?.type ?? toolName.trim().toLowerCase();
  const IconComponent = resolveToolCallIcon(toolName, effectiveDetail);

  // Check if there's any content to display
  const hasDetails =
    Boolean(error) ||
    (effectiveDetail
      ? effectiveDetail.type !== "unknown" ||
        effectiveDetail.rawInput !== null ||
        effectiveDetail.rawOutput !== null
      : false);

  const handleToggle = useCallback(() => {
    if (!isMobile && isPerfLoggingEnabled()) {
      toggleStartRef.current = getNowMs();
    }
    if (isMobile) {
      openToolCall({
        toolName,
        displayName,
        summary,
        detail: effectiveDetail,
        errorText,
      });
    } else {
      setIsExpanded((prev) => !prev);
    }
  }, [isMobile, openToolCall, toolName, displayName, summary, effectiveDetail, errorText]);

  useEffect(() => {
    if (isMobile || !isPerfLoggingEnabled()) {
      return;
    }
    const startMs = toggleStartRef.current;
    if (startMs === null) {
      return;
    }
    toggleStartRef.current = null;
    const logCommit = () => {
      const durationMs = getNowMs() - startMs;
      if (durationMs >= TOOL_CALL_COMMIT_THRESHOLD_MS) {
        perfLog(TOOL_CALL_LOG_TAG, {
          event: isExpanded ? "expand_commit" : "collapse_commit",
          toolName,
          iconCategory,
          durationMs: Math.round(durationMs),
        });
      }
    };
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => logCommit());
    } else {
      logCommit();
    }
  }, [isExpanded, isMobile, toolName, iconCategory]);

  useEffect(() => {
    if (!onInlineDetailsHoverChange || isMobile || isExpanded) {
      return;
    }
    onInlineDetailsHoverChange(false);
  }, [isExpanded, isMobile, onInlineDetailsHoverChange]);

  useEffect(() => {
    if (!onInlineDetailsExpandedChange) {
      return;
    }
    if (isMobile) {
      onInlineDetailsExpandedChange(false);
      return;
    }
    onInlineDetailsExpandedChange(isExpanded);
  }, [isExpanded, isMobile, onInlineDetailsExpandedChange]);

  useEffect(() => {
    if (!onInlineDetailsExpandedChange) {
      return;
    }
    return () => {
      onInlineDetailsExpandedChange(false);
    };
  }, [onInlineDetailsExpandedChange]);

  // Render inline details for desktop
  const renderDetails = useCallback(() => {
    if (isMobile) return null;
    return (
      <ToolCallDetailsContent
        detail={effectiveDetail}
        errorText={errorText}
        maxHeight={400}
      />
    );
  }, [isMobile, effectiveDetail, errorText]);

  return (
    <ExpandableBadge
      testID="tool-call-badge"
      label={displayName}
      secondaryLabel={summary}
      icon={IconComponent}
      isExpanded={!isMobile && isExpanded}
      onToggle={hasDetails ? handleToggle : undefined}
      renderDetails={
        hasDetails && !isMobile
          ? renderDetails
          : hasDetails
            ? () => null
            : undefined
      }
      isLoading={status === "executing" || status === "running"}
      isError={status === "failed"}
      isLastInSequence={isLastInSequence}
      disableOuterSpacing={disableOuterSpacing}
      onDetailHoverChange={onInlineDetailsHoverChange}
    />
  );
});
