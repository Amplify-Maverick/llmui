/**
 * The model's Think text, collapsed under the reply's header. Open by default
 * while it's still being written, closed for stored messages.
 */
export default function ThinkingBlock({ text, live = false }) {
  if (!text) return null;
  return (
    <details className="bubble-thinking" open={live || undefined}>
      <summary>{live ? "Thinking…" : "Thinking"}</summary>
      <div className="bubble-thinking-text">{text}</div>
    </details>
  );
}
