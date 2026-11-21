export default function StatCard({ label, value, detail, icon = '◈' }) {
  return <div className="stat-card">
    <div className="stat-icon">{icon}</div>
    <div className="stat-label">{label}</div>
    <div className="stat-value">{value ?? '—'}</div>
    {detail && <div className="stat-detail">{detail}</div>}
  </div>;
}
