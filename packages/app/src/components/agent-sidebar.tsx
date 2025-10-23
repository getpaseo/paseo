import { View, Text, Pressable, ScrollView } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Plus, X } from "lucide-react-native";
import { useEffect, useState } from "react";
import { GestureDetector, Gesture } from "react-native-gesture-handler";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  cancelAnimation,
  runOnJS,
  Easing,
  type SharedValue,
} from "react-native-reanimated";
import type { AgentStatus } from "@server/server/acp/types";

interface Agent {
  id: string;
  status: AgentStatus;
  title?: string;
  cwd: string;
}

interface AgentSidebarProps {
  isOpen: boolean;
  agents: Agent[];
  activeAgentId: string | null;
  onClose: () => void;
  onSelectAgent: (agentId: string) => void;
  onNewAgent: () => void;
  edgeSwipeTranslateX?: SharedValue<number> | null;
}

function getStatusColor(status: AgentStatus): string {
  switch (status) {
    case "initializing":
      return "#FFA500";
    case "ready":
      return "#2563EB";
    case "processing":
      return "#FACC15";
    case "completed":
      return "#10B981";
    case "failed":
      return "#EF4444";
    case "killed":
      return "#6B7280";
    default:
      return "#6B7280";
  }
}

function getStatusLabel(status: AgentStatus): string {
  switch (status) {
    case "initializing":
      return "Initializing";
    case "ready":
      return "Ready";
    case "processing":
      return "Processing";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "killed":
      return "Killed";
    default:
      return "Unknown";
  }
}

