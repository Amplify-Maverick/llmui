const cardStyle = {
  background: "rgba(255,255,255,0.03)",
  border: "1px solid rgba(255,255,255,0.06)",
  borderRadius: "12px",
  padding: "20px",
};

const labelStyle = {
  fontSize: "13px",
  color: "#8a8a9a",
  marginBottom: "8px",
  textTransform: "uppercase",
  letterSpacing: "0.5px",
};

const valueStyle = {
  fontSize: "28px",
  fontWeight: "700",
  fontFamily: "'DM Mono', monospace",
};

export default function StatCard({ label, value, color = "#6ee7b7", icon }) {
  return (
    <div style={cardStyle}>
      <div style={labelStyle}>{label}</div>
      <div style={{ ...valueStyle, color }}>
        {icon && <span style={{ marginRight: "8px" }}>{icon}</span>}
        {value}
      </div>
    </div>
  );
}
