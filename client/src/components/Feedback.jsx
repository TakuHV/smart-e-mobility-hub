export function Feedback({ error, success }) {
  if (!error && !success) return null;
  return <div className={`feedback ${error ? 'is-error' : 'is-success'}`}>{error || success}</div>;
}

export function EmptyState({ title, description }) {
  return <div className="empty-state"><div className="empty-icon">◇</div><strong>{title}</strong><span>{description}</span></div>;
}
