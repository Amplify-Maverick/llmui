const containerStyle = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
  padding: "12px 16px",
  color: "#8a8a9a",
  fontSize: "13px",
};

const dotsContainerStyle = {
  display: "flex",
  gap: "4px",
};

const dotStyle = {
  width: "6px",
  height: "6px",
  borderRadius: "50%",
  background: "#6ee7b7",
};

export default function StreamingIndicator() {
  return (
    <div style={containerStyle}>
      <div style={dotsContainerStyle}>
        <span
          style={{
            ...dotStyle,
            animation: "pulse 1.4s infinite ease-in-out",
            animationDelay: "0s",
          }}
        />
        <span
          style={{
            ...dotStyle,
            animation: "pulse 1.4s infinite ease-in-out",
            animationDelay: "0.2s",
          }}
        />
        <span
          style={{
            ...dotStyle,
            animation: "pulse 1.4s infinite ease-in-out",
            animationDelay: "0.4s",
          }}
        />
      </div>
      <span>Thinking...</span>
      <style>
        {`
          @keyframes pulse {
            0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
            40% { opacity: 1; transform: scale(1); }
          }
          @keyframes blink {
            0%, 50% { opacity: 1; }
            51%, 100% { opacity: 0; }
          }
        `}
      </style>
    </div>
  );
}
