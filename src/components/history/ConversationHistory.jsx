import { useState } from "react";
import { useChatStore } from "../../stores/chatStore.js";
import { useSettingsStore } from "../../stores/settingsStore.js";
import ConversationItem from "./ConversationItem.jsx";
import Button from "../shared/Button.jsx";
import Input from "../shared/Input.jsx";
import { ConfirmModal } from "../shared/Modal.jsx";

const containerStyle = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  background: "rgba(255,255,255,0.02)",
  borderRadius: "12px",
  border: "1px solid rgba(255,255,255,0.06)",
  overflow: "hidden",
};

const headerStyle = {
  padding: "16px",
  borderBottom: "1px solid rgba(255,255,255,0.06)",
};

const titleStyle = {
  fontSize: "16px",
  fontWeight: "600",
  color: "#e8e8f0",
  margin: "0 0 12px 0",
};

const listStyle = {
  flex: 1,
  overflow: "auto",
  padding: "12px",
};

const emptyStyle = {
  textAlign: "center",
  color: "#8a8a9a",
  padding: "40px 20px",
  fontSize: "14px",
};

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
    <div style={containerStyle}>
      <div style={headerStyle}>
        <h3 style={titleStyle}>Conversations</h3>
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

      <div style={listStyle}>
        {filteredConversations.length === 0 ? (
          <div style={emptyStyle}>
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
