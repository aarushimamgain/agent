// One place mapping a status string (run status OR run_steps status - they
// share most of their vocabulary, see migrations/schema.sql) to a color, so
// every screen that shows a status (workflow detail's step graph, run
// detail, run history) looks consistent.
const COLORS = {
  pending: 'var(--color-pending)',
  running: 'var(--color-running)',
  succeeded: 'var(--color-succeeded)',
  completed: 'var(--color-succeeded)',
  failed: 'var(--color-failed)',
  paused: 'var(--color-paused)',
  waiting_approval: 'var(--color-paused)',
  skipped: 'var(--color-skipped)',
  cancelled: 'var(--color-skipped)',
};

export default function StatusBadge({ status }) {
  const color = COLORS[status] || 'var(--color-text-muted)';
  return (
    <span className="status-badge" style={{ background: color }}>
      <span className="status-dot" />
      {status}
    </span>
  );
}
