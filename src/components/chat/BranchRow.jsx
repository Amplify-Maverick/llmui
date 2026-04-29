import { useEffect, useState } from "react";
import { useChatStore } from "../../stores/chatStore.js";
import "./BranchRow.css";

const BranchIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="6" y1="3" x2="6" y2="15"/>
    <circle cx="18" cy="6" r="3"/>
    <circle cx="6" cy="18" r="3"/>
    <path d="M18 9a9 9 0 0 1-9 9"/>
  </svg>
);

const TrashIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3 6 5 6 21 6"/>
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
  </svg>
);

export default function BranchRow() {
  const {
    conversations,
    activeConversationId,
    setActiveConversation,
    deleteConversation,
    loadBranches
  } = useChatStore();

  const [branches, setBranches] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());

  // Get current conversation
  const currentConv = conversations.find(c => c.id === activeConversationId);

  // Find the root conversation (original) and get parent info
  const parentId = currentConv?.parentConversationId;
  const rootId = parentId || activeConversationId;
  const rootConv = conversations.find(c => c.id === rootId);

  // Load branches when conversation changes
  useEffect(() => {
    if (!rootId) {
      setBranches([]);
      return;
    }

    const fetchBranches = async () => {
      setIsLoading(true);
      const branchList = await loadBranches(rootId);
      setBranches(branchList);
      setIsLoading(false);
    };

    fetchBranches();
  }, [rootId, loadBranches, conversations]);

  // Don't show if no branches exist and current is not a branch
  if (!parentId && branches.length === 0) {
    return null;
  }

  const isCurrentRoot = activeConversationId === rootId;

  const toggleSelect = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleDeleteSelected = async () => {
    if (selectedIds.size === 0) return;

    // Delete each selected branch
    for (const id of selectedIds) {
      await deleteConversation(id);
    }

    setSelectedIds(new Set());
    setSelectMode(false);
  };

  const cancelSelectMode = () => {
    setSelectMode(false);
    setSelectedIds(new Set());
  };

  return (
    <div className="branch-row">
      <div className="branch-row-header">
        <BranchIcon />
        <span>Branches</span>
      </div>
      <div className="branch-row-list">
        {/* Root conversation (Original) */}
        <button
          className={`branch-chip ${isCurrentRoot ? 'active' : ''}`}
          onClick={() => !selectMode && setActiveConversation(rootId)}
          title={rootConv?.title || 'Original'}
          disabled={selectMode}
        >
          <span className="branch-chip-label">Original</span>
        </button>

        {/* Branch conversations */}
        {branches.map((branch) => (
          <button
            key={branch.id}
            className={`branch-chip ${branch.id === activeConversationId ? 'active' : ''} ${selectMode ? 'select-mode' : ''} ${selectedIds.has(branch.id) ? 'selected' : ''}`}
            onClick={() => selectMode ? toggleSelect(branch.id) : setActiveConversation(branch.id)}
            title={branch.title}
          >
            {selectMode && (
              <span className={`branch-checkbox ${selectedIds.has(branch.id) ? 'checked' : ''}`}>
                {selectedIds.has(branch.id) && (
                  <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                )}
              </span>
            )}
            <span className="branch-chip-label">
              {branch.title.replace(/^Branch:\s*/, '').slice(0, 20)}
              {branch.title.replace(/^Branch:\s*/, '').length > 20 ? '...' : ''}
            </span>
            <span className="branch-chip-count">{branch.messageCount}</span>
          </button>
        ))}

        {isLoading && (
          <span className="branch-loading">Loading...</span>
        )}
      </div>

      {/* Select/Delete controls on the right */}
      <div className="branch-row-actions">
        {selectMode ? (
          <>
            {selectedIds.size > 0 && (
              <button
                className="branch-action-btn delete"
                onClick={handleDeleteSelected}
                title={`Delete ${selectedIds.size} branch${selectedIds.size > 1 ? 'es' : ''}`}
              >
                <TrashIcon />
                <span>{selectedIds.size}</span>
              </button>
            )}
            <button
              className="branch-action-btn cancel"
              onClick={cancelSelectMode}
              title="Cancel selection"
            >
              Cancel
            </button>
          </>
        ) : (
          branches.length > 0 && (
            <button
              className="branch-action-btn select"
              onClick={() => setSelectMode(true)}
              title="Select branches to delete"
            >
              Select
            </button>
          )
        )}
      </div>
    </div>
  );
}
