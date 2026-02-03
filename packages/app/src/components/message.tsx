import {
  View,
  Text,
  Pressable,
  Animated,
  StyleProp,
  ViewStyle,
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
  Loader2,
  Check,
  CheckSquare,
  X,
  Wrench,
  Pencil,
  Eye,
  SquareTerminal,
  Search,
  Brain,
  Copy,
  TriangleAlertIcon,
} from "lucide-react-native";
import {
  StyleSheet,
  useUnistyles,
  UnistylesRuntime,
} from "react-native-unistyles";
import { baseColors, theme } from "@/styles/theme";
import {
  createMarkdownStyles,
} from "@/styles/markdown-styles";
import { Colors, Fonts } from "@/constants/theme";
import * as Clipboard from "expo-clipboard";
import type { TodoEntry } from "@/types/stream";
import { extractPrincipalParam } from "@/utils/tool-call-parsers";
import { getNowMs, isPerfLoggingEnabled, perfLog } from "@/utils/perf";
import { resolveToolCallPreview } from "./tool-call-preview";
import { useToolCallSheet } from "./tool-call-sheet";
import {
  ToolCallDetailsContent,
  useToolCallDetails,
} from "./tool-call-details";

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
  bubblePressed: {
    opacity: 0.85,
  },
  copiedTagContainer: {
    marginTop: theme.spacing[1],
    marginRight: theme.spacing[4],
    alignSelf: "flex-end",
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.base,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 4,
  },
  copiedTagText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
  },
}));

export const UserMessage = memo(function UserMessage({
  message,
  timestamp,
  isFirstInGroup = true,
  isLastInGroup = true,
  disableOuterSpacing,
}: UserMessageProps) {
  const resolvedDisableOuterSpacing =
    useDisableOuterSpacing(disableOuterSpacing);
  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleLongPress = useCallback(async () => {
    if (!message) {
      return;
    }

    await Clipboard.setStringAsync(message);
    setCopied(true);

    if (copyTimeoutRef.current) {
      clearTimeout(copyTimeoutRef.current);
    }

    copyTimeoutRef.current = setTimeout(() => {
      setCopied(false);
      copyTimeoutRef.current = null;
    }, 1500);
  }, [message]);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

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
        accessibilityRole="button"
        accessibilityLabel="Copy message"
        accessibilityHint="Long press to copy this message"
        delayLongPress={250}
        onLongPress={handleLongPress}
        style={({ pressed }) => [
          userMessageStylesheet.bubble,
          pressed ? userMessageStylesheet.bubblePressed : null,
        ]}
      >
        <Text style={userMessageStylesheet.text}>{message}</Text>
      </Pressable>
      {copied && (
        <View style={userMessageStylesheet.copiedTagContainer}>
          <Text style={userMessageStylesheet.copiedTagText}>
            Copied to clipboard
          </Text>
        </View>
      )}
    </View>
  );
});

export interface InlinePathTarget {
  raw: string;
  path: string;
  lineStart?: number;
  lineEnd?: number;
}

interface AssistantMessageProps {
  message: string;
  timestamp: number;
  onInlinePathPress?: (target: InlinePathTarget) => void;
  disableOuterSpacing?: boolean;
}

