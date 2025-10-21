import { useState, useEffect } from 'react';
import { Modal, View, Text, Pressable, ScrollView, Alert } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { UseWebSocketReturn } from '../hooks/use-websocket';

const STORAGE_KEY = '@voice-assistant:conversation-id';

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
    const unsubscribe = websocket.on('list_conversations_response', (message) => {
      console.log('[ConversationSelector] Received conversations:', message.payload.conversations.length);
      setConversations(message.payload.conversations);
      setIsLoading(false);
    });

    return unsubscribe;
  }, [websocket]);

  // Listen for delete conversation responses
  useEffect(() => {
    const unsubscribe = websocket.on('delete_conversation_response', (message) => {
      console.log('[ConversationSelector] Delete response:', message.payload);
      if (message.payload.success) {
        // Refresh conversations list
        fetchConversations();

        // If we deleted the current conversation, start a new one
        if (message.payload.conversationId === currentConversationId) {
          handleNewConversation();
        }
      } else {
        Alert.alert('Error', `Failed to delete conversation: ${message.payload.error}`);
      }
    });

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
    console.log('[ConversationSelector] Requesting conversations via WebSocket');
    websocket.send({
      type: 'session',
      message: {
        type: 'list_conversations_request',
      },
    });
  }

  function handleDeleteConversation(id: string) {
    Alert.alert(
      'Delete Conversation',
      'Are you sure you want to delete this conversation?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            console.log('[ConversationSelector] Deleting conversation via WebSocket:', id);
            websocket.send({
              type: 'session',
              message: {
                type: 'delete_conversation_request',
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
      'Clear All Conversations',
      'Are you sure you want to delete all conversations?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear All',
          style: 'destructive',
          onPress: () => {
            console.log('[ConversationSelector] Clearing all conversations via WebSocket');
            // Delete all conversations
            conversations.forEach((conv) => {
              websocket.send({
                type: 'session',
                message: {
                  type: 'delete_conversation_request',
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
      console.error('[ConversationSelector] Failed to save conversation ID:', error);
    }
  }

  async function handleNewConversation() {
    try {
      // Clear saved conversation ID
      await AsyncStorage.removeItem(STORAGE_KEY);
      onSelectConversation(null);
      setIsOpen(false);
    } catch (error) {
      console.error('[ConversationSelector] Failed to clear conversation ID:', error);
    }
  }

  function formatDate(dateString: string): string {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  }

  return (
    <View>
      <Pressable
        onPress={() => setIsOpen(true)}
        className="bg-zinc-800 px-4 py-2 rounded-lg"
      >
        <MaterialIcons name="chat-bubble-outline" size={20} color="white" />
      </Pressable>

      <Modal
        visible={isOpen}
        animationType="slide"
        transparent={true}
        onRequestClose={() => setIsOpen(false)}
      >
        <View className="flex-1 bg-black/50">
          <Pressable
            className="flex-1"
            onPress={() => setIsOpen(false)}
          />
          <View className="bg-zinc-900 rounded-t-3xl max-h-[80%]">
            {/* Header */}
            <View className="flex-row items-center justify-between p-6 border-b border-zinc-800">
              <Text className="text-white text-lg font-semibold">Conversations</Text>
              <Pressable onPress={() => setIsOpen(false)}>
                <MaterialIcons name="close" size={24} color="white" />
              </Pressable>
            </View>

            {/* New Conversation Button */}
            <View className="p-4 border-b border-zinc-800">
              <Pressable
                onPress={handleNewConversation}
                className="flex-row items-center justify-center gap-2 bg-zinc-800 py-3 rounded-lg"
              >
                <MaterialIcons name="add" size={20} color="white" />
                <Text className="text-white font-semibold">New Conversation</Text>
              </Pressable>
            </View>

            {/* Conversations List */}
            <ScrollView className="flex-1">
              {isLoading ? (
                <View className="p-8 items-center">
                  <Text className="text-zinc-400">Loading...</Text>
                </View>
              ) : conversations.length > 0 ? (
                <>
                  {conversations.map((conversation) => (
                    <Pressable
                      key={conversation.id}
                      onPress={() => handleSelectConversation(conversation.id)}
                      className={`flex-row items-center justify-between p-4 border-b border-zinc-800 ${
                        conversation.id === currentConversationId ? 'bg-zinc-800' : ''
                      }`}
                    >
                      <View className="flex-1">
                        <Text className="text-white font-semibold">
                          {conversation.messageCount} messages
                        </Text>
                        <Text className="text-zinc-400 text-sm mt-1">
                          {formatDate(conversation.lastUpdated)}
                        </Text>
                      </View>
                      <Pressable
                        onPress={() => handleDeleteConversation(conversation.id)}
                        className="p-2"
                        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                      >
                        <MaterialIcons name="delete-outline" size={20} color="#ef4444" />
                      </Pressable>
                    </Pressable>
                  ))}

                  {/* Clear All Button */}
                  <View className="p-4">
                    <Pressable
                      onPress={handleClearAll}
                      className="flex-row items-center justify-center gap-2 bg-red-900/20 py-3 rounded-lg border border-red-900"
                    >
                      <MaterialIcons name="delete-outline" size={18} color="#ef4444" />
                      <Text className="text-red-500 font-semibold">Clear All</Text>
                    </Pressable>
                  </View>
                </>
              ) : (
                <View className="p-8 items-center">
                  <Text className="text-zinc-400">No saved conversations</Text>
                </View>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}
