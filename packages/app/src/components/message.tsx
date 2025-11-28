import { View, Text, Pressable, Animated, ScrollView } from "react-native";
import { useState, useEffect, useRef, memo, useMemo, useCallback } from "react";
import type { ReactNode, ComponentType } from "react";
import type { AgentProvider } from "@server/server/agent/agent-sdk-types";
import { getAgentProviderDefinition } from "@server/server/agent/provider-manifest";
import Markdown from "react-native-markdown-display";
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
  X,
  Wrench,
  Pencil,
  Eye,
  SquareTerminal,
  Search,
  Brain,
} from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { baseColors, theme } from "@/styles/theme";
import { Colors } from "@/constants/theme";
import * as Clipboard from "expo-clipboard";
import type { TodoEntry, ThoughtStatus } from "@/types/stream";
import type { CommandDetails, EditEntry, ReadEntry, DiffLine } from "@/utils/tool-call-parsers";
import { DiffViewer } from "./diff-viewer";
import { resolveToolCallPreview } from "./tool-call-preview";

interface UserMessageProps {
  message: string;
  timestamp: number;
}

const userMessageStylesheet = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    justifyContent: "flex-end",
    marginBottom: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
  },
  bubble: {
    backgroundColor: theme.colors.primary,
    borderRadius: theme.borderRadius["2xl"],
    borderTopRightRadius: theme.borderRadius.sm,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    maxWidth: "80%",
  },
  text: {
    color: theme.colors.primaryForeground,
    fontSize: theme.fontSize.lg,
    lineHeight: 24,
  },
  bubblePressed: {
    opacity: 0.85,
  },
  copiedTagContainer: {
    marginTop: theme.spacing[1],
    marginRight: theme.spacing[4],
    alignSelf: "flex-end",
    backgroundColor: theme.colors.secondary,
    borderRadius: theme.borderRadius.base,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 4,
  },
  copiedTagText: {
    color: theme.colors.secondaryForeground,
    fontSize: theme.fontSize.xs,
  },
}));

export const UserMessage = memo(function UserMessage({
  message,
  timestamp,
}: UserMessageProps) {
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
    <View style={userMessageStylesheet.container}>
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
  isStreaming?: boolean;
  onInlinePathPress?: (target: InlinePathTarget) => void;
}

export const assistantMessageStylesheet = StyleSheet.create((theme) => ({
  container: {
    marginBottom: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  streamingIndicator: {
    marginTop: theme.spacing[1],
  },
  streamingText: {
    color: theme.colors.palette.teal[200],
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.bold,
  },
  // Markdown styles
  markdownBody: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: 24,
  },
  markdownText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: 22,
  },
  markdownParagraph: {
    marginTop: 0,
    marginBottom: theme.spacing[2],
  },
  markdownStrong: {
    fontWeight: theme.fontWeight.bold,
  },
  markdownEm: {
    fontStyle: "italic" as const,
  },
  markdownCodeInline: {
    backgroundColor: theme.colors.secondary,
    color: theme.colors.secondaryForeground,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    borderRadius: theme.borderRadius.sm,
    fontFamily: "monospace",
    fontSize: 13,
  },
  markdownCodeBlock: {
    backgroundColor: theme.colors.secondary,
    color: theme.colors.secondaryForeground,
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    fontFamily: "monospace",
    fontSize: 13,
  },
  markdownFence: {
    backgroundColor: theme.colors.secondary,
    borderColor: theme.colors.border,
    color: theme.colors.secondaryForeground,
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    marginVertical: theme.spacing[2],
    fontFamily: "monospace",
    fontSize: 13,
  },
  markdownLink: {
    color: theme.colors.primary,
    textDecorationLine: "underline" as const,
  },
  markdownList: {
    marginBottom: theme.spacing[2],
  },
  markdownListItem: {
    marginBottom: theme.spacing[1],
  },
  markdownBlockquote: {
    backgroundColor: theme.colors.secondary,
    borderLeftWidth: 4,
    borderLeftColor: theme.colors.primary,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    marginVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.sm,
  },
  markdownBlockquoteText: {
    color: theme.colors.foreground,
    fontStyle: "italic" as const,
  },
  pathChip: {
    backgroundColor: theme.colors.secondary,
    borderRadius: theme.borderRadius.full,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    marginRight: theme.spacing[1],
    marginVertical: 2,
  },
  pathChipText: {
    color: theme.colors.secondaryForeground,
    fontFamily: "monospace",
    fontSize: 13,
  },
}));