export const assistantMessageStylesheet = StyleSheet.create((theme) => ({
  container: {
    paddingHorizontal: theme.spacing[4],
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
    marginLeft: theme.spacing[4],
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
}

export const TurnCopyButton = memo(function TurnCopyButton({
  getContent,
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
      style={turnCopyButtonStylesheet.container}
      accessibilityRole="button"
      accessibilityLabel={copied ? "Copied" : "Copy turn"}
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
    borderColor: theme.colors.borderAccent,
    backgroundColor: theme.colors.surface2,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  pressablePressed: {
    opacity: 0.9,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
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
    borderColor: theme.colors.borderAccent,
    backgroundColor: theme.colors.surface0,
    padding: theme.spacing[2],
    gap: theme.spacing[2],
    flexShrink: 1,
    minWidth: 0,
  },
  pressableExpanded: {
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
  },
}));

function isLikelyPathToken(value: string): boolean {
  if (!value || value.length > 300) {
    return false;
  }

  if (/\s/.test(value)) {
    return false;
  }

  const hasSlash = value.includes("/") || value.includes("\\");
  const hasExtension = /\.[a-zA-Z0-9]{1,8}$/.test(value);

  if (!hasSlash && !hasExtension) {
    return false;
  }

  const looksLikeDir =
    value.endsWith("/") || value.startsWith("./") || value.startsWith("../");

  return hasExtension || looksLikeDir || value.includes("/");
}

function normalizeInlinePathValue(value: string): string | null {
  const trimmed = value
    .trim()
    .replace(/^['"`]/, "")
    .replace(/['"`]$/, "");
  if (!trimmed) {
    return null;
  }

  return trimmed.replace(/\\/g, "/");
}

function parseInlinePathToken(
  value: string,
  lastPathRef: React.MutableRefObject<string | null>
): InlinePathTarget | null {
  const rawValue = value ?? "";
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return null;
  }

  const rangeOnlyMatch = trimmed.match(/^:([0-9]+)(?:-([0-9]+))?$/);
  if (rangeOnlyMatch) {
    const basePath = lastPathRef.current;
    if (!basePath) {
      return null;
    }
    const lineStart = parseInt(rangeOnlyMatch[1], 10);
    const lineEnd = rangeOnlyMatch[2]
      ? parseInt(rangeOnlyMatch[2], 10)
      : undefined;
    return {
      raw: rawValue,
      path: basePath,
      lineStart,
      lineEnd,
    };
  }

  const pathMatch = trimmed.match(/^(.*?)(?::([0-9]+)(?:-([0-9]+))?)?$/);
  if (!pathMatch) {
    return null;
  }

  const basePath = pathMatch[1]?.trim();
  if (!basePath || !isLikelyPathToken(basePath)) {
    return null;
  }

  const normalizedPath = normalizeInlinePathValue(basePath);
  if (!normalizedPath) {
    return null;
  }

  lastPathRef.current = normalizedPath;

  const lineStart = pathMatch[2] ? parseInt(pathMatch[2], 10) : undefined;
  const lineEnd = pathMatch[3] ? parseInt(pathMatch[3], 10) : undefined;

  return {
    raw: rawValue,
    path: normalizedPath,
    lineStart,
    lineEnd,
  };
}

export const AssistantMessage = memo(function AssistantMessage({
  message,
  timestamp,
  onInlinePathPress,
  disableOuterSpacing,
}: AssistantMessageProps) {
  const { theme } = useUnistyles();
  const resolvedDisableOuterSpacing =
    useDisableOuterSpacing(disableOuterSpacing);
  const lastPathRef = useRef<string | null>(null);

  const markdownStyles = useMemo(() => createMarkdownStyles(theme), [theme]);

  const markdownParser = useMemo(
    () => MarkdownIt({ typographer: true, linkify: true }),
    []
  );

  const handleLinkPress = useCallback((url: string) => {
    void Linking.openURL(url);
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
          ? parseInlinePathToken(content, lastPathRef)
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

interface TodoListCardProps {
  items: TodoEntry[];
  disableOuterSpacing?: boolean;
}

const todoListCardStylesheet = StyleSheet.create((theme) => ({
  list: {
    gap: theme.spacing[1],
  },
  itemRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  radioOuter: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.foregroundMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  radioInner: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.foregroundMuted,
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
  const [isExpanded, setIsExpanded] = useState(true);

  const handleToggle = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  const renderDetails = useCallback(() => {
    return (
      <View style={todoListCardStylesheet.list}>
        {items.length === 0 ? (
          <Text style={todoListCardStylesheet.emptyText}>No tasks yet.</Text>
        ) : (
          items.map((item, idx) => (
            <View key={`${item.text}-${idx}`} style={todoListCardStylesheet.itemRow}>
              <View style={todoListCardStylesheet.radioOuter}>
                {item.completed ? <View style={todoListCardStylesheet.radioInner} /> : null}
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
    );
  }, [items]);

  return (
    <ExpandableBadge
      label="Tasks"
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

  const spinAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    let loop: Animated.CompositeAnimation | null = null;
    if (isLoading) {
      spinAnim.setValue(0);
      loop = Animated.loop(
        Animated.timing(spinAnim, {
          toValue: 1,
          duration: 1400,
          useNativeDriver: true,
          easing: (t) => t,
        })
      );
      loop.start();
    } else {
      spinAnim.stopAnimation();
    }

    return () => {
      loop?.stop();
    };
  }, [isLoading, spinAnim]);

  const spin = useMemo(
    () =>
      spinAnim.interpolate({
        inputRange: [0, 1],
        outputRange: ["0deg", "360deg"],
      }),
    [spinAnim]
  );

  const IconComponent = icon;
  const iconColor = isError
    ? theme.colors.destructive
    : theme.colors.mutedForeground;

  let iconNode: ReactNode = null;
  if (isLoading) {
    iconNode = (
      <Animated.View style={{ transform: [{ rotate: spin }] }}>
        <Loader2 size={12} color={iconColor} />
      </Animated.View>
    );
  } else if (isError) {
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
        <View style={expandableBadgeStylesheet.headerRow}>
          <View style={expandableBadgeStylesheet.iconBadge}>{iconNode}</View>
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
          {hasDetails ? (
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
      </Pressable>
      {detailContent ? (
        <View style={expandableBadgeStylesheet.detailWrapper}>
          {detailContent}
        </View>
      ) : null}
    </View>
  );
});

interface ToolCallProps {
  toolName: string;
  args: any;
  result?: any;
  error?: any;
  status: "executing" | "completed" | "failed";
  cwd?: string;
  isLastInSequence?: boolean;
  disableOuterSpacing?: boolean;
}

// Icon mapping for tool kinds
const toolKindIcons: Record<string, any> = {
  edit: Pencil,
  read: Eye,
  execute: SquareTerminal,
  search: Search,
  thinking: Brain,
};
const TOOL_CALL_LOG_TAG = "[ToolCall]";
const TOOL_CALL_COMMIT_THRESHOLD_MS = 16;

// Derive tool kind from tool name for icon selection
function getToolKindFromName(toolName: string): string {
  const lower = toolName.toLowerCase();
  if (lower === "thinking") return "thinking";
  if (lower === "read" || lower === "read_file" || lower.startsWith("read"))
    return "read";
  if (lower === "edit" || lower === "write" || lower === "apply_patch")
    return "edit";
  if (lower === "bash" || lower === "shell") return "execute";
  if (lower === "grep" || lower === "glob" || lower === "web_search")
    return "search";
  return "tool";
}

export const ToolCall = memo(function ToolCall({
  toolName,
  args,
  result,
  error,
  status,
  cwd,
  isLastInSequence = false,
  disableOuterSpacing,
}: ToolCallProps) {
  const { openToolCall } = useToolCallSheet();
  const [isExpanded, setIsExpanded] = useState(false);
  const toggleStartRef = useRef<number | null>(null);

  // Check if we're on mobile (use bottom sheet) or desktop (inline expand)
  const isMobile =
    UnistylesRuntime.breakpoint === "xs" ||
    UnistylesRuntime.breakpoint === "sm";

  const kind = getToolKindFromName(toolName);
  const IconComponent = toolKindIcons[kind] || Wrench;

  // Extract principal param for secondary label (memoized)
  const principalParam = useMemo(
    () => extractPrincipalParam(args, cwd),
    [args, cwd]
  );

  // Check if there's any content to display
  const hasDetails =
    args !== undefined || result !== undefined || error !== undefined;

  // Parse tool call details for inline rendering
  const { display, errorText } = useToolCallDetails({ toolName, args, result, error });

  const handleToggle = useCallback(() => {
    if (!isMobile && isPerfLoggingEnabled()) {
      toggleStartRef.current = getNowMs();
    }
    if (isMobile) {
      // Mobile: open bottom sheet
      openToolCall({
        toolName,
        kind,
        status,
        args,
        result,
        error,
      });
    } else {
      // Desktop: toggle inline expansion
      setIsExpanded((prev) => !prev);
    }
  }, [isMobile, openToolCall, toolName, kind, status, args, result, error]);

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
          kind,
          durationMs: Math.round(durationMs),
        });
      }
    };
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => logCommit());
    } else {
      logCommit();
    }
  }, [isExpanded, isMobile, toolName, kind]);

  // Render inline details for desktop
  const renderDetails = useCallback(() => {
    if (isMobile) return null;
    return (
      <View style={toolCallInlineStyles.detailsContainer}>
        <ToolCallDetailsContent
          display={display}
          errorText={errorText}
          maxHeight={400}
        />
      </View>
    );
  }, [isMobile, display, errorText]);

  return (
    <ExpandableBadge
      testID="tool-call-badge"
      label={display.toolName}
      secondaryLabel={principalParam}
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
      isLoading={status === "executing"}
      isError={status === "failed"}
      isLastInSequence={isLastInSequence}
      disableOuterSpacing={disableOuterSpacing}
    />
  );
});

const toolCallInlineStyles = StyleSheet.create((theme) => ({
  detailsContainer: {
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
}));
