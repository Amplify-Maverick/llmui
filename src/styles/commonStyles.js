export const colors = {
  primary: "#6ee7b7",
  secondary: "#60a5fa",
  warning: "#fcd34d",
  danger: "#ff6b6b",
  purple: "#c4b5fd",
  textPrimary: "#e8e8f0",
  textSecondary: "#8a8a9a",
  background: "linear-gradient(145deg, #0f0f1a 0%, #1a1a2e 50%, #16213e 100%)",
};

export const cardStyle = {
  background: "rgba(255,255,255,0.03)",
  backdropFilter: "blur(10px)",
  borderRadius: "12px",
  border: "1px solid rgba(255,255,255,0.06)",
  padding: "20px",
};

export const inputStyle = {
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: "8px",
  padding: "10px 12px",
  color: "#e8e8f0",
  fontSize: "14px",
  fontFamily: "'DM Mono', monospace",
  outline: "none",
  width: "100%",
  transition: "border-color 0.2s ease",
};

export const inputFocusStyle = {
  borderColor: "rgba(110, 231, 183, 0.5)",
};

export const buttonStyle = {
  background: "rgba(110, 231, 183, 0.15)",
  border: "1px solid rgba(110, 231, 183, 0.3)",
  borderRadius: "8px",
  padding: "10px 20px",
  color: "#6ee7b7",
  fontSize: "14px",
  fontFamily: "'DM Sans', sans-serif",
  fontWeight: "500",
  cursor: "pointer",
  transition: "all 0.2s ease",
};

export const buttonHoverStyle = {
  background: "rgba(110, 231, 183, 0.25)",
  borderColor: "rgba(110, 231, 183, 0.5)",
};

export const userBubbleStyle = {
  background: "rgba(110, 231, 183, 0.15)",
  border: "1px solid rgba(110, 231, 183, 0.3)",
  borderRadius: "16px 16px 4px 16px",
  padding: "12px 16px",
  maxWidth: "70%",
  alignSelf: "flex-end",
};

export const assistantBubbleStyle = {
  background: "rgba(255,255,255,0.03)",
  border: "1px solid rgba(255,255,255,0.06)",
  borderRadius: "16px 16px 16px 4px",
  padding: "12px 16px",
  maxWidth: "70%",
  alignSelf: "flex-start",
  backdropFilter: "blur(10px)",
};

export const tabStyle = {
  padding: "10px 20px",
  border: "none",
  background: "transparent",
  color: "#8a8a9a",
  fontSize: "14px",
  fontFamily: "'DM Sans', sans-serif",
  fontWeight: "500",
  cursor: "pointer",
  transition: "all 0.2s ease",
  borderBottom: "2px solid transparent",
};

export const activeTabStyle = (color) => ({
  ...tabStyle,
  color: color,
  borderBottomColor: color,
});
