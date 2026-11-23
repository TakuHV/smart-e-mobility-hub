// On a phone only the icon is shown (the button sits at the top right of the page header).
export default function RefreshButton({ onClick, label = 'Refresh' }) {
  return <button className="button secondary refresh-button" onClick={onClick} aria-label={label} title={label}>
    <span aria-hidden="true">↻</span><span className="btn-label">{label}</span>
  </button>;
}
