export function Feedback({ error, success, warning }) {
  const message = error || warning || success;
  if (!message) return null;
  const kind = error ? 'is-error' : warning ? 'is-warning' : 'is-success';
  return <div className={`feedback ${kind}`} role={error ? 'alert' : 'status'}>{message}</div>;
}

export function EmptyState({ title, description }) {
  return <div className="empty-state"><div className="empty-icon">◇</div><strong>{title}</strong><span>{description}</span></div>;
}
