/**
 * Client-side conversation ID management using localStorage
 */

const CONVERSATION_ID_KEY = "voice-assistant-conversation-id";

/**
 * Get current conversation ID from localStorage
 */
export function getCurrentConversationId(): string | null {
  try {
    return localStorage.getItem(CONVERSATION_ID_KEY);
  } catch (error) {
    console.error("[ConversationStorage] Failed to get conversation ID:", error);
    return null;
  }
}

/**
 * Set current conversation ID in localStorage
 */
export function setCurrentConversationId(id: string): void {
  try {
    localStorage.setItem(CONVERSATION_ID_KEY, id);
  } catch (error) {
    console.error("[ConversationStorage] Failed to set conversation ID:", error);
  }
}

/**
 * Clear current conversation ID from localStorage
 */
export function clearCurrentConversationId(): void {
  try {
    localStorage.removeItem(CONVERSATION_ID_KEY);
  } catch (error) {
    console.error("[ConversationStorage] Failed to clear conversation ID:", error);
  }
}