const expandableBadgeStylesheet = StyleSheet.create((theme) => ({
  container: {
    marginHorizontal: theme.spacing[2],
    marginBottom: theme.spacing[2],
  },
  pressable: {
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.secondary,
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
    flex: 1,
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  chevron: {
    marginLeft: theme.spacing[1],
  },
  detailWrapper: {
    marginTop: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
    padding: theme.spacing[2],
    gap: theme.spacing[2],
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

  const looksLikeDir = value.endsWith("/") || value.startsWith("./") || value.startsWith("../");

  return hasExtension || looksLikeDir || value.includes("/");
}

function normalizeInlinePathValue(value: string): string | null {
  const trimmed = value.trim().replace(/^['"`]/, "").replace(/['"`]$/, "");
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
    const lineEnd = rangeOnlyMatch[2] ? parseInt(rangeOnlyMatch[2], 10) : undefined;
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
  isStreaming = false,
  onInlinePathPress,
}: AssistantMessageProps) {
  const { theme } = useUnistyles();
  const fadeAnim = useRef(new Animated.Value(0.3)).current;
  const lastPathRef = useRef<string | null>(null);

  const markdownStyles = useMemo(
    () => ({
      body: {
        color: theme.colors.foreground,
        fontSize: theme.fontSize.base,
        lineHeight: 24,
      },
      text: {
        color: theme.colors.foreground,
      },
      paragraph: {
        marginTop: 0,
        marginBottom: theme.spacing[2],
      },
      strong: {
        fontWeight: theme.fontWeight.bold,
      },
      em: {
        fontStyle: "italic" as const,
      },
      code_inline: {
        backgroundColor: theme.colors.secondary,
        color: theme.colors.secondaryForeground,
        paddingHorizontal: theme.spacing[2],
        paddingVertical: 2,
        borderRadius: theme.borderRadius.sm,
        fontFamily: "monospace",
        fontSize: 13,
      },
      code_block: {
        backgroundColor: theme.colors.secondary,
        color: theme.colors.secondaryForeground,
        padding: theme.spacing[3],
        borderRadius: theme.borderRadius.md,
        fontFamily: "monospace",
        fontSize: 13,
      },
      fence: {
        backgroundColor: theme.colors.secondary,
        borderColor: theme.colors.border,
        color: theme.colors.secondaryForeground,
        padding: theme.spacing[3],
        borderRadius: theme.borderRadius.md,
        marginVertical: theme.spacing[2],
        fontFamily: "monospace",
        fontSize: 13,
      },
      link: {
        color: theme.colors.primary,
        textDecorationLine: "underline" as const,
      },
      bullet_list: {
        marginBottom: theme.spacing[2],
      },
      ordered_list: {
        marginBottom: theme.spacing[2],
      },
      list_item: {
        marginBottom: theme.spacing[1],
      },
      blockquote: {
        backgroundColor: theme.colors.secondary,
        borderLeftWidth: 4,
        borderLeftColor: theme.colors.primary,
        paddingHorizontal: theme.spacing[3],
        paddingVertical: theme.spacing[2],
        marginVertical: theme.spacing[2],
        borderRadius: theme.borderRadius.sm,
      },
      blockquote_text: {
        color: theme.colors.foreground,
        fontStyle: "italic" as const,
      },
    }),
    [theme]
  );

  const markdownRules = useMemo(() => {
    if (!onInlinePathPress) {
      return undefined;
    }

    return {
      code_inline: (node: any) => {
        const content = node.content ?? "";
        const parsed = parseInlinePathToken(content, lastPathRef);

        if (!parsed) {
          return (
            <Text key={node.key} style={assistantMessageStylesheet.markdownCodeInline}>
              {content}
            </Text>
          );
        }

        return (
          <Text
            key={node.key}
            onPress={() => parsed && onInlinePathPress?.(parsed)}
            style={[assistantMessageStylesheet.pathChip, assistantMessageStylesheet.pathChipText]}
          >
            {content}
          </Text>
        );
      },
    };
  }, [onInlinePathPress]);

  useEffect(() => {
    if (isStreaming) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(fadeAnim, {
            toValue: 1,
            duration: 600,
            useNativeDriver: true,
          }),
          Animated.timing(fadeAnim, {
            toValue: 0.3,
            duration: 600,
            useNativeDriver: true,
          }),
        ])
      ).start();
    } else {
      fadeAnim.stopAnimation();
      fadeAnim.setValue(1);
    }
  }, [isStreaming, fadeAnim]);

  return (
    <View style={assistantMessageStylesheet.container}>
      <Markdown style={markdownStyles} rules={markdownRules}>
        {message}
      </Markdown>
      {isStreaming && (
        <Animated.View
          style={[
            assistantMessageStylesheet.streamingIndicator,
            { opacity: fadeAnim },
          ]}
        >
          <Text style={assistantMessageStylesheet.streamingText}>...</Text>
        </Animated.View>
      )}
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
}

const activityLogStylesheet = StyleSheet.create((theme) => ({
  pressable: {
    marginHorizontal: theme.spacing[2],
    marginBottom: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    overflow: "hidden",
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
    color: theme.colors.mutedForeground,
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
    fontFamily: "monospace",
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
}: ActivityLogProps) {
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
  provider: AgentProvider;
  timestamp: number;
  items: TodoEntry[];
}

function formatPlanTimestamp(timestamp: number): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date(timestamp));
  } catch {
    return new Date(timestamp).toLocaleTimeString();
  }
}

const todoListCardStylesheet = StyleSheet.create((theme) => ({
  container: {
    marginHorizontal: theme.spacing[2],
    marginBottom: theme.spacing[2],
  },
  card: {
    backgroundColor: theme.colors.card,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    padding: theme.spacing[3],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: theme.spacing[2],
  },
  headerMeta: {
    flexDirection: "column",
    gap: theme.spacing[0],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  timestamp: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.xs,
  },
  providerBadge: {
    backgroundColor: "rgba(59, 130, 246, 0.15)",
    borderRadius: theme.borderRadius.full,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  providerText: {
    color: "#93c5fd",
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
  },
  progressText: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.xs,
    marginBottom: theme.spacing[2],
  },
  list: {
    gap: theme.spacing[2],
  },
  itemRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: theme.borderRadius.base,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "transparent",
  },
  checkboxCompleted: {
    backgroundColor: theme.colors.primary,
    borderColor: theme.colors.primary,
  },
  itemText: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  itemTextCompleted: {
    color: theme.colors.mutedForeground,
    textDecorationLine: "line-through",
  },
  emptyText: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.sm,
    fontStyle: "italic",
  },
}));

