import { View, Text, Pressable, Animated } from 'react-native';
import { useState, useEffect, useRef } from 'react';
import Markdown from 'react-native-markdown-display';
import { Circle, Info, CheckCircle, XCircle, FileText, ChevronRight, ChevronDown, RefreshCw } from 'lucide-react-native';
import { StyleSheet } from 'react-native-unistyles';

interface UserMessageProps {
  message: string;
  timestamp: number;
}

const userMessageStylesheet = StyleSheet.create((theme: import('../styles/theme').Theme) => ({
  container: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginBottom: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
  },
  bubble: {
    backgroundColor: theme.colors.blue[600],
    borderRadius: theme.borderRadius['2xl'],
    borderTopRightRadius: theme.borderRadius.sm,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    maxWidth: '80%',
  },
  text: {
    color: theme.colors.white,
    fontSize: theme.fontSize.lg,
    lineHeight: 24,
  },
}));

export function UserMessage({ message, timestamp }: UserMessageProps) {
  return (
    <View style={userMessageStylesheet.container}>
      <View style={userMessageStylesheet.bubble}>
        <Text style={userMessageStylesheet.text}>{message}</Text>
      </View>
    </View>
  );
}

interface AssistantMessageProps {
  message: string;
  timestamp: number;
  isStreaming?: boolean;
}

const assistantMessageStylesheet = StyleSheet.create((theme: import('../styles/theme').Theme) => ({
  container: {
    marginBottom: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  streamingIndicator: {
    marginTop: theme.spacing[1],
  },
  streamingText: {
    color: theme.colors.teal[200],
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.bold,
  },
}));

export function AssistantMessage({ message, timestamp, isStreaming = false }: AssistantMessageProps) {
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
    body: {
      color: '#f0fdfa',
      fontSize: 16,
      lineHeight: 24,
    },
    paragraph: {
      marginTop: 0,
      marginBottom: 8,
    },
    strong: {
      fontWeight: '700' as const,
    },
    em: {
      fontStyle: 'italic' as const,
    },
    code_inline: {
      backgroundColor: '#134e4a',
      color: '#ccfbf1',
      paddingHorizontal: 4,
      paddingVertical: 2,
      borderRadius: 3,
      fontFamily: 'monospace',
    },
    code_block: {
      backgroundColor: '#134e4a',
      color: '#ccfbf1',
      padding: 12,
      borderRadius: 6,
      fontFamily: 'monospace',
      fontSize: 14,
    },
    fence: {
      backgroundColor: '#134e4a',
      color: '#ccfbf1',
      padding: 12,
      borderRadius: 6,
      fontFamily: 'monospace',
      fontSize: 14,
    },
    link: {
      color: '#5eead4',
      textDecorationLine: 'underline' as const,
    },
    bullet_list: {
      marginBottom: 8,
    },
    ordered_list: {
      marginBottom: 8,
    },
    list_item: {
      marginBottom: 4,
    },
  };

  return (
    <View style={assistantMessageStylesheet.container}>
      <Markdown style={markdownStyles}>{message}</Markdown>
      {isStreaming && (
        <Animated.View style={[assistantMessageStylesheet.streamingIndicator, { opacity: fadeAnim }]}>
          <Text style={assistantMessageStylesheet.streamingText}>...</Text>
        </Animated.View>
      )}
    </View>
  );
}

interface ActivityLogProps {
  type: 'system' | 'info' | 'success' | 'error' | 'artifact';
  message: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
  artifactId?: string;
  artifactType?: string;
  title?: string;
  onArtifactClick?: (artifactId: string) => void;
}

