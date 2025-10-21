import { View, Text, Pressable, Animated } from 'react-native';
import { useState, useEffect, useRef } from 'react';

interface UserMessageProps {
  message: string;
  timestamp: number;
}

export function UserMessage({ message, timestamp }: UserMessageProps) {
  const time = new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return (
    <View className="flex-row justify-end mb-3 px-4">
      <View className="bg-blue-600 rounded-2xl rounded-tr-sm px-4 py-3 max-w-[80%]">
        <Text className="text-white text-base leading-5">{message}</Text>
        <Text className="text-blue-200 text-xs mt-1">{time}</Text>
      </View>
    </View>
  );
}

interface AssistantMessageProps {
  message: string;
  timestamp: number;
  isStreaming?: boolean;
}

export function AssistantMessage({ message, timestamp, isStreaming = false }: AssistantMessageProps) {
  const time = new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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

  return (
    <View className="flex-row justify-start mb-3 px-4">
      <View className="bg-teal-800 rounded-2xl rounded-tl-sm px-4 py-3 max-w-[80%]">
        <Text className="text-teal-50 text-base leading-5">{message}</Text>
        <View className="flex-row items-center justify-between mt-1">
          <Text className="text-teal-200 text-xs">{time}</Text>
          {isStreaming && (
            <Animated.View style={{ opacity: fadeAnim }}>
              <Text className="text-teal-200 text-xs ml-2 font-bold">...</Text>
            </Animated.View>
          )}
        </View>
      </View>
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
    system: { bg: 'bg-zinc-800/50', text: 'text-zinc-400', icon: '●' },
    info: { bg: 'bg-blue-900/30', text: 'text-blue-400', icon: 'i' },
    success: { bg: 'bg-green-900/30', text: 'text-green-400', icon: '✓' },
    error: { bg: 'bg-red-900/30', text: 'text-red-400', icon: '✗' },
    artifact: { bg: 'bg-blue-900/40', text: 'text-blue-300', icon: '📋' },
  };

  const config = typeConfig[type];

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

  return (
    <Pressable
      onPress={handlePress}
      disabled={type !== 'artifact' && !metadata}
      className={`mx-2 mb-1 rounded-md overflow-hidden ${config.bg} ${
        (type === 'artifact' || metadata) ? 'active:opacity-70' : ''
      }`}
    >
      <View className="px-3 py-2.5">
        <View className="flex-row items-start gap-2">
          <Text className={`${config.text} text-sm leading-5`}>
            {config.icon}
          </Text>
          <View className="flex-1">
            <Text className={`${config.text} text-sm leading-5`}>
              {displayMessage}
            </Text>
            {metadata && (
              <View className="flex-row items-center mt-1">
                <Text className="text-zinc-500 text-xs">Details</Text>
                <Text className="text-zinc-500 text-xs ml-1">
                  {isExpanded ? '▼' : '▶'}
                </Text>
              </View>
            )}
          </View>
        </View>
        {isExpanded && metadata && (
          <View className="mt-2 bg-black/50 rounded p-2 border border-zinc-700">
            <Text className="text-zinc-300 text-xs font-mono leading-4">
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
      border: 'border-amber-500',
      bg: 'bg-amber-500/20',
      text: 'text-amber-300',
      icon: '⟳',
      label: 'executing',
    },
    completed: {
      border: 'border-green-500',
      bg: 'bg-green-500/20',
      text: 'text-green-300',
      icon: '✓',
      label: 'completed',
    },
    failed: {
      border: 'border-red-500',
      bg: 'bg-red-500/20',
      text: 'text-red-300',
      icon: '✗',
      label: 'failed',
    },
  };

  const config = statusConfig[status];

  return (
    <Pressable
      onPress={() => setIsExpanded(!isExpanded)}
      className={`mx-2 mb-2 bg-zinc-900 rounded-lg border ${config.border} overflow-hidden active:opacity-80`}
    >
      <View className="p-3">
        <View className="flex-row items-center">
          <Text className="text-zinc-400 text-sm mr-2">
            {isExpanded ? '▼' : '▶'}
          </Text>
          <Text className="text-slate-200 font-mono font-medium text-sm flex-1">
            {toolName}
          </Text>
          <View className={`flex-row items-center gap-1.5 px-2 py-1 rounded ${config.bg}`}>
            {status === 'executing' ? (
              <Animated.Text
                style={{ transform: [{ rotate: spin }] }}
                className={`${config.text} text-xs`}
              >
                {config.icon}
              </Animated.Text>
            ) : (
              <Text className={`${config.text} text-xs`}>
                {config.icon}
              </Text>
            )}
            <Text className={`${config.text} text-xs font-medium uppercase`}>
              {config.label}
            </Text>
          </View>
        </View>

        {isExpanded && (
          <View className="mt-3 gap-2">
            <View>
              <Text className="text-zinc-400 text-xs font-semibold uppercase tracking-wide mb-1.5">
                Arguments
              </Text>
              <View className="bg-black rounded border border-zinc-700 p-2">
                <Text className="text-slate-200 text-xs font-mono leading-4">
                  {JSON.stringify(args, null, 2)}
                </Text>
              </View>
            </View>

            {result !== undefined && (
              <View>
                <Text className="text-zinc-400 text-xs font-semibold uppercase tracking-wide mb-1.5">
                  Result
                </Text>
                <View className="bg-black rounded border border-zinc-700 p-2">
                  <Text className="text-slate-200 text-xs font-mono leading-4">
                    {JSON.stringify(result, null, 2)}
                  </Text>
                </View>
              </View>
            )}

            {error !== undefined && (
              <View>
                <Text className="text-red-400 text-xs font-semibold uppercase tracking-wide mb-1.5">
                  Error
                </Text>
                <View className="bg-black rounded border border-red-800 p-2">
                  <Text className="text-slate-200 text-xs font-mono leading-4">
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
