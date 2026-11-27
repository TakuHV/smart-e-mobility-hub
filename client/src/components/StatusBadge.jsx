const palette = {
  Available: 'green', Confirmed: 'blue', 'In Progress': 'blue', Charging: 'blue', Assigned: 'blue',
  Queued: 'amber', Reserved: 'amber', 'Needs Charging': 'amber', 'Awaiting Removal': 'amber',
  Completed: 'green', Done: 'green', Applied: 'green', 'Sent for Execution': 'blue', Proposed: 'violet',
  Declined: 'red', Expired: 'red', Cancelled: 'muted', 'Out of Service': 'red', Stale: 'red', Fresh: 'green',
  Requested: 'amber', Open: 'red', Parked: 'green', Overdue: 'red', Occupied: 'muted', 'In Use': 'blue',
  Normal: 'green', Warning: 'amber', Critical: 'red', Pending: 'amber', Simulated: 'violet',
  'In Transfer': 'violet', Retired: 'muted', Resolved: 'green', High: 'red', Medium: 'amber', Low: 'muted', 'Open now': 'green', Closed: 'red', 'Class H': 'red', 'Class L': 'muted'
};

export default function StatusBadge({ value }) {
  return <span className={`badge ${palette[value] || 'muted'}`}>{value || '—'}</span>;
}
