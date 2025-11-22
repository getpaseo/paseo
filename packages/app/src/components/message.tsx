import { View, Text, Pressable, Animated } from "react-native";
import { useState, useEffect, useRef, memo, useMemo, useCallback } from "react";
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
  Brain,
  Search,
} from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { baseColors, theme } from "@/styles/theme";
import { Colors } from "@/constants/theme";
import * as Clipboard from "expo-clipboard";
import type { TodoEntry } from "@/types/stream";
import type { CommandDetails, EditEntry, ReadEntry } from "@/utils/tool-call-parsers";
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
}

const agentThoughtStylesheet = StyleSheet.create((theme) => ({
  container: {
    marginHorizontal: theme.spacing[2],
    marginBottom: theme.spacing[2],
  },
  card: {
    backgroundColor: theme.colors.card,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[3],
  },
  iconContainer: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    paddingTop: theme.spacing[1],
  },
  icon: {
    color: theme.colors.mutedForeground,
    opacity: 0.8,
  },
  textContainer: {
    flex: 1,
    paddingVertical: theme.spacing[1],
  },
  label: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    textTransform: "uppercase",
    marginBottom: theme.spacing[1],
  },
  text: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.base,
    lineHeight: 20,
  },
}));

export function AgentThoughtMessage({ message }: AgentThoughtMessageProps) {
  const messageText = useMemo(() => {
    return message
      .trim()
      .replace(/^\*\*|\*\*$/g, "")
      .trim();
  }, [message]);

  return (
    <View style={agentThoughtStylesheet.container}>
      <View style={agentThoughtStylesheet.card}>
        <View style={agentThoughtStylesheet.iconContainer}>
          <Brain size={18} style={agentThoughtStylesheet.icon} />
        </View>
        <View style={agentThoughtStylesheet.textContainer}>
          <Text style={agentThoughtStylesheet.text}>{messageText}</Text>
        </View>
      </View>
    </View>
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
  onOpenDetails?: () => void;
}

const toolCallStylesheet = StyleSheet.create((theme) => ({
  pressable: {
    marginHorizontal: theme.spacing[2],
    marginBottom: theme.spacing[2],
    backgroundColor: theme.colors.secondary,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: "transparent",
    overflow: "hidden",
    shadowColor: theme.colors.palette.black,
    shadowOpacity: 0.2,
    shadowOffset: { width: 0, height: 8 },
    shadowRadius: 16,
    elevation: 4,
  },
  pressableActive: {
    opacity: 0.8,
  },
  executingBorder: {
    borderColor: theme.colors.primary,
  },
  completedBorder: {
    borderColor: theme.colors.border,
  },
  failedBorder: {
    borderColor: theme.colors.destructive,
  },
  content: {
    padding: theme.spacing[3],
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  chevronContainer: {
    marginRight: theme.spacing[2],
  },
  toolName: {
    color: theme.colors.foreground,
    fontFamily: "monospace",
    fontWeight: theme.fontWeight.semibold,
    fontSize: theme.fontSize.sm,
    flex: 1,
  },
  statusBadge: {
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.base,
    width: 28,
    height: 28,
  },
  executingBadgeBg: {
    backgroundColor: theme.colors.accent,
  },
  completedBadgeBg: {
    backgroundColor: "transparent",
  },
  failedBadgeBg: {
    backgroundColor: "rgba(239, 68, 68, 0.2)",
  },
  expandedContent: {
    marginTop: theme.spacing[3],
    gap: theme.spacing[2],
  },
  section: {
    // empty - just for grouping
  },
  sectionTitle: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  errorSectionTitle: {
    color: theme.colors.palette.red[300],
  },
  sectionContent: {
    backgroundColor: theme.colors.background,
    borderRadius: theme.borderRadius.base,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    padding: theme.spacing[2],
  },
  errorSectionContent: {
    borderColor: theme.colors.palette.red[800],
  },
  sectionText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    fontFamily: "monospace",
    lineHeight: 16,
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

function formatPreviewValue(value: unknown, limit = 800): string {
  if (value === undefined || value === null) {
    return "";
  }
  let text: string;
  if (typeof value === "string") {
    text = value.trim();
  } else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
  }
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}…`;
}

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
  onOpenDetails,
}: ToolCallProps) {
  const { editEntries, readEntries, commandDetails } = useMemo(
    () =>
      resolveToolCallPreview({
        args,
        result,
        parsedEditEntries,
        parsedReadEntries,
        parsedCommandDetails,
      }),
    [args, result, parsedEditEntries, parsedReadEntries, parsedCommandDetails]
  );

  const primaryEditEntry = editEntries[0];
  const primaryReadEntry = readEntries[0];
  const genericResult =
    result !== undefined &&
    !commandDetails?.output &&
    !primaryReadEntry &&
    !primaryEditEntry
      ? formatPreviewValue(result)
      : null;
  const formattedError =
    error !== undefined ? formatPreviewValue(error ?? null, 600) : null;

  const spinAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (status === "executing") {
      // Reset to 0 before starting
      spinAnim.setValue(0);
      Animated.loop(
        Animated.timing(spinAnim, {
          toValue: 1,
          duration: 1500,
          useNativeDriver: true,
          easing: (t) => t, // Linear easing for smooth continuous rotation
        })
      ).start();
    } else {
      spinAnim.stopAnimation();
    }
  }, [status, spinAnim]);

  const spin = spinAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ["0deg", "360deg"],
  });

  const statusConfig = {
    executing: {
      border: toolCallStylesheet.executingBorder,
      badgeBg: toolCallStylesheet.executingBadgeBg,
      color: "#fff",
    },
    completed: {
      border: toolCallStylesheet.completedBorder,
      badgeBg: toolCallStylesheet.completedBadgeBg,
      color: "#71717a",
    },
    failed: {
      border: toolCallStylesheet.failedBorder,
      badgeBg: toolCallStylesheet.failedBadgeBg,
      color: "#fca5a5",
    },
  };

  const config = statusConfig[status];

  // Get the appropriate icon for the tool kind
  const getToolIcon = () => {
    if (kind) {
      const IconComponent = toolKindIcons[kind.toLowerCase()] || Wrench;
      return IconComponent;
    }
    return Wrench; // Default icon
  };

  return (
    <Pressable
      onPress={onOpenDetails}
      style={[
        toolCallStylesheet.pressable,
        toolCallStylesheet.pressableActive,
        config.border,
      ]}
    >
      <View style={toolCallStylesheet.content}>
        <View style={toolCallStylesheet.headerRow}>
          <View style={[toolCallStylesheet.statusBadge, config.badgeBg]}>
            {status === "executing" ? (
              <Animated.View style={{ transform: [{ rotate: spin }] }}>
                <Loader2 size={16} color={config.color} />
              </Animated.View>
            ) : status === "completed" ? (
              (() => {
                const IconComponent = getToolIcon();
                return <IconComponent size={16} color={config.color} />;
              })()
            ) : (
              <X size={16} color={config.color} />
            )}
          </View>
          <Text
            style={toolCallStylesheet.toolName}
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            {toolName}
          </Text>
        </View>
        {(commandDetails ||
          primaryEditEntry ||
          primaryReadEntry ||
          genericResult ||
          formattedError) && (
          <View style={toolCallStylesheet.expandedContent}>
            {commandDetails &&
              (commandDetails.command ||
                commandDetails.cwd ||
                commandDetails.exitCode !== undefined ||
                commandDetails.output) && (
                <View style={toolCallStylesheet.section}>
                  <Text style={toolCallStylesheet.sectionTitle}>Command</Text>
                  <View style={toolCallStylesheet.sectionContent}>
                    {commandDetails.command && (
                      <Text
                        style={toolCallStylesheet.sectionText}
                        numberOfLines={2}
                      >
                        {commandDetails.command}
                      </Text>
                    )}
                    {commandDetails.cwd && (
                      <Text
                        style={toolCallStylesheet.sectionText}
                        numberOfLines={1}
                      >
                        {commandDetails.cwd}
                      </Text>
                    )}
                    {commandDetails.exitCode !== undefined && (
                      <Text style={toolCallStylesheet.sectionText}>
                        Exit code:{" "}
                        {commandDetails.exitCode === null
                          ? "Unknown"
                          : commandDetails.exitCode}
                      </Text>
                    )}
                    {commandDetails.output && (
                      <Text
                        style={toolCallStylesheet.sectionText}
                        numberOfLines={6}
                      >
                        {formatPreviewValue(commandDetails.output)}
                      </Text>
                    )}
                  </View>
                </View>
              )}

            {primaryReadEntry && (
              <View style={toolCallStylesheet.section}>
                <Text style={toolCallStylesheet.sectionTitle}>
                  {primaryReadEntry.filePath
                    ? `Read: ${primaryReadEntry.filePath}`
                    : "Read Output"}
                </Text>
                <View style={toolCallStylesheet.sectionContent}>
                  <Text
                    style={toolCallStylesheet.sectionText}
                    numberOfLines={6}
                  >
                    {formatPreviewValue(primaryReadEntry.content)}
                  </Text>
                </View>
              </View>
            )}

            {primaryEditEntry && (
              <View style={toolCallStylesheet.section}>
                <Text style={toolCallStylesheet.sectionTitle}>
                  {primaryEditEntry.filePath
                    ? `Diff: ${primaryEditEntry.filePath}`
                    : "Diff"}
                </Text>
                <View style={toolCallStylesheet.sectionContent}>
                  <DiffViewer diffLines={primaryEditEntry.diffLines} maxHeight={160} />
                </View>
              </View>
            )}

            {genericResult && (
              <View style={toolCallStylesheet.section}>
                <Text style={toolCallStylesheet.sectionTitle}>Result</Text>
                <View style={toolCallStylesheet.sectionContent}>
                  <Text style={toolCallStylesheet.sectionText} numberOfLines={6}>
                    {genericResult}
                  </Text>
                </View>
              </View>
            )}

            {formattedError && (
              <View style={toolCallStylesheet.section}>
                <Text
                  style={[
                    toolCallStylesheet.sectionTitle,
                    toolCallStylesheet.errorSectionTitle,
                  ]}
                >
                  Error
                </Text>
                <View
                  style={[
                    toolCallStylesheet.sectionContent,
                    toolCallStylesheet.errorSectionContent,
                  ]}
                >
                  <Text
                    style={[
                      toolCallStylesheet.sectionText,
                      toolCallStylesheet.errorSectionTitle,
                    ]}
                    numberOfLines={6}
                  >
                    {formattedError}
                  </Text>
                </View>
              </View>
            )}
          </View>
        )}
      </View>
    </Pressable>
  );
});