export function AgentSidebar({
  isOpen,
  agents,
  activeAgentId,
  onClose,
  onSelectAgent,
  onNewAgent,
  edgeSwipeTranslateX,
}: AgentSidebarProps) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const savedTranslateX = useSharedValue(0);
  const [isVisible, setIsVisible] = useState(isOpen);

  // Use edgeSwipeTranslateX directly since it's always provided
  const translateX = edgeSwipeTranslateX || useSharedValue(-300);

  useEffect(() => {
    if (isOpen) {
      setIsVisible(true);
      // Only animate if starting from fully closed position (not mid-animation from edge swipe)
      if (translateX.value === -300) {
        translateX.value = withTiming(0, {
          duration: 150,
          easing: Easing.out(Easing.ease),
        });
      }
    } else {
      // Only animate if starting from fully open position
      if (translateX.value === 0) {
        translateX.value = withTiming(-300, {
          duration: 150,
          easing: Easing.out(Easing.ease),
        }, (finished) => {
          if (finished) {
            runOnJS(setIsVisible)(false);
          }
        });
      } else if (translateX.value === -300) {
        // Already closed, just hide
        setIsVisible(false);
      }
    }
  }, [isOpen]);

  function handleAgentSelect(agentId: string) {
    onSelectAgent(agentId);
    onClose();
  }

  // Pan gesture for closing sidebar (swipe left on the sidebar)
  const closeGesture = Gesture.Pan()
    .enabled(isOpen) // Only active when sidebar is open
    .activeOffsetX(-10) // Require leftward swipe
    .onBegin(() => {
      cancelAnimation(translateX);
      savedTranslateX.value = translateX.value;
    })
    .onChange((event) => {
      // Directly update translateX - clamp between -300 and 0
      const newTranslateX = Math.max(-300, Math.min(0, savedTranslateX.value + event.translationX));
      translateX.value = newTranslateX;
    })
    .onEnd((event) => {
      const shouldClose = translateX.value < -150 || event.velocityX < -500;

      if (shouldClose) {
        translateX.value = withTiming(-300, {
          duration: 150,
          easing: Easing.out(Easing.ease),
        }, (finished) => {
          if (finished) {
            runOnJS(setIsVisible)(false);
            runOnJS(onClose)();
          }
        });
      } else {
        translateX.value = withTiming(0, {
          duration: 150,
          easing: Easing.out(Easing.ease),
        });
      }
    });

  const animatedSidebarStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  const animatedBackdropStyle = useAnimatedStyle(() => {
    // Map translateX (-300 to 0) to opacity (0 to 1)
    const opacity = (translateX.value + 300) / 300;
    return { opacity };
  });

  // Don't render if not visible
  if (!isVisible) {
    return null;
  }

  return (
    <>
      {/* Backdrop - fade in/out with sidebar */}
      <Pressable
        onPress={onClose}
        style={StyleSheet.absoluteFill}
        pointerEvents={isOpen ? "auto" : "none"}
      >
        <Animated.View style={[styles.backdrop, animatedBackdropStyle]} />
      </Pressable>

      {/* Sidebar with close gesture */}
      <GestureDetector gesture={closeGesture}>
        <Animated.View
          style={[
            styles.sidebar,
            {
              paddingTop: insets.top + 16,
              paddingBottom: insets.bottom + 16,
              backgroundColor: theme.colors.background,
            },
            animatedSidebarStyle,
          ]}
        >
          {/* Header */}
          <View style={styles.header}>
            <Text style={[styles.headerTitle, { color: theme.colors.foreground }]}>
              Agents
            </Text>
            <Pressable onPress={onClose} style={styles.closeButton}>
              <X size={24} color={theme.colors.mutedForeground} />
            </Pressable>
          </View>

          {/* New Agent Button */}
          <Pressable
            style={[styles.newAgentButton, { backgroundColor: theme.colors.primary }]}
            onPress={() => {
              onNewAgent();
              onClose();
            }}
          >
            <Plus size={20} color={theme.colors.primaryForeground} />
            <Text style={[styles.newAgentText, { color: theme.colors.primaryForeground }]}>
              New Agent
            </Text>
          </Pressable>

          {/* Agent List */}
          <ScrollView style={styles.agentList} showsVerticalScrollIndicator={false}>
            {agents.map((agent) => {
              const isActive = agent.id === activeAgentId;
              const statusColor = getStatusColor(agent.status);
              const statusLabel = getStatusLabel(agent.status);

              return (
                <Pressable
                  key={agent.id}
                  style={[
                    styles.agentItem,
                    { backgroundColor: isActive ? theme.colors.secondary : "transparent" },
                  ]}
                  onPress={() => handleAgentSelect(agent.id)}
                >
                  <View style={styles.agentContent}>
                    <Text
                      style={[
                        styles.agentTitle,
                        { color: theme.colors.foreground },
                      ]}
                      numberOfLines={1}
                    >
                      {agent.title || "New Agent"}
                    </Text>

                    <View style={styles.directoryRow}>
                      <Text
                        style={[styles.agentDirectory, { color: theme.colors.mutedForeground }]}
                        numberOfLines={1}
                      >
                        {agent.cwd}
                      </Text>

                      <View style={styles.statusBadge}>
                        <View
                          style={[styles.statusDot, { backgroundColor: statusColor }]}
                        />
                        <Text style={[styles.statusText, { color: statusColor }]}>
                          {statusLabel}
                        </Text>
                      </View>
                    </View>
                  </View>
                </Pressable>
              );
            })}

            {agents.length === 0 && (
              <View style={styles.emptyState}>
                <Text style={[styles.emptyText, { color: theme.colors.mutedForeground }]}>
                  No agents yet
                </Text>
              </View>
            )}
          </ScrollView>
        </Animated.View>
      </GestureDetector>
    </>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    zIndex: 998,
  },
  sidebar: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    width: 300,
    zIndex: 999,
    paddingHorizontal: 16,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 16,
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: "700",
  },
  closeButton: {
    padding: 4,
  },
  newAgentButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    marginBottom: 16,
    gap: 8,
  },
  newAgentText: {
    fontSize: 16,
    fontWeight: "600",
  },
  agentList: {
    flex: 1,
  },
  agentItem: {
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 8,
    marginBottom: 4,
  },
  agentContent: {
    flex: 1,
  },
  agentTitle: {
    fontSize: 15,
    fontWeight: "500",
    marginBottom: 2,
  },
  directoryRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  agentDirectory: {
    flex: 1,
    fontSize: 12,
  },
  statusBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusText: {
    fontSize: 11,
    fontWeight: "500",
  },
  emptyState: {
    paddingVertical: 32,
    alignItems: "center",
  },
  emptyText: {
    fontSize: 14,
  },
});