export const TodoListCard = memo(function TodoListCard({
  provider,
  timestamp,
  items,
}: TodoListCardProps) {
  const providerLabel = useMemo(() => {
    const definition = getAgentProviderDefinition(provider);
    return definition?.label ?? provider;
  }, [provider]);

  const completedCount = useMemo(
    () => items.filter((item) => item.completed).length,
    [items]
  );

  const timestampLabel = useMemo(() => formatPlanTimestamp(timestamp), [timestamp]);

  const iconColor = theme.colors.background;

  return (
    <View style={todoListCardStylesheet.container}>
      <View style={todoListCardStylesheet.card}>
        <View style={todoListCardStylesheet.header}>
          <View style={todoListCardStylesheet.headerMeta}>
            <Text style={todoListCardStylesheet.title}>Plan</Text>
            <Text style={todoListCardStylesheet.timestamp}>{timestampLabel}</Text>
          </View>
          <View style={todoListCardStylesheet.providerBadge}>
            <Text style={todoListCardStylesheet.providerText}>{providerLabel}</Text>
          </View>
        </View>
        <Text style={todoListCardStylesheet.progressText}>
          {items.length > 0
            ? `${completedCount}/${items.length} completed`
            : "Waiting for tasks..."}
        </Text>
        <View style={todoListCardStylesheet.list}>
          {items.length === 0 ? (
            <Text style={todoListCardStylesheet.emptyText}>
              No todo items shared yet.
            </Text>
          ) : (
            items.map((item, idx) => (
              <View key={`${item.text}-${idx}`} style={todoListCardStylesheet.itemRow}>
                <View
                  style={[
                    todoListCardStylesheet.checkbox,
                    item.completed && todoListCardStylesheet.checkboxCompleted,
                  ]}
                >
                  {item.completed && <Check size={14} color={iconColor} />}
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
    </View>
  );
});

interface AgentThoughtMessageProps {
  message: string;
  status?: ThoughtStatus;
}

interface ExpandableBadgeProps {
  label: string;
  icon?: ComponentType<{ size?: number; color?: string }>;
  isExpanded: boolean;
  onToggle: () => void;
  renderDetails?: () => ReactNode;
  isLoading?: boolean;
  isError?: boolean;
}

const ExpandableBadge = memo(function ExpandableBadge({
  label,
  icon,
  isExpanded,
  onToggle,
  renderDetails,
  isLoading = false,
  isError = false,
}: ExpandableBadgeProps) {
  const { theme } = useUnistyles();
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

  const spin = spinAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ["0deg", "360deg"],
  });

  const IconComponent = icon;
  const iconColor = isError
    ? theme.colors.destructive
    : theme.colors.foreground;

  let iconNode: ReactNode = null;
  if (isLoading) {
    iconNode = (
      <Animated.View style={{ transform: [{ rotate: spin }] }}>
        <Loader2 size={12} color={iconColor} />
      </Animated.View>
    );
  } else if (isError) {
    iconNode = <X size={12} color={iconColor} />;
  } else if (IconComponent) {
    iconNode = <IconComponent size={12} color={iconColor} />;
  }

  return (
    <View style={expandableBadgeStylesheet.container}>
      <Pressable
        onPress={hasDetails ? onToggle : undefined}
        disabled={!hasDetails}
        accessibilityRole={hasDetails ? "button" : undefined}
        accessibilityState={hasDetails ? { expanded: isExpanded } : undefined}
        style={({ pressed }) => [
          expandableBadgeStylesheet.pressable,
          pressed && hasDetails ? expandableBadgeStylesheet.pressablePressed : null,
        ]}
      >
        <View style={expandableBadgeStylesheet.headerRow}>
          <View style={expandableBadgeStylesheet.iconBadge}>{iconNode}</View>
          <Text style={expandableBadgeStylesheet.label} numberOfLines={1}>
            {label}
          </Text>
          {hasDetails ? (
            <ChevronRight
              size={14}
              color={theme.colors.mutedForeground}
              style={[
                expandableBadgeStylesheet.chevron,
                { transform: [{ rotate: isExpanded ? "90deg" : "0deg" }] },
              ]}
            />
          ) : null}
        </View>
        {detailContent ? (
          <View style={expandableBadgeStylesheet.detailWrapper}>{detailContent}</View>
        ) : null}
      </Pressable>
    </View>
  );
});

const agentThoughtStylesheet = StyleSheet.create((theme) => ({
  emptyText: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.xs,
    fontStyle: "italic" as const,
  },
}));

export function AgentThoughtMessage({ message, status = "ready" }: AgentThoughtMessageProps) {
  const { theme } = useUnistyles();
  const [isExpanded, setIsExpanded] = useState(false);
  const markdownContent = useMemo(() => message?.trim() ?? "", [message]);
  const markdownStyles = useMemo(
    () => ({
      body: {
        color: theme.colors.foreground,
        fontSize: theme.fontSize.sm,
        lineHeight: 20,
      },
      text: {
        color: theme.colors.foreground,
      },
      paragraph: {
        marginBottom: theme.spacing[2],
      },
      strong: {
        fontWeight: theme.fontWeight.semibold,
      },
      em: {
        fontStyle: "italic" as const,
      },
      code_inline: {
        backgroundColor: theme.colors.secondary,
        color: theme.colors.secondaryForeground,
        paddingHorizontal: theme.spacing[1],
        paddingVertical: 2,
        borderRadius: theme.borderRadius.sm,
        fontFamily: "monospace",
        fontSize: theme.fontSize.xs,
      },
      code_block: {
        backgroundColor: theme.colors.secondary,
        color: theme.colors.secondaryForeground,
        padding: theme.spacing[3],
        borderRadius: theme.borderRadius.md,
        fontFamily: "monospace",
        fontSize: theme.fontSize.sm,
      },
    }),
    [theme]
  );

  const toggle = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  const renderDetails = useCallback(() => {
    if (!markdownContent) {
      return <Text style={agentThoughtStylesheet.emptyText}>No captured thinking</Text>;
    }
    return <Markdown style={markdownStyles}>{markdownContent}</Markdown>;
  }, [markdownContent, markdownStyles]);

  return (
    <ExpandableBadge
      label="Thinking"
      icon={status === "ready" ? Brain : undefined}
      isExpanded={isExpanded}
      onToggle={toggle}
      renderDetails={renderDetails}
      isLoading={status !== "ready"}
    />
  );
}

interface ToolCallProps {
  toolName: string;
  kind?: string; // Optional kind for ACP tool calls
  args: any;
  result?: any;
  error?: any;
  status: "executing" | "completed" | "failed";
  parsedEditEntries?: EditEntry[];
  parsedReadEntries?: ReadEntry[];
  parsedCommandDetails?: CommandDetails | null;
}

const toolCallStylesheet = StyleSheet.create((theme) => ({
  detailContent: {
    gap: theme.spacing[3],
  },
  section: {
    gap: theme.spacing[1],
  },
  sectionTitle: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  fileBadge: {
    alignSelf: "flex-start",
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.base,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
  },
  fileBadgeText: {
    color: theme.colors.foreground,
    fontFamily: "monospace",
    fontSize: theme.fontSize.xs,
  },
  diffContainer: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.base,
    overflow: "hidden",
    backgroundColor: theme.colors.card,
  },
  scrollArea: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.base,
    maxHeight: 260,
  },
  scrollContent: {
    padding: theme.spacing[2],
  },
  scrollText: {
    fontFamily: "monospace",
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
    lineHeight: 18,
  },
  jsonScroll: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.base,
  },
  jsonScrollError: {
    borderColor: theme.colors.destructive,
  },
  jsonContent: {
    padding: theme.spacing[2],
  },
  errorText: {
    color: theme.colors.destructive,
  },
  emptyStateText: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.sm,
    fontStyle: "italic",
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  metaLabel: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.xs,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  metaValue: {
    color: theme.colors.foreground,
    fontFamily: "monospace",
    fontSize: theme.fontSize.xs,
    flex: 1,
  },
}));

