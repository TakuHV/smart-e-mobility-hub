import { useEffect, useState } from 'react';

// A message the user can dismiss with a tap. Success messages disappear by themselves after a few seconds;
// errors and warnings stay until dismissed or replaced. On a phone the message stays visible at the top while scrolling.
export function Feedback({ error, success, warning }) {
  const message = error || warning || success;
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    setHidden(false);
    if (!message || error || warning) return undefined;
    const timer = setTimeout(() => setHidden(true), 7000);
    return () => clearTimeout(timer);
  }, [message, error, warning]);
  if (!message || hidden) return null;
  const kind = error ? 'is-error' : warning ? 'is-warning' : 'is-success';
  return <div className={`feedback ${kind}`} role={error ? 'alert' : 'status'} onClick={() => setHidden(true)} title="Tap to dismiss">
    <span>{message}</span><span className="feedback-close" aria-hidden="true">✕</span>
  </div>;
}

export function EmptyState({ title, description }) {
  return <div className="empty-state"><div className="empty-icon">◇</div><strong>{title}</strong><span>{description}</span></div>;
}