const activityLogStylesheet = StyleSheet.create((theme: import('../styles/theme').Theme) => ({
  pressable: {
    marginHorizontal: theme.spacing[2],
    marginBottom: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    overflow: 'hidden',
  },
  pressableActive: {
    opacity: 0.7,
  },
  systemBg: {
    backgroundColor: 'rgba(39, 39, 42, 0.5)', // zinc-800/50
  },
  infoBg: {
    backgroundColor: 'rgba(30, 58, 138, 0.3)', // blue-900/30
  },
  successBg: {
    backgroundColor: 'rgba(20, 83, 45, 0.3)', // green-900/30
  },
  errorBg: {
    backgroundColor: 'rgba(127, 29, 29, 0.3)', // red-900/30
  },
  artifactBg: {
    backgroundColor: 'rgba(30, 58, 138, 0.4)', // blue-900/40
  },
  content: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: 10,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
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
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: theme.spacing[1],
  },
  detailsText: {
    color: theme.colors.zinc[500],
    fontSize: theme.fontSize.xs,
    marginRight: theme.spacing[1],
  },
  metadataContainer: {
    marginTop: theme.spacing[2],
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    borderRadius: theme.borderRadius.base,
    padding: theme.spacing[2],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.zinc[700],
  },
  metadataText: {
    color: theme.colors.zinc[300],
    fontSize: theme.fontSize.xs,
    fontFamily: 'monospace',
    lineHeight: 16,
  },
}));

export function ActivityLog({
  type,
  message,
  timestamp,
  metadata,
  artifactId,
  artifactType,
  title,
  onArtifactClick
}: ActivityLogProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const typeConfig = {
    system: { bg: activityLogStylesheet.systemBg, color: '#a1a1aa', Icon: Circle },
    info: { bg: activityLogStylesheet.infoBg, color: '#60a5fa', Icon: Info },
    success: { bg: activityLogStylesheet.successBg, color: '#4ade80', Icon: CheckCircle },
    error: { bg: activityLogStylesheet.errorBg, color: '#f87171', Icon: XCircle },
    artifact: { bg: activityLogStylesheet.artifactBg, color: '#93c5fd', Icon: FileText },
  };

  const config = typeConfig[type];
  const IconComponent = config.Icon;

  const handlePress = () => {
    if (type === 'artifact' && artifactId && onArtifactClick) {
      onArtifactClick(artifactId);
    } else if (metadata) {
      setIsExpanded(!isExpanded);
    }
  };

  const displayMessage = type === 'artifact' && artifactType && title
    ? `${artifactType}: ${title}`
    : message;

  const isInteractive = type === 'artifact' || metadata;

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
            <Text style={[activityLogStylesheet.messageText, { color: config.color }]}>
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
}

interface ToolCallProps {
  toolName: string;
  args: any;
  result?: any;
  error?: any;
  status: 'executing' | 'completed' | 'failed';
}

