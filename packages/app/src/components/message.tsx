import { View, Text, Pressable, Animated } from "react-native";
import { useState, useEffect, useRef, memo } from "react";
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
} from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { baseColors, theme } from "@/styles/theme";
import { Colors } from "@/constants/theme";

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
}));

export const UserMessage = memo(function UserMessage({ message, timestamp }: UserMessageProps) {
  return (
    <View style={userMessageStylesheet.container}>
      <View style={userMessageStylesheet.bubble}>
        <Text style={userMessageStylesheet.text}>{message}</Text>
      </View>
    </View>
  );
});

interface AssistantMessageProps {
  message: string;
  timestamp: number;
  isStreaming?: boolean;
}

const assistantMessageStylesheet = StyleSheet.create((theme) => ({
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
}));

export const AssistantMessage = memo(function AssistantMessage({
  message,
  timestamp,
  isStreaming = false,
}: AssistantMessageProps) {
  const fadeAnim = useRef(new Animated.Value(0.3)).current;

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

  const markdownStyles = {
    body: assistantMessageStylesheet.markdownBody,
    paragraph: assistantMessageStylesheet.markdownParagraph,
    strong: assistantMessageStylesheet.markdownStrong,
    em: assistantMessageStylesheet.markdownEm,
    code_inline: assistantMessageStylesheet.markdownCodeInline,
    code_block: assistantMessageStylesheet.markdownCodeBlock,
    fence: assistantMessageStylesheet.markdownFence,
    link: assistantMessageStylesheet.markdownLink,
    bullet_list: assistantMessageStylesheet.markdownList,
    ordered_list: assistantMessageStylesheet.markdownList,
    list_item: assistantMessageStylesheet.markdownListItem,
  };

  return (
    <View style={assistantMessageStylesheet.container}>
      <Markdown style={markdownStyles}>{message}</Markdown>
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

interface ToolCallProps {
  toolName: string;
  kind?: string; // Optional kind for ACP tool calls
  args: any;
  result?: any;
  error?: any;
  status: "executing" | "completed" | "failed";
  onOpenDetails?: () => void;
}

const toolCallStylesheet = StyleSheet.create((theme) => ({
  pressable: {
    marginHorizontal: theme.spacing[2],
    marginBottom: theme.spacing[2],
    backgroundColor: theme.colors.card,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    overflow: "hidden",
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
  // Add more mappings as needed
};

export const ToolCall = memo(function ToolCall({
  toolName,
  kind,
  args,
  result,
  error,
  status,
  onOpenDetails,
}: ToolCallProps) {
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
      </View>
    </Pressable>
  );
});
