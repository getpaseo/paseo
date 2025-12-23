import { View, Text, Pressable, Animated } from "react-native";
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
import { createMarkdownStyles, createCompactMarkdownStyles } from "@/styles/markdown-styles";
import { Colors } from "@/constants/theme";
import * as Clipboard from "expo-clipboard";
import type { TodoEntry, ThoughtStatus } from "@/types/stream";
import type { CommandDetails, EditEntry, ReadEntry } from "@/utils/tool-call-parsers";
import { resolveToolCallPreview } from "./tool-call-preview";
import { useToolCallSheet } from "./tool-call-sheet";

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
  // Used in custom markdownRules for inline code styling
  markdownCodeInline: {
    backgroundColor: theme.colors.secondary,
    color: theme.colors.secondaryForeground,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    borderRadius: theme.borderRadius.sm,
    fontFamily: "monospace",
    fontSize: 13,
  },
  // Used in custom markdownRules for path chip styling
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
    () => createMarkdownStyles(theme),
    [theme]
  );

  const markdownRules = useMemo(() => {
    return {
      text: (
        node: any,
        _children: ReactNode[],
        _parent: any,
        styles: any,
        inheritedStyles: any = {}
      ) => (
        <Text key={node.key} style={[inheritedStyles, styles.text]} selectable>
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
        <Text key={node.key} style={[inheritedStyles, styles.textgroup]} selectable>
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
        <Text key={node.key} style={[inheritedStyles, styles.code_block]} selectable>
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
        <Text key={node.key} style={[inheritedStyles, styles.fence]} selectable>
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
              style={[inheritedStyles, assistantMessageStylesheet.markdownCodeInline]}
              selectable
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
    () => createCompactMarkdownStyles(theme),
    [theme]
  );

  const toggle = useCallback(() => {
    setIsExpanded((prev) => !prev);
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
        <Text key={node.key} style={[inheritedStyles, styles.text]} selectable>
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
        <Text key={node.key} style={[inheritedStyles, styles.textgroup]} selectable>
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
        <Text key={node.key} style={[inheritedStyles, styles.code_block]} selectable>
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
        <Text key={node.key} style={[inheritedStyles, styles.fence]} selectable>
          {node.content}
        </Text>
      ),
      code_inline: (
        node: any,
        _children: ReactNode[],
        _parent: any,
        styles: any,
        inheritedStyles: any = {}
      ) => (
        <Text key={node.key} style={[inheritedStyles, styles.code_inline]} selectable>
          {node.content}
        </Text>
      ),
    };
  }, []);

  const renderDetails = useCallback(() => {
    if (!markdownContent) {
      return <Text style={agentThoughtStylesheet.emptyText}>No captured thinking</Text>;
    }
    return (
      <Markdown style={markdownStyles} rules={markdownRules}>
        {markdownContent}
      </Markdown>
    );
  }, [markdownContent, markdownRules, markdownStyles]);

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

// Icon mapping for tool kinds
const toolKindIcons: Record<string, any> = {
  edit: Pencil,
  read: Eye,
  execute: SquareTerminal,
  search: Search,
};

export const ToolCall = memo(function ToolCall({
  toolName,
  kind,
  args,
  result,
  error,
  status,
  parsedEditEntries,
  parsedReadEntries,
  parsedCommandDetails,
}: ToolCallProps) {
  const { openToolCall } = useToolCallSheet();

  const IconComponent = kind
    ? toolKindIcons[kind.toLowerCase()] || Wrench
    : Wrench;

  // Check if there's any content to display in the sheet
  const hasDetails = args !== undefined || result !== undefined || error !== undefined;

  const handleOpenSheet = useCallback(() => {
    openToolCall({
      toolName,
      kind,
      status,
      args,
      result,
      error,
      parsedEditEntries,
      parsedReadEntries,
      parsedCommandDetails,
    });
  }, [openToolCall, toolName, kind, status, args, result, error, parsedEditEntries, parsedReadEntries, parsedCommandDetails]);

  // Dummy renderDetails to make badge tappable - actual content is rendered in the sheet
  const dummyRenderDetails = useCallback(() => null, []);

  return (
    <ExpandableBadge
      label={toolName}
      icon={IconComponent}
      isExpanded={false}
      onToggle={handleOpenSheet}
      renderDetails={hasDetails ? dummyRenderDetails : undefined}
      isLoading={status === "executing"}
      isError={status === "failed"}
    />
  );
});
