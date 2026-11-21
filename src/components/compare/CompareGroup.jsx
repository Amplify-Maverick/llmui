import { memo } from "react";
import MessageBubble from "../chat/MessageBubble.jsx";
import MarkdownRenderer from "../chat/MarkdownRenderer.jsx";
import ToolCallCard from "../chat/ToolCallCard.jsx";
import ThinkingBlock from "../chat/ThinkingBlock.jsx";
import StreamingIndicator from "../chat/StreamingIndicator.jsx";
import { useMachinesStore } from "../../stores/machinesStore.js";
import "./CompareGroup.css";

/**
 * The two replies of one Compare, side by side. Each slot shows its stored
 * message, or `live[slot]` while that side is being generated (a new
 * Compare, or one side retried / continued).
 */
const CompareGroup = memo(function CompareGroup({
  messages = [],
  live = null,
  canAct = false,
  isTrailing = false,
  onPick,
  onContinue,
  onRetry,
  onDelete,
}) {
  const slots = [0, 1].map((slot) => ({
    slot,
    live: live?.[slot] || null,
    message: messages.find((m) => (m.compareSlot ?? messages.indexOf(m)) === slot) || null,
  }));
  const picked = messages.find((m) => m.picked);

  return (
    <div className="compare-group" role="group" aria-label="Compare">
      <div className="compare-group-label">
        Compare{picked ? " · picked" : ""}
      </div>
      <div className="compare-group-columns">
        {slots.map(({ slot, live: side, message }) => (
          <div key={slot} className={`compare-group-column ${message?.picked ? "picked" : ""}`}>
            {side && side.status === "running" ? (
              <LiveSide side={side} />
            ) : message ? (
              <>
                <MessageBubble
                  message={message}
                  isLastAssistant={false}
                  onDelete={canAct ? onDelete : undefined}
                  onContinue={canAct && isTrailing && message.status === "interrupted" && message.content ? onContinue : undefined}
                  onRetry={canAct && isTrailing && message.status === "interrupted" ? onRetry : undefined}
                />
                {canAct && (
                  <div className="compare-group-footer">
                    {message.status !== "interrupted" && isTrailing && onRetry && (
                      <button className="compare-group-btn" onClick={() => onRetry(message)} title="Run this side again">
                        Retry
                      </button>
                    )}
                    <button
                      className={`compare-group-btn pick ${message.picked ? "active" : ""}`}
                      onClick={() => onPick(message.id, !message.picked)}
                      aria-pressed={!!message.picked}
                      title={message.picked ? "Unpick (follow-ups then use the left reply)" : "Use this reply for follow-ups"}
                    >
                      {message.picked ? "✓ Picked" : "Pick this one"}
                    </button>
                  </div>
                )}
              </>
            ) : side ? (
              <EndedSide side={side} />
            ) : (
              <div className="compare-group-empty">No reply</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
});

function SideHeader({ side }) {
  const machineName = useMachinesStore((s) =>
    side.machine ? s.machines.find((m) => m.id === side.machine)?.name || side.machine : null
  );
  return (
    <div className="bubble-role bubble-role-assistant">
      Assistant
      {side.model && <span className="bubble-model">{side.model}</span>}
      {machineName && <span className="bubble-machine">{machineName}</span>}
    </div>
  );
}

function LiveSide({ side }) {
  const empty = !side.content && !side.thinking && side.toolCalls.length === 0;
  return (
    <div className="message-row">
      <div className="bubble bubble-assistant">
        <SideHeader side={side} />
        <ThinkingBlock text={side.thinking} live={!side.content} />
        {side.toolCalls.length > 0 && (
          <div className="tool-calls-container">
            {side.toolCalls.map((tc) => (
              <ToolCallCard key={tc.id} toolCall={tc} />
            ))}
          </div>
        )}
        {empty ? (
          <StreamingIndicator />
        ) : (
          <div className="bubble-content">
            <MarkdownRenderer content={side.content} />
            <span className="streaming-cursor" />
          </div>
        )}
      </div>
    </div>
  );
}

/** A side that ended without a stored reply (yet): its error, or "stopped". */
function EndedSide({ side }) {
  return (
    <div className="message-row">
      <div className="bubble bubble-assistant">
        <SideHeader side={side} />
        <div className="compare-group-empty">
          {side.status === "error" ? `Error: ${side.error || "failed"}` : side.status === "cancelled" ? "Stopped before any output." : "Saving…"}
        </div>
      </div>
    </div>
  );
}

export default CompareGroup;
