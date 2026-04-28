import { useState } from "react";
import { useChatStore } from "../../stores/chatStore.js";
import { useSettingsStore } from "../../stores/settingsStore.js";
import ConversationItem from "./ConversationItem.jsx";
import Button from "../shared/Button.jsx";
import Input from "../shared/Input.jsx";
import { ConfirmModal } from "../shared/Modal.jsx";
import "./ConversationHistory.css";

export default function ConversationHistory() {
  const {
    conversations,
    activeConversationId,
    createConversation,
    setActiveConversation,
    deleteConversation,
  } = useChatStore();

  const { defaultModel } = useSettingsStore();

  const [search, setSearch] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState(null);

  const filteredConversations = conversations.filter((c) =>
    c.title.toLowerCase().includes(search.toLowerCase())
  );

  const handleNewChat = () => {
    createConversation(defaultModel);
  };

  const handleDelete = () => {
    if (deleteConfirm) {
      deleteConversation(deleteConfirm);
      setDeleteConfirm(null);
    }
  };

  return (
    <div className="history-container">
      <div className="history-header">
        <h3 className="history-title">Conversations</h3>
        <Button
          onClick={handleNewChat}
          style={{ width: "100%", marginBottom: "12px" }}
        >
          + New Chat
        </Button>
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search conversations..."
        />
      </div>

      <div className="history-list">
        {filteredConversations.length === 0 ? (
          <div className="history-empty">
            {search ? "No matching conversations" : "No conversations yet"}
          </div>
        ) : (
          filteredConversations.map((conversation) => (
            <ConversationItem
              key={conversation.id}
              conversation={conversation}
              isActive={conversation.id === activeConversationId}
              onClick={() => setActiveConversation(conversation.id)}
              onDelete={setDeleteConfirm}
            />
          ))
        )}
      </div>

      <ConfirmModal
        isOpen={deleteConfirm !== null}
        onClose={() => setDeleteConfirm(null)}
        onConfirm={handleDelete}
        title="Delete Conversation"
        message="Are you sure you want to delete this conversation? This cannot be undone."
        confirmText="Delete"
      />
    </div>
  );
}
