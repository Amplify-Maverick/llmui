import "./StatCard.css";

export default function StatCard({ label, value, color = "#6ee7b7", icon }) {
  return (
    <div className="stat-card">
      <div className="stat-card-label">{label}</div>
      <div className="stat-card-value" style={{ color }}>
        {icon && <span style={{ marginRight: "8px" }}>{icon}</span>}
        {value}
      </div>
    </div>
  );
}
