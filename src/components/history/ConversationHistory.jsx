import { useState, useMemo } from "react";
import { useChatStore } from "../../stores/chatStore.js";
import { useSettingsStore } from "../../stores/settingsStore.js";
import { authHeaders } from "../../services/auth.js";
import ConversationItem from "./ConversationItem.jsx";
import Button from "../shared/Button.jsx";
import Input from "../shared/Input.jsx";
import Modal, { ConfirmModal } from "../shared/Modal.jsx";
import "./ConversationHistory.css";

const TAG_COLORS = [
  "#60a5fa", "#6ee7b7", "#c4b5fd", "#fcd34d", "#fb923c",
  "#f87171", "#a78bfa", "#34d399", "#fbbf24", "#f472b6",
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

  const { defaultModel, customTags = [], updateSetting } = useSettingsStore();
  const tags = customTags || [];

  const [search, setSearch] = useState("");
  const [searchInContent, setSearchInContent] = useState(false);
  const [selectedTag, setSelectedTag] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [renameModal, setRenameModal] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const [tagsModal, setTagsModal] = useState(null);
  const [exportModal, setExportModal] = useState(null);
  const [newTagName, setNewTagName] = useState("");
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());

  // Filter and organize conversations with branches
  const { rootConversations, branchMap } = useMemo(() => {
    // Filter all conversations first
    const filtered = conversations.filter((c) => {
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

    // Separate root conversations and branches
    const roots = filtered.filter((c) => !c.parentConversationId);
    const branches = new Map();

    for (const conv of filtered) {
      if (conv.parentConversationId) {
        if (!branches.has(conv.parentConversationId)) {
          branches.set(conv.parentConversationId, []);
        }
        branches.get(conv.parentConversationId).push(conv);
      }
    }

    return { rootConversations: roots, branchMap: branches };
  }, [conversations, search, searchInContent, selectedTag]);

  const handleNewChat = async () => {
    await createConversation(defaultModel);
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

  // Helper to save file using File System Access API or fallback
  const saveFile = async (content, filename, mimeType) => {
    if ('showSaveFilePicker' in window) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: filename,
          types: [
            mimeType.includes('json')
              ? { description: 'JSON', accept: { 'application/json': ['.json'] } }
              : { description: 'Markdown', accept: { 'text/markdown': ['.md'] } }
          ]
        });
        const writable = await handle.createWritable();
        await writable.write(content);
        await writable.close();
        return;
      } catch (err) {
        if (err.name === 'AbortError') return;
        // Fall through to blob method
      }
    }
    // Fallback
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExport = async (format) => {
    if (!exportModal) return;

    try {
      const response = await fetch(`http://localhost:3001/api/export/conversations/${exportModal}?format=${format}`, {
        headers: await authHeaders()
      });

      if (!response.ok) throw new Error('Export failed');

      const conv = conversations.find((c) => c.id === exportModal);
      const filename = `${conv.title.replace(/[^a-z0-9]/gi, "_")}.${format === "json" ? "json" : "md"}`;

      if (format === 'json') {
        const data = await response.json();
        await saveFile(JSON.stringify(data, null, 2), filename, 'application/json');
      } else {
        const text = await response.text();
        await saveFile(text, filename, 'text/markdown');
      }
    } catch (err) {
      console.error('Export failed:', err);
    }

    setExportModal(null);
  };

  const toggleSelectMode = () => {
    setSelectMode(!selectMode);
    setSelectedIds(new Set());
  };

  const toggleSelect = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleBulkExport = async (format) => {
    if (selectedIds.size === 0) return;

    try {
      const response = await fetch('http://localhost:3001/api/export/bulk', {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({ ids: [...selectedIds], format })
      });

      if (!response.ok) throw new Error('Bulk export failed');

      if (format === 'json') {
        const data = await response.json();
        await saveFile(JSON.stringify(data, null, 2), 'llmui_export.json', 'application/json');
      } else {
        // For markdown, we get array of files
        const { files } = await response.json();
        // Download each file
        for (const file of files) {
          await saveFile(file.content, file.filename, 'text/markdown');
        }
      }

      setSelectMode(false);
      setSelectedIds(new Set());
    } catch (err) {
      console.error('Bulk export failed:', err);
    }
  };

  const getConversationTags = (id) => {
    const conv = conversations.find((c) => c.id === id);
    return conv?.tags || [];
  };

  return (
    <div className="history-container">
      <div className="history-header">
        <div className="history-title-row">
          <h3 className="history-title">Conversations</h3>
          <button
            className={`select-mode-btn ${selectMode ? 'active' : ''}`}
            onClick={toggleSelectMode}
            title={selectMode ? 'Cancel selection' : 'Select multiple'}
          >
            {selectMode ? 'Cancel' : 'Select'}
          </button>
        </div>

        {selectMode && selectedIds.size > 0 && (
          <div className="bulk-actions">
            <span className="bulk-count">{selectedIds.size} selected</span>
            <button className="bulk-export-btn" onClick={() => handleBulkExport('json')}>
              Export JSON
            </button>
            <button className="bulk-export-btn" onClick={() => handleBulkExport('markdown')}>
              Export MD
            </button>
          </div>
        )}

        {!selectMode && (
          <Button
            onClick={handleNewChat}
            style={{ width: "100%", marginBottom: "12px" }}
          >
            + New Chat
          </Button>
        )}

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
        {tags.length > 0 && (
          <div className="history-tags-filter">
            <button
              className={`tag-filter-btn ${!selectedTag ? "active" : ""}`}
              onClick={() => setSelectedTag(null)}
            >
              All
            </button>
            {tags.map((tag) => (
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
        )}
      </div>

      <div className="history-list">
        {rootConversations.length === 0 && branchMap.size === 0 ? (
          <div className="history-empty">
            {search || selectedTag
              ? "No matching conversations"
              : "No conversations yet"}
          </div>
        ) : (
          rootConversations.map((conversation) => (
            <div key={conversation.id} className="conversation-with-branches">
              <ConversationItem
                conversation={conversation}
                isActive={conversation.id === activeConversationId}
                onClick={() => selectMode ? toggleSelect(conversation.id) : setActiveConversation(conversation.id)}
                onDelete={setDeleteConfirm}
                onRename={(id) => openRenameModal(id, conversation.title)}
                onTags={setTagsModal}
                onExport={setExportModal}
                availableTags={tags}
                selectMode={selectMode}
                isSelected={selectedIds.has(conversation.id)}
              />
            </div>
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
        onClose={() => {
          setTagsModal(null);
          setNewTagName("");
        }}
        title="Manage Tags"
      >
        <div className="tags-modal-content">
          {tags.length === 0 && (
            <p className="tags-empty-hint">No tags yet. Create your first tag below.</p>
          )}
          {tags.map((tag) => {
            const isSelected = getConversationTags(tagsModal).includes(tag.id);
            return (
              <div key={tag.id} className="tag-select-row">
                <button
                  className={`tag-select-btn ${isSelected ? "selected" : ""}`}
                  style={{ "--tag-color": tag.color }}
                  onClick={() => handleTagToggle(tag.id)}
                >
                  <span className="tag-dot" />
                  {tag.label}
                </button>
                <button
                  className="tag-delete-btn"
                  onClick={() => {
                    const newTags = tags.filter((t) => t.id !== tag.id);
                    updateSetting("customTags", newTags);
                  }}
                  title="Delete tag"
                >
                  ×
                </button>
              </div>
            );
          })}
          <div className="tag-create-row">
            <Input
              value={newTagName}
              onChange={(e) => setNewTagName(e.target.value)}
              placeholder="New tag name..."
              onKeyDown={(e) => {
                if (e.key === "Enter" && newTagName.trim()) {
                  const newTag = {
                    id: newTagName.trim().toLowerCase().replace(/\s+/g, "-"),
                    label: newTagName.trim(),
                    color: TAG_COLORS[tags.length % TAG_COLORS.length],
                  };
                  updateSetting("customTags", [...tags, newTag]);
                  setNewTagName("");
                }
              }}
            />
            <Button
              onClick={() => {
                if (newTagName.trim()) {
                  const newTag = {
                    id: newTagName.trim().toLowerCase().replace(/\s+/g, "-"),
                    label: newTagName.trim(),
                    color: TAG_COLORS[tags.length % TAG_COLORS.length],
                  };
                  updateSetting("customTags", [...tags, newTag]);
                  setNewTagName("");
                }
              }}
              disabled={!newTagName.trim()}
            >
              Add
            </Button>
          </div>
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
