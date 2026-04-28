import "./StreamingIndicator.css";

export default function StreamingIndicator() {
  return (
    <div className="streaming-indicator">
      <div className="streaming-dots">
        <span className="streaming-dot" />
        <span className="streaming-dot" />
        <span className="streaming-dot" />
      </div>
      <span>Thinking...</span>
    </div>
  );
}
