import { useState, useEffect, useRef } from "react";
import { MessageSquare, Plus, Trash2 } from "lucide-react";

interface Conversation {
  id: string;
  lastUpdated: string;
  messageCount: number;
}

interface ConversationSelectorProps {
  currentConversationId: string | null;
  onSelectConversation: (conversationId: string | null) => void;
}

export function ConversationSelector({
  currentConversationId,
  onSelectConversation,
}: ConversationSelectorProps) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Fetch conversations when dropdown opens
  useEffect(() => {
    if (isOpen) {
      fetchConversations();
    }
  }, [isOpen]);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    }

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => {
        document.removeEventListener("mousedown", handleClickOutside);
      };
    }
  }, [isOpen]);

  async function fetchConversations() {
    setIsLoading(true);
    try {
      const response = await fetch("/api/conversations");
      if (!response.ok) throw new Error("Failed to fetch conversations");
      const data = await response.json();
      setConversations(data);
    } catch (error) {
      console.error("[ConversationSelector] Failed to fetch conversations:", error);
    } finally {
      setIsLoading(false);
    }
  }

  async function handleDeleteConversation(id: string, event: React.MouseEvent) {
    event.stopPropagation();

    if (!confirm("Are you sure you want to delete this conversation?")) {
      return;
    }

    try {
      const response = await fetch(`/api/conversations/${id}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error("Failed to delete conversation");

      // Refresh list
      await fetchConversations();

      // If we deleted the current conversation, start a new one
      if (id === currentConversationId) {
        onSelectConversation(null);
      }
    } catch (error) {
      console.error("[ConversationSelector] Failed to delete conversation:", error);
      alert("Failed to delete conversation");
    }
  }

  async function handleClearAll(event: React.MouseEvent) {
    event.stopPropagation();

    if (!confirm("Are you sure you want to delete all conversations?")) {
      return;
    }

    try {
      // Delete all conversations
      await Promise.all(
        conversations.map((conv) =>
          fetch(`/api/conversations/${conv.id}`, { method: "DELETE" })
        )
      );

      // Refresh list
      setConversations([]);

      // Start new conversation
      onSelectConversation(null);
      setIsOpen(false);
    } catch (error) {
      console.error("[ConversationSelector] Failed to clear conversations:", error);
      alert("Failed to clear conversations");
    }
  }

  function handleSelectConversation(id: string) {
    onSelectConversation(id);
    setIsOpen(false);
  }

  function handleNewConversation() {
    onSelectConversation(null);
    setIsOpen(false);
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
    <div className="conversation-selector" ref={dropdownRef}>
      <button
        className="conversation-selector-button"
        onClick={() => setIsOpen(!isOpen)}
        title="Manage conversations"
      >
        <MessageSquare size={18} />
        <span className="conversation-selector-label">Conversations</span>
      </button>

      {isOpen && (
        <div className="conversation-selector-dropdown">
          <div className="conversation-selector-header">
            <button
              className="conversation-selector-new"
              onClick={handleNewConversation}
            >
              <Plus size={16} />
              New Conversation
            </button>
          </div>

          {isLoading ? (
            <div className="conversation-selector-loading">Loading...</div>
          ) : conversations.length > 0 ? (
            <>
              <div className="conversation-selector-list">
                {conversations.map((conversation) => (
                  <div
                    key={conversation.id}
                    className={`conversation-selector-item ${
                      conversation.id === currentConversationId ? "active" : ""
                    }`}
                    onClick={() => handleSelectConversation(conversation.id)}
                  >
                    <div className="conversation-selector-item-info">
                      <div className="conversation-selector-item-title">
                        {conversation.messageCount} messages
                      </div>
                      <div className="conversation-selector-item-date">
                        {formatDate(conversation.lastUpdated)}
                      </div>
                    </div>
                    <button
                      className="conversation-selector-delete"
                      onClick={(e) =>
                        handleDeleteConversation(conversation.id, e)
                      }
                      title="Delete conversation"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>

              <div className="conversation-selector-footer">
                <button
                  className="conversation-selector-clear-all"
                  onClick={handleClearAll}
                >
                  <Trash2 size={14} />
                  Clear All
                </button>
              </div>
            </>
          ) : (
            <div className="conversation-selector-empty">
              No saved conversations
            </div>
          )}
        </div>
      )}
    </div>
  );
}