const toolCallStylesheet = StyleSheet.create((theme: import('../styles/theme').Theme) => ({
  pressable: {
    marginHorizontal: theme.spacing[2],
    marginBottom: theme.spacing[2],
    backgroundColor: theme.colors.zinc[900],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    overflow: 'hidden',
  },
  pressableActive: {
    opacity: 0.8,
  },
  executingBorder: {
    borderColor: theme.colors.amber[500],
  },
  completedBorder: {
    borderColor: theme.colors.green[500],
  },
  failedBorder: {
    borderColor: theme.colors.red[500],
  },
  content: {
    padding: theme.spacing[3],
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  chevronContainer: {
    marginRight: theme.spacing[2],
  },
  toolName: {
    color: theme.colors.slate[200],
    fontFamily: 'monospace',
    fontWeight: theme.fontWeight.semibold,
    fontSize: theme.fontSize.sm,
    flex: 1,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.base,
  },
  executingBadgeBg: {
    backgroundColor: 'rgba(245, 158, 11, 0.2)', // amber-500/20
  },
  completedBadgeBg: {
    backgroundColor: 'rgba(34, 197, 94, 0.2)', // green-500/20
  },
  failedBadgeBg: {
    backgroundColor: 'rgba(239, 68, 68, 0.2)', // red-500/20
  },
  statusText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    textTransform: 'uppercase',
  },
  expandedContent: {
    marginTop: theme.spacing[3],
    gap: theme.spacing[2],
  },
  section: {
    // empty - just for grouping
  },
  sectionTitle: {
    color: theme.colors.zinc[400],
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  errorSectionTitle: {
    color: '#fca5a5', // red-300
  },
  sectionContent: {
    backgroundColor: theme.colors.black,
    borderRadius: theme.borderRadius.base,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.zinc[700],
    padding: theme.spacing[2],
  },
  errorSectionContent: {
    borderColor: '#991b1b', // red-800
  },
  sectionText: {
    color: theme.colors.slate[200],
    fontSize: theme.fontSize.xs,
    fontFamily: 'monospace',
    lineHeight: 16,
  },
}));

export function ToolCall({ toolName, args, result, error, status }: ToolCallProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const spinAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (status === 'executing') {
      Animated.loop(
        Animated.timing(spinAnim, {
          toValue: 1,
          duration: 1000,
          useNativeDriver: true,
        })
      ).start();
    } else {
      spinAnim.stopAnimation();
      spinAnim.setValue(0);
    }
  }, [status, spinAnim]);

  const spin = spinAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  const statusConfig = {
    executing: {
      border: toolCallStylesheet.executingBorder,
      badgeBg: toolCallStylesheet.executingBadgeBg,
      color: '#fcd34d',
      label: 'executing',
    },
    completed: {
      border: toolCallStylesheet.completedBorder,
      badgeBg: toolCallStylesheet.completedBadgeBg,
      color: '#86efac',
      label: 'completed',
    },
    failed: {
      border: toolCallStylesheet.failedBorder,
      badgeBg: toolCallStylesheet.failedBadgeBg,
      color: '#fca5a5',
      label: 'failed',
    },
  };

  const config = statusConfig[status];

  return (
    <Pressable
      onPress={() => setIsExpanded(!isExpanded)}
      style={[toolCallStylesheet.pressable, toolCallStylesheet.pressableActive, config.border]}
    >
      <View style={toolCallStylesheet.content}>
        <View style={toolCallStylesheet.headerRow}>
          <View style={toolCallStylesheet.chevronContainer}>
            {isExpanded ? (
              <ChevronDown size={16} color="#9ca3af" />
            ) : (
              <ChevronRight size={16} color="#9ca3af" />
            )}
          </View>
          <Text style={toolCallStylesheet.toolName}>
            {toolName}
          </Text>
          <View style={[toolCallStylesheet.statusBadge, config.badgeBg]}>
            {status === 'executing' ? (
              <Animated.View style={{ transform: [{ rotate: spin }] }}>
                <RefreshCw size={14} color={config.color} />
              </Animated.View>
            ) : status === 'completed' ? (
              <CheckCircle size={14} color={config.color} />
            ) : (
              <XCircle size={14} color={config.color} />
            )}
            <Text style={[toolCallStylesheet.statusText, { color: config.color }]}>
              {config.label}
            </Text>
          </View>
        </View>

        {isExpanded && (
          <View style={toolCallStylesheet.expandedContent}>
            <View style={toolCallStylesheet.section}>
              <Text style={toolCallStylesheet.sectionTitle}>
                Arguments
              </Text>
              <View style={toolCallStylesheet.sectionContent}>
                <Text style={toolCallStylesheet.sectionText}>
                  {JSON.stringify(args, null, 2)}
                </Text>
              </View>
            </View>

            {result !== undefined && (
              <View style={toolCallStylesheet.section}>
                <Text style={toolCallStylesheet.sectionTitle}>
                  Result
                </Text>
                <View style={toolCallStylesheet.sectionContent}>
                  <Text style={toolCallStylesheet.sectionText}>
                    {JSON.stringify(result, null, 2)}
                  </Text>
                </View>
              </View>
            )}

            {error !== undefined && (
              <View style={toolCallStylesheet.section}>
                <Text style={[toolCallStylesheet.sectionTitle, toolCallStylesheet.errorSectionTitle]}>
                  Error
                </Text>
                <View style={[toolCallStylesheet.sectionContent, toolCallStylesheet.errorSectionContent]}>
                  <Text style={toolCallStylesheet.sectionText}>
                    {JSON.stringify(error, null, 2)}
                  </Text>
                </View>
              </View>
            )}
          </View>
        )}
      </View>
    </Pressable>
  );
}