// Icon mapping for tool kinds
const toolKindIcons: Record<string, any> = {
  edit: Pencil,
  read: Eye,
  execute: SquareTerminal,
  search: Search,
  // Add more mappings as needed
};

function formatFullValue(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// Helper function to build diff lines (mirrors logic from tool-call-parsers)
function buildLineDiffFromStrings(originalText: string, updatedText: string): DiffLine[] {
  const splitIntoLines = (text: string): string[] => {
    if (!text) return [];
    return text.replace(/\r\n/g, "\n").split("\n");
  };

  const originalLines = splitIntoLines(originalText);
  const updatedLines = splitIntoLines(updatedText);

  const hasAnyContent = originalLines.length > 0 || updatedLines.length > 0;
  if (!hasAnyContent) return [];

  const m = originalLines.length;
  const n = updatedLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      if (originalLines[i] === updatedLines[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const diff: DiffLine[] = [];
  let i = 0;
  let j = 0;

  while (i < m && j < n) {
    if (originalLines[i] === updatedLines[j]) {
      diff.push({ type: "context", content: ` ${originalLines[i]}` });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      diff.push({ type: "remove", content: `-${originalLines[i]}` });
      i += 1;
    } else {
      diff.push({ type: "add", content: `+${updatedLines[j]}` });
      j += 1;
    }
  }

  while (i < m) {
    diff.push({ type: "remove", content: `-${originalLines[i]}` });
    i += 1;
  }

  while (j < n) {
    diff.push({ type: "add", content: `+${updatedLines[j]}` });
    j += 1;
  }

  return diff;
}

// Type guard for structured tool results
type StructuredToolResult = {
  type: "command" | "file_write" | "file_edit" | "file_read" | "generic";
  [key: string]: unknown;
};

function isStructuredToolResult(result: unknown): result is StructuredToolResult {
  return (
    typeof result === "object" &&
    result !== null &&
    "type" in result &&
    typeof result.type === "string" &&
    ["command", "file_write", "file_edit", "file_read", "generic"].includes(result.type)
  );
}

export const ToolCall = memo(function ToolCall({
  toolName,
  kind,
  args,
  result,
  error,
  status,
}: ToolCallProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  // Check if result has a type field for structured rendering
  const structuredResult = useMemo(
    () => (isStructuredToolResult(result) ? result : null),
    [result]
  );

  const IconComponent = kind
    ? toolKindIcons[kind.toLowerCase()] || Wrench
    : Wrench;

  const serializedArgs = useMemo(
    () => (args !== undefined ? formatFullValue(args) : ""),
    [args]
  );
  const serializedResult = useMemo(
    () => (result !== undefined ? formatFullValue(result) : ""),
    [result]
  );
  const serializedError = useMemo(
    () => (error !== undefined ? formatFullValue(error) : ""),
    [error]
  );

  const handleToggle = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  // Helper functions to extract data from structured results
  const extractCommandFromStructured = useCallback(
    (structured: StructuredToolResult): CommandDetails | null => {
      if (structured.type !== "command") return null;

      const cmd: CommandDetails = {};
      if (typeof structured.command === "string") cmd.command = structured.command;
      if (typeof structured.cwd === "string") cmd.cwd = structured.cwd;
      if (typeof structured.output === "string") cmd.output = structured.output;
      if (typeof structured.exitCode === "number") cmd.exitCode = structured.exitCode;

      return cmd.command || cmd.output ? cmd : null;
    },
    []
  );

  const extractDiffFromStructured = useCallback(
    (structured: StructuredToolResult): EditEntry[] => {
      if (structured.type !== "file_write" && structured.type !== "file_edit") {
        return [];
      }

      const filePath = typeof structured.filePath === "string" ? structured.filePath : undefined;

      // For file_write, create a diff from oldContent -> newContent
      if (structured.type === "file_write") {
        const oldContent = typeof structured.oldContent === "string" ? structured.oldContent : "";
        const newContent = typeof structured.newContent === "string" ? structured.newContent : "";

        // Use the same diff building logic from tool-call-parsers
        const diffLines = buildLineDiffFromStrings(oldContent, newContent);
        if (diffLines.length > 0) {
          return [{ filePath, diffLines }];
        }
      }

      // For file_edit, it might already have diffLines or we need to construct them
      if (structured.type === "file_edit") {
        // Check if diffLines are provided directly
        if (Array.isArray(structured.diffLines)) {
          return [{ filePath, diffLines: structured.diffLines as DiffLine[] }];
        }

        // Otherwise try to build from old/new content
        const oldContent = typeof structured.oldContent === "string" ? structured.oldContent : "";
        const newContent = typeof structured.newContent === "string" ? structured.newContent : "";
        const diffLines = buildLineDiffFromStrings(oldContent, newContent);
        if (diffLines.length > 0) {
          return [{ filePath, diffLines }];
        }
      }

      return [];
    },
    []
  );

  const extractReadFromStructured = useCallback(
    (structured: StructuredToolResult): ReadEntry[] => {
      if (structured.type !== "file_read") return [];

      const filePath = typeof structured.filePath === "string" ? structured.filePath : undefined;
      const content = typeof structured.content === "string" ? structured.content : "";

      if (content) {
        return [{ filePath, content }];
      }

      return [];
    },
    []
  );

  const renderDetails = useCallback(() => {
    // If we have a structured result, use type-based rendering
    if (structuredResult) {
      const sections: ReactNode[] = [];

      // Render based on type
      switch (structuredResult.type) {
        case "command": {
          const cmd = extractCommandFromStructured(structuredResult);
          if (cmd) {
            // Reuse the command section rendering logic
            sections.push(
              <View key="command" style={toolCallStylesheet.section}>
                <Text style={toolCallStylesheet.sectionTitle}>Command</Text>
                {cmd.command ? (
                  <ScrollView
                    horizontal
                    nestedScrollEnabled
                    style={toolCallStylesheet.jsonScroll}
                    contentContainerStyle={toolCallStylesheet.jsonContent}
                    showsHorizontalScrollIndicator={true}
                  >
                    <Text style={toolCallStylesheet.scrollText}>{cmd.command}</Text>
                  </ScrollView>
                ) : null}
                {cmd.cwd ? (
                  <View style={toolCallStylesheet.metaRow}>
                    <Text style={toolCallStylesheet.metaLabel}>Directory</Text>
                    <Text style={toolCallStylesheet.metaValue}>{cmd.cwd}</Text>
                  </View>
                ) : null}
                {cmd.exitCode !== undefined ? (
                  <View style={toolCallStylesheet.metaRow}>
                    <Text style={toolCallStylesheet.metaLabel}>Exit Code</Text>
                    <Text style={toolCallStylesheet.metaValue}>
                      {cmd.exitCode === null ? "Unknown" : cmd.exitCode}
                    </Text>
                  </View>
                ) : null}
                {cmd.output ? (
                  <ScrollView
                    style={toolCallStylesheet.scrollArea}
                    contentContainerStyle={toolCallStylesheet.scrollContent}
                    nestedScrollEnabled
                    showsVerticalScrollIndicator={true}
                  >
                    <Text style={toolCallStylesheet.scrollText}>{cmd.output}</Text>
                  </ScrollView>
                ) : null}
              </View>
            );
          }
          break;
        }

        case "file_write":
        case "file_edit": {
          const diffs = extractDiffFromStructured(structuredResult);
          diffs.forEach((entry, index) => {
            sections.push(
              <View
                key={`diff-${index}`}
                style={toolCallStylesheet.section}
              >
                <Text style={toolCallStylesheet.sectionTitle}>Diff</Text>
                {entry.filePath ? (
                  <View style={toolCallStylesheet.fileBadge}>
                    <Text style={toolCallStylesheet.fileBadgeText}>{entry.filePath}</Text>
                  </View>
                ) : null}
                <View style={toolCallStylesheet.diffContainer}>
                  <DiffViewer diffLines={entry.diffLines} maxHeight={240} />
                </View>
              </View>
            );
          });
          break;
        }

        case "file_read": {
          const reads = extractReadFromStructured(structuredResult);
          reads.forEach((entry, index) => {
            sections.push(
              <View
                key={`read-${index}`}
                style={toolCallStylesheet.section}
              >
                <Text style={toolCallStylesheet.sectionTitle}>Read Result</Text>
                {entry.filePath ? (
                  <View style={toolCallStylesheet.fileBadge}>
                    <Text style={toolCallStylesheet.fileBadgeText}>{entry.filePath}</Text>
                  </View>
                ) : null}
                <ScrollView
                  style={toolCallStylesheet.scrollArea}
                  contentContainerStyle={toolCallStylesheet.scrollContent}
                  nestedScrollEnabled
                  showsVerticalScrollIndicator={true}
                >
                  <Text style={toolCallStylesheet.scrollText}>{entry.content}</Text>
                </ScrollView>
              </View>
            );
          });
          break;
        }

        case "generic":
        default: {
          // Show raw JSON for generic type
          if (result !== undefined) {
            sections.push(
              <View key="result" style={toolCallStylesheet.section}>
                <Text style={toolCallStylesheet.sectionTitle}>Result</Text>
                <ScrollView
                  horizontal
                  nestedScrollEnabled
                  style={toolCallStylesheet.jsonScroll}
                  contentContainerStyle={toolCallStylesheet.jsonContent}
                  showsHorizontalScrollIndicator={true}
                >
                  <Text style={toolCallStylesheet.scrollText}>{serializedResult}</Text>
                </ScrollView>
              </View>
            );
          }
          break;
        }
      }

      // Always show args if available
      if (args !== undefined) {
        sections.unshift(
          <View key="args" style={toolCallStylesheet.section}>
            <Text style={toolCallStylesheet.sectionTitle}>Arguments</Text>
            <ScrollView
              horizontal
              nestedScrollEnabled
              style={toolCallStylesheet.jsonScroll}
              contentContainerStyle={toolCallStylesheet.jsonContent}
              showsHorizontalScrollIndicator={true}
            >
              <Text style={toolCallStylesheet.scrollText}>{serializedArgs}</Text>
            </ScrollView>
          </View>
        );
      }

      // Always show errors if available
      if (error !== undefined) {
        sections.push(
          <View key="error" style={toolCallStylesheet.section}>
            <Text style={toolCallStylesheet.sectionTitle}>Error</Text>
            <ScrollView
              horizontal
              nestedScrollEnabled
              style={[toolCallStylesheet.jsonScroll, toolCallStylesheet.jsonScrollError]}
              contentContainerStyle={toolCallStylesheet.jsonContent}
              showsHorizontalScrollIndicator={true}
            >
              <Text style={[toolCallStylesheet.scrollText, toolCallStylesheet.errorText]}>
                {serializedError}
              </Text>
            </ScrollView>
          </View>
        );
      }

      if (sections.length === 0) {
        return (
          <Text style={toolCallStylesheet.emptyStateText}>
            No additional details available
          </Text>
        );
      }

      return <View style={toolCallStylesheet.detailContent}>{sections}</View>;
    }

    // No structured result - show raw JSON
    const sections: ReactNode[] = [];

    if (args !== undefined) {
      sections.push(
        <View key="args" style={toolCallStylesheet.section}>
          <Text style={toolCallStylesheet.sectionTitle}>Arguments</Text>
          <ScrollView
            horizontal
            nestedScrollEnabled
            style={toolCallStylesheet.jsonScroll}
            contentContainerStyle={toolCallStylesheet.jsonContent}
            showsHorizontalScrollIndicator={true}
          >
            <Text style={toolCallStylesheet.scrollText}>{serializedArgs}</Text>
          </ScrollView>
        </View>
      );
    }

    if (result !== undefined) {
      sections.push(
        <View key="result" style={toolCallStylesheet.section}>
          <Text style={toolCallStylesheet.sectionTitle}>Result</Text>
          <ScrollView
            horizontal
            nestedScrollEnabled
            style={toolCallStylesheet.jsonScroll}
            contentContainerStyle={toolCallStylesheet.jsonContent}
            showsHorizontalScrollIndicator={true}
          >
            <Text style={toolCallStylesheet.scrollText}>{serializedResult}</Text>
          </ScrollView>
        </View>
      );
    }

    if (error !== undefined) {
      sections.push(
        <View key="error" style={toolCallStylesheet.section}>
          <Text style={toolCallStylesheet.sectionTitle}>Error</Text>
          <ScrollView
            horizontal
            nestedScrollEnabled
            style={[toolCallStylesheet.jsonScroll, toolCallStylesheet.jsonScrollError]}
            contentContainerStyle={toolCallStylesheet.jsonContent}
            showsHorizontalScrollIndicator={true}
          >
            <Text style={[toolCallStylesheet.scrollText, toolCallStylesheet.errorText]}>
              {serializedError}
            </Text>
          </ScrollView>
        </View>
      );
    }

    if (sections.length === 0) {
      return (
        <Text style={toolCallStylesheet.emptyStateText}>
          No additional details available
        </Text>
      );
    }

    return <View style={toolCallStylesheet.detailContent}>{sections}</View>;
  }, [
    structuredResult,
    extractCommandFromStructured,
    extractDiffFromStructured,
    extractReadFromStructured,
    serializedArgs,
    serializedResult,
    serializedError,
    args,
    result,
    error,
  ]);

  return (
    <ExpandableBadge
      label={toolName}
      icon={IconComponent}
      isExpanded={isExpanded}
      onToggle={handleToggle}
      renderDetails={renderDetails}
      isLoading={status === "executing"}
      isError={status === "failed"}
    />
  );
});
