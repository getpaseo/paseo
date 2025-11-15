import { useState, useEffect } from "react";
import {
  Modal,
  View,
  Text,
  Pressable,
  ScrollView,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { MessageSquare, X, Plus, Trash2 } from "lucide-react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { StyleSheet } from "react-native-unistyles";
import type { UseWebSocketReturn } from "../hooks/use-websocket";

const STORAGE_KEY = "@paseo:conversation-id";

interface Conversation {
  id: string;
  lastUpdated: string;
  messageCount: number;
}

interface ConversationSelectorProps {
  currentConversationId: string | null;
  onSelectConversation: (conversationId: string | null) => void;
  websocket: UseWebSocketReturn;
}

export function ConversationSelector({
  currentConversationId,
  onSelectConversation,
  websocket,
}: ConversationSelectorProps) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  // Listen for conversation list responses
  useEffect(() => {
    const unsubscribe = websocket.on(
      "list_conversations_response",
      (message) => {
        if (message.type !== "list_conversations_response") return;
        setConversations(message.payload.conversations);
        setIsLoading(false);
      }
    );

    return unsubscribe;
  }, [websocket]);

  // Listen for delete conversation responses
  useEffect(() => {
    const unsubscribe = websocket.on(
      "delete_conversation_response",
      (message) => {
        if (message.type !== "delete_conversation_response") return;
        console.log("[ConversationSelector] Delete response:", message.payload);
        if (message.payload.success) {
          // Refresh conversations list
          fetchConversations();

          // If we deleted the current conversation, start a new one
          if (message.payload.conversationId === currentConversationId) {
            handleNewConversation();
          }
        } else {
          Alert.alert(
            "Error",
            `Failed to delete conversation: ${message.payload.error}`
          );
        }
      }
    );

    return unsubscribe;
  }, [websocket, currentConversationId]);

  // Fetch conversations when modal opens
  useEffect(() => {
    if (isOpen) {
      fetchConversations();
    }
  }, [isOpen]);

  function fetchConversations() {
    setIsLoading(true);
    console.log(
      "[ConversationSelector] Requesting conversations via WebSocket"
    );
    websocket.send({
      type: "session",
      message: {
        type: "list_conversations_request",
      },
    });
  }

  function handleDeleteConversation(id: string) {
    Alert.alert(
      "Delete Conversation",
      "Are you sure you want to delete this conversation?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            console.log(
              "[ConversationSelector] Deleting conversation via WebSocket:",
              id
            );
            websocket.send({
              type: "session",
              message: {
                type: "delete_conversation_request",
                conversationId: id,
              },
            });
          },
        },
      ]
    );
  }

  function handleClearAll() {
    Alert.alert(
      "Clear All Conversations",
      "Are you sure you want to delete all conversations?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Clear All",
          style: "destructive",
          onPress: () => {
            console.log(
              "[ConversationSelector] Clearing all conversations via WebSocket"
            );
            // Delete all conversations
            conversations.forEach((conv) => {
              websocket.send({
                type: "session",
                message: {
                  type: "delete_conversation_request",
                  conversationId: conv.id,
                },
              });
            });

            // Clear local state
            setConversations([]);

            // Start new conversation
            handleNewConversation();
            setIsOpen(false);
          },
        },
      ]
    );
  }

  async function handleSelectConversation(id: string) {
    try {
      // Save to AsyncStorage for persistence
      await AsyncStorage.setItem(STORAGE_KEY, id);
      onSelectConversation(id);
      setIsOpen(false);
    } catch (error) {
      console.error(
        "[ConversationSelector] Failed to save conversation ID:",
        error
      );
    }
  }

  async function handleNewConversation() {
    try {
      // Clear saved conversation ID
      await AsyncStorage.removeItem(STORAGE_KEY);
      onSelectConversation(null);
      setIsOpen(false);
    } catch (error) {
      console.error(
        "[ConversationSelector] Failed to clear conversation ID:",
        error
      );
    }
  }

  function formatDate(dateString: string): string {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  }

  return (
    <View>
      <Pressable onPress={() => setIsOpen(true)} style={styles.triggerButton}>
        <MessageSquare size={20} color="white" />
      </Pressable>

      <Modal
        visible={isOpen}
        animationType="slide"
        transparent={true}
        onRequestClose={() => setIsOpen(false)}
      >
        <View style={styles.modalOverlay}>
          <Pressable
            style={styles.modalBackdrop}
            onPress={() => setIsOpen(false)}
          />
          <View style={styles.modalContent}>
            <View style={styles.modalInner}>
              {/* Header */}
              <View style={styles.header}>
                <Text style={styles.headerTitle}>
                  Conversations{" "}
                  {conversations.length > 0 && `(${conversations.length})`}
                </Text>
                <Pressable onPress={() => setIsOpen(false)}>
                  <X size={24} color="white" />
                </Pressable>
              </View>

              {/* New Conversation Button */}
              <View style={styles.newButtonContainer}>
                <Pressable
                  onPress={handleNewConversation}
                  style={styles.newButton}
                >
                  <Plus size={20} color="white" />
                  <Text style={styles.newButtonText}>New Conversation</Text>
                </Pressable>
              </View>

              {/* Conversations List */}
              <ScrollView
                style={styles.scrollView}
                contentContainerStyle={styles.scrollContent}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="on-drag"
              >
                {isLoading && (
                  <View style={styles.loadingContainer}>
                    <Text style={styles.loadingText}>Loading...</Text>
                  </View>
                )}

                {!isLoading && conversations.length === 0 && (
                  <View style={styles.emptyContainer}>
                    <Text style={styles.emptyText}>No saved conversations</Text>
                  </View>
                )}

                {!isLoading &&
                  conversations.map((conversation) => (
                    <View
                      key={conversation.id}
                      style={[
                        styles.conversationItem,
                        conversation.id === currentConversationId &&
                          styles.conversationItemActive,
                      ]}
                    >
                      <Pressable
                        style={styles.conversationContent}
                        onPress={() =>
                          handleSelectConversation(conversation.id)
                        }
                      >
                        <Text style={styles.conversationTitle}>
                          {conversation.messageCount} messages
                        </Text>
                        <Text style={styles.conversationDate}>
                          {formatDate(conversation.lastUpdated)}
                        </Text>
                      </Pressable>
                      <Pressable
                        onPress={() =>
                          handleDeleteConversation(conversation.id)
                        }
                        style={styles.deleteButton}
                        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                      >
                        <Trash2 size={20} color="#ef4444" />
                      </Pressable>
                    </View>
                  ))}

                {!isLoading && conversations.length > 0 && (
                  <View style={styles.clearAllContainer}>
                    <Pressable
                      onPress={handleClearAll}
                      style={styles.clearAllButton}
                    >
                      <Trash2 size={18} color="#ef4444" />
                      <Text style={styles.clearAllText}>Clear All</Text>
                    </Pressable>
                  </View>
                )}
              </ScrollView>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  triggerButton: {
    backgroundColor: theme.colors.muted,
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
  },
  modalBackdrop: {
    flex: 1,
  },
  modalContent: {
    backgroundColor: theme.colors.card,
    borderTopLeftRadius: theme.spacing[6],
    borderTopRightRadius: theme.spacing[6],
    height: "80%",
  },
  modalInner: {
    flex: 1,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: theme.spacing[6],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  headerTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
  },
  newButtonContainer: {
    padding: theme.spacing[4],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  newButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    backgroundColor: theme.colors.muted,
    paddingVertical: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
  },
  newButtonText: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.semibold,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: theme.spacing[4] * 5,
  },
  loadingContainer: {
    padding: theme.spacing[8],
    alignItems: "center",
  },
  loadingText: {
    color: theme.colors.mutedForeground,
  },
  emptyContainer: {
    padding: theme.spacing[8],
    alignItems: "center",
  },
  emptyText: {
    color: theme.colors.mutedForeground,
  },
  conversationItem: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: theme.spacing[4],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    backgroundColor: "transparent",
  },
  conversationItemActive: {
    backgroundColor: theme.colors.muted,
  },
  conversationContent: {
    flex: 1,
  },
  conversationTitle: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.semibold,
    fontSize: theme.fontSize.base,
  },
  conversationDate: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[1],
  },
  deleteButton: {
    padding: theme.spacing[2],
  },
  clearAllContainer: {
    padding: theme.spacing[4],
  },
  clearAllButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    backgroundColor: "rgba(127, 29, 29, 0.2)",
    paddingVertical: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.palette.red[900],
  },
  clearAllText: {
    color: theme.colors.destructive,
    fontWeight: theme.fontWeight.semibold,
  },
}));
