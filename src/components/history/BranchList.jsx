import { useState } from 'react';
import './BranchList.css';

const ChevronIcon = ({ rotated }) => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ transform: rotated ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}
  >
    <polyline points="9 18 15 12 9 6" />
  </svg>
);

const BranchIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="6" y1="3" x2="6" y2="15"/>
    <circle cx="18" cy="6" r="3"/>
    <circle cx="6" cy="18" r="3"/>
    <path d="M18 9a9 9 0 0 1-9 9"/>
  </svg>
);

export default function BranchList({
  branches,
  activeId,
  onSelect,
  onDelete,
  onRename,
  onExport,
}) {
  const [expanded, setExpanded] = useState(false);

  if (!branches || branches.length === 0) {
    return null;
  }

  return (
    <div className="branch-list">
      <button className="branch-toggle" onClick={() => setExpanded(!expanded)}>
        <ChevronIcon rotated={expanded} />
        <BranchIcon />
        <span>{branches.length} branch{branches.length > 1 ? 'es' : ''}</span>
      </button>
      {expanded && (
        <div className="branch-items">
          {branches.map((branch) => (
            <div
              key={branch.id}
              className={`branch-item ${branch.id === activeId ? 'active' : ''}`}
              onClick={() => onSelect(branch.id)}
            >
              <span className="branch-indent" />
              <span className="branch-title" title={branch.title}>
                {branch.title}
              </span>
              <span className="branch-meta">
                {branch.messageCount} msg{branch.messageCount !== 1 ? 's' : ''}
              </span>
              <div className="branch-actions">
                <button
                  className="branch-action-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRename?.(branch.id);
                  }}
                  title="Rename"
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                  </svg>
                </button>
                <button
                  className="branch-action-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    onExport?.(branch.id);
                  }}
                  title="Export"
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                    <polyline points="7 10 12 15 17 10"/>
                    <line x1="12" y1="15" x2="12" y2="3"/>
                  </svg>
                </button>
                <button
                  className="branch-action-btn danger"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete?.(branch.id);
                  }}
                  title="Delete"
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="3 6 5 6 21 6"/>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                  </svg>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
