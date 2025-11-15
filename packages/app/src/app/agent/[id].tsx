import { useEffect, useMemo, useRef, useCallback, useState } from "react";
import {
  View,
  Text,
  ActivityIndicator,
  Pressable,
  Modal,
  useWindowDimensions,
  LayoutChangeEvent,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import ReanimatedAnimated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { MoreVertical, GitBranch, Folder, RotateCcw } from "lucide-react-native";
import { BackHeader } from "@/components/headers/back-header";
import { AgentStreamView } from "@/components/agent-stream-view";
import { AgentInputArea } from "@/components/agent-input-area";
import { useSession } from "@/contexts/session-context";
import { useFooterControls } from "@/contexts/footer-controls-context";

const DROPDOWN_WIDTH = 220;

export default function AgentScreen() {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const {
    agents,
    agentStreamState,
    initializingAgents,
    pendingPermissions,
    respondToPermission,
    initializeAgent,
    refreshAgent,
    setFocusedAgentId,
  } = useSession();
  const { registerFooterControls, unregisterFooterControls } = useFooterControls();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const [menuVisible, setMenuVisible] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0 });
  const [menuContentHeight, setMenuContentHeight] = useState(0);
  const menuButtonRef = useRef<View>(null);

  // Keyboard animation
  const { height: keyboardHeight } = useReanimatedKeyboardAnimation();
  const bottomInset = useSharedValue(insets.bottom);

  useEffect(() => {
    bottomInset.value = insets.bottom;
  }, [insets.bottom, bottomInset]);

  const animatedKeyboardStyle = useAnimatedStyle(() => {
    "worklet";
    const absoluteHeight = Math.abs(keyboardHeight.value);
    const shift = Math.max(0, absoluteHeight - bottomInset.value);
    return {
      transform: [{ translateY: -shift }],
    };
  });

  const agent = id ? agents.get(id) : undefined;
  const streamItems = id ? agentStreamState.get(id) || [] : [];
  const agentPermissions = new Map(
    Array.from(pendingPermissions.entries()).filter(([_, perm]) => perm.agentId === id)
  );

  useEffect(() => {
    if (!id) {
      setFocusedAgentId(null);
      return;
    }

    setFocusedAgentId(id);
    return () => {
      setFocusedAgentId(null);
    };
  }, [id, setFocusedAgentId]);

  const hasStreamState = id ? agentStreamState.has(id) : false;
  const initializationState = id ? initializingAgents.get(id) : undefined;
  const isInitializing = id
    ? initializationState !== undefined
      ? initializationState
      : !hasStreamState
    : false;

  useEffect(() => {
    if (!id) {
      return;
    }

    if (initializationState !== undefined) {
      return;
    }

    if (hasStreamState) {
      return;
    }

    initializeAgent({ agentId: id });
  }, [id, initializeAgent, initializationState, hasStreamState]);

  const agentControls = useMemo(() => {
    if (!id) return null;
    return <AgentInputArea agentId={id} />;
  }, [id]);

  useEffect(() => {
    if (!agentControls || !agent || isInitializing) {
      unregisterFooterControls();
      return;
    }

    registerFooterControls(agentControls);

    return () => {
      unregisterFooterControls();
    };
  }, [agentControls, agent, isInitializing, registerFooterControls, unregisterFooterControls]);

  const recalculateMenuPosition = useCallback(
    (onMeasured?: () => void) => {
      requestAnimationFrame(() => {
        const anchor = menuButtonRef.current;

        if (!anchor) {
          if (onMeasured) {
            onMeasured();
          }
          return;
        }

        anchor.measureInWindow((x, y, width, height) => {
          const verticalOffset = 8;
          const horizontalMargin = 16;
          const desiredLeft = x + width - DROPDOWN_WIDTH;
          const maxLeft = windowWidth - DROPDOWN_WIDTH - horizontalMargin;
          const clampedLeft = Math.min(Math.max(desiredLeft, horizontalMargin), maxLeft);

          // Position menu below button - add insets.top to account for status bar
          const buttonBottom = y + height + insets.top;
          const top = buttonBottom + verticalOffset;
          
          // If menu would go off screen, clamp to visible area
          const bottomEdge = top + menuContentHeight;
          const maxBottom = windowHeight - horizontalMargin;
          const clampedTop = bottomEdge > maxBottom 
            ? Math.max(verticalOffset, maxBottom - menuContentHeight)
            : top;

          console.log('[Menu] Button position:', { x, y, width, height, insetsTop: insets.top });
          console.log('[Menu] Calculated position:', { buttonBottom, top, clampedTop, left: clampedLeft });

          setMenuPosition({
            top: clampedTop,
            left: clampedLeft,
          });

          if (onMeasured) {
            onMeasured();
          }
        });
      });
    },
    [menuContentHeight, windowHeight, windowWidth]
  );

  const handleOpenMenu = useCallback(() => {
    recalculateMenuPosition(() => {
      setMenuVisible(true);
    });
  }, [recalculateMenuPosition]);

  const handleCloseMenu = useCallback(() => {
    setMenuVisible(false);
    setMenuContentHeight(0);
  }, []);

  useEffect(() => {
    if (!menuVisible) {
      return;
    }

    recalculateMenuPosition();
  }, [menuVisible, recalculateMenuPosition]);

  const handleMenuLayout = useCallback((event: LayoutChangeEvent) => {
    const { height } = event.nativeEvent.layout;
    setMenuContentHeight((current) => (current === height ? current : height));
  }, []);

  const handleViewChanges = useCallback(() => {
    handleCloseMenu();
    if (id) {
      router.push(`/git-diff?agentId=${id}`);
    }
  }, [id, router, handleCloseMenu]);

  const handleBrowseFiles = useCallback(() => {
    handleCloseMenu();
    if (id) {
      router.push(`/file-explorer?agentId=${id}`);
    }
  }, [handleCloseMenu, id, router]);

  const handleRefreshAgent = useCallback(() => {
    if (!id) {
      return;
    }
    if (!agent?.persistence) {
      handleCloseMenu();
      return;
    }
    handleCloseMenu();
    refreshAgent({ agentId: id });
  }, [agent?.persistence, handleCloseMenu, id, refreshAgent]);

  if (!agent) {
    return (
      <View style={styles.container}>
        <BackHeader />
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>Agent not found</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Header */}
      <BackHeader 
        title={agent.title || "Agent"}
        rightContent={
          <View ref={menuButtonRef} collapsable={false}>
            <Pressable onPress={handleOpenMenu} style={styles.menuButton}>
              <MoreVertical size={20} color={theme.colors.foreground} />
            </Pressable>
          </View>
        }
      />

      {/* Content Area with Keyboard Animation */}
      <View style={styles.contentContainer}>
        <ReanimatedAnimated.View style={[styles.content, animatedKeyboardStyle]}>
          {isInitializing ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="large" color={theme.colors.primary} />
              <Text style={styles.loadingText}>Loading agent...</Text>
            </View>
          ) : (
            <AgentStreamView
              agentId={id!}
              agent={agent}
              streamItems={streamItems}
              pendingPermissions={agentPermissions}
              onPermissionResponse={(agentId, requestId, response) =>
                respondToPermission(agentId, requestId, response)
              }
            />
          )}
        </ReanimatedAnimated.View>
      </View>

      {/* Dropdown Menu */}
      <Modal
        visible={menuVisible}
        animationType="fade"
        transparent={true}
        onRequestClose={handleCloseMenu}
      >
        <View style={styles.menuOverlay}>
          <Pressable style={styles.menuBackdrop} onPress={handleCloseMenu} />
          <View
            style={[
              styles.dropdownMenu,
              {
                position: "absolute",
                top: menuPosition.top,
                left: menuPosition.left,
                width: DROPDOWN_WIDTH,
              },
            ]}
            onLayout={handleMenuLayout}
          >
            <Pressable onPress={handleViewChanges} style={styles.menuItem}>
              <GitBranch size={20} color={theme.colors.foreground} />
              <Text style={styles.menuItemText}>View Changes</Text>
            </Pressable>
            <Pressable onPress={handleBrowseFiles} style={styles.menuItem}>
              <Folder size={20} color={theme.colors.foreground} />
              <Text style={styles.menuItemText}>Browse Files</Text>
            </Pressable>
            {agent.persistence && (
              <Pressable
                onPress={handleRefreshAgent}
                style={[
                  styles.menuItem,
                  isInitializing ? styles.menuItemDisabled : null,
                ]}
                disabled={isInitializing}
              >
                <RotateCcw size={20} color={theme.colors.foreground} />
                <Text style={styles.menuItemText}>
                  {isInitializing ? "Refreshing..." : "Refresh"}
                </Text>
                {isInitializing && (
                  <ActivityIndicator
                    size="small"
                    color={theme.colors.primary}
                    style={styles.menuItemSpinner}
                  />
                )}
              </Pressable>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  contentContainer: {
    flex: 1,
    overflow: "hidden",
  },
  content: {
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
  },
  loadingText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.mutedForeground,
  },
  errorContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  errorText: {
    fontSize: theme.fontSize.lg,
    color: theme.colors.mutedForeground,
  },
  menuButton: {
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
  },
  menuOverlay: {
    flex: 1,
  },
  menuBackdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  dropdownMenu: {
    backgroundColor: theme.colors.popover,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[2],
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 5,
  },
  menuItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
  },
  menuItemDisabled: {
    opacity: 0.6,
  },
  menuItemSpinner: {
    marginLeft: "auto",
  },
  menuItemText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.normal,
  },
}));
