import { useState, useMemo } from "react";
import { useChatStore } from "../../stores/chatStore.js";
import { useSettingsStore } from "../../stores/settingsStore.js";
import ConversationItem from "./ConversationItem.jsx";
import Button from "../shared/Button.jsx";
import Input from "../shared/Input.jsx";
import Modal, { ConfirmModal } from "../shared/Modal.jsx";
import "./ConversationHistory.css";

const AVAILABLE_TAGS = [
  { id: "work", label: "Work", color: "#60a5fa" },
  { id: "personal", label: "Personal", color: "#6ee7b7" },
  { id: "coding", label: "Coding", color: "#c4b5fd" },
  { id: "research", label: "Research", color: "#fcd34d" },
  { id: "creative", label: "Creative", color: "#fb923c" },
];

export default function ConversationHistory() {
  const {
    conversations,
    activeConversationId,
    createConversation,
    setActiveConversation,
    deleteConversation,
    renameConversation,
    updateConversationTags,
    exportConversation,
  } = useChatStore();

  const { defaultModel } = useSettingsStore();

  const [search, setSearch] = useState("");
  const [searchInContent, setSearchInContent] = useState(false);
  const [selectedTag, setSelectedTag] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [renameModal, setRenameModal] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const [tagsModal, setTagsModal] = useState(null);
  const [exportModal, setExportModal] = useState(null);

  // Filter conversations
  const filteredConversations = useMemo(() => {
    return conversations.filter((c) => {
      // Filter by tag
      if (selectedTag && (!c.tags || !c.tags.includes(selectedTag))) {
        return false;
      }

      // Filter by search term
      if (search) {
        const searchLower = search.toLowerCase();
        const titleMatch = c.title.toLowerCase().includes(searchLower);

        if (searchInContent) {
          // Search within message content
          const contentMatch = c.messages?.some(
            (m) => m.content.toLowerCase().includes(searchLower)
          );
          return titleMatch || contentMatch;
        }

        return titleMatch;
      }

      return true;
    });
  }, [conversations, search, searchInContent, selectedTag]);

  const handleNewChat = () => {
    createConversation(defaultModel);
  };

  const handleDelete = () => {
    if (deleteConfirm) {
      deleteConversation(deleteConfirm);
      setDeleteConfirm(null);
    }
  };

  const handleRename = () => {
    if (renameModal && renameValue.trim()) {
      renameConversation(renameModal, renameValue.trim());
      setRenameModal(null);
      setRenameValue("");
    }
  };

  const openRenameModal = (id, currentTitle) => {
    setRenameModal(id);
    setRenameValue(currentTitle);
  };

  const handleTagToggle = (tagId) => {
    if (!tagsModal) return;
    const conv = conversations.find((c) => c.id === tagsModal);
    const currentTags = conv?.tags || [];
    const newTags = currentTags.includes(tagId)
      ? currentTags.filter((t) => t !== tagId)
      : [...currentTags, tagId];
    updateConversationTags(tagsModal, newTags);
  };

  const handleExport = (format) => {
    if (!exportModal) return;
    const content = exportConversation(exportModal, format);
    if (!content) return;

    const conv = conversations.find((c) => c.id === exportModal);
    const filename = `${conv.title.replace(/[^a-z0-9]/gi, "_")}.${format === "json" ? "json" : "md"}`;

    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    setExportModal(null);
  };

  const getConversationTags = (id) => {
    const conv = conversations.find((c) => c.id === id);
    return conv?.tags || [];
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

        <div className="history-search">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search conversations..."
          />
          <label className="history-search-content">
            <input
              type="checkbox"
              checked={searchInContent}
              onChange={(e) => setSearchInContent(e.target.checked)}
            />
            <span>Search in messages</span>
          </label>
        </div>

        {/* Tag Filter */}
        <div className="history-tags-filter">
          <button
            className={`tag-filter-btn ${!selectedTag ? "active" : ""}`}
            onClick={() => setSelectedTag(null)}
          >
            All
          </button>
          {AVAILABLE_TAGS.map((tag) => (
            <button
              key={tag.id}
              className={`tag-filter-btn ${selectedTag === tag.id ? "active" : ""}`}
              style={{ "--tag-color": tag.color }}
              onClick={() => setSelectedTag(selectedTag === tag.id ? null : tag.id)}
            >
              {tag.label}
            </button>
          ))}
        </div>
      </div>

      <div className="history-list">
        {filteredConversations.length === 0 ? (
          <div className="history-empty">
            {search || selectedTag
              ? "No matching conversations"
              : "No conversations yet"}
          </div>
        ) : (
          filteredConversations.map((conversation) => (
            <ConversationItem
              key={conversation.id}
              conversation={conversation}
              isActive={conversation.id === activeConversationId}
              onClick={() => setActiveConversation(conversation.id)}
              onDelete={setDeleteConfirm}
              onRename={(id) => openRenameModal(id, conversation.title)}
              onTags={setTagsModal}
              onExport={setExportModal}
              availableTags={AVAILABLE_TAGS}
            />
          ))
        )}
      </div>

      {/* Delete Confirmation Modal */}
      <ConfirmModal
        isOpen={deleteConfirm !== null}
        onClose={() => setDeleteConfirm(null)}
        onConfirm={handleDelete}
        title="Delete Conversation"
        message="Are you sure you want to delete this conversation? This cannot be undone."
        confirmText="Delete"
      />

      {/* Rename Modal */}
      <Modal
        isOpen={renameModal !== null}
        onClose={() => {
          setRenameModal(null);
          setRenameValue("");
        }}
        title="Rename Conversation"
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setRenameModal(null);
                setRenameValue("");
              }}
            >
              Cancel
            </Button>
            <Button onClick={handleRename}>Save</Button>
          </>
        }
      >
        <Input
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          placeholder="Enter new name..."
          autoFocus
          onKeyDown={(e) => e.key === "Enter" && handleRename()}
        />
      </Modal>

      {/* Tags Modal */}
      <Modal
        isOpen={tagsModal !== null}
        onClose={() => setTagsModal(null)}
        title="Manage Tags"
      >
        <div className="tags-modal-content">
          {AVAILABLE_TAGS.map((tag) => {
            const isSelected = getConversationTags(tagsModal).includes(tag.id);
            return (
              <button
                key={tag.id}
                className={`tag-select-btn ${isSelected ? "selected" : ""}`}
                style={{ "--tag-color": tag.color }}
                onClick={() => handleTagToggle(tag.id)}
              >
                <span className="tag-dot" />
                {tag.label}
              </button>
            );
          })}
        </div>
      </Modal>

      {/* Export Modal */}
      <Modal
        isOpen={exportModal !== null}
        onClose={() => setExportModal(null)}
        title="Export Conversation"
      >
        <div className="export-modal-content">
          <p>Choose export format:</p>
          <div className="export-buttons">
            <Button onClick={() => handleExport("json")}>
              Export as JSON
            </Button>
            <Button variant="secondary" onClick={() => handleExport("markdown")}>
              Export as Markdown
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
