import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import * as api from '../api.js';
import { usePolling } from '../hooks/usePolling.js';
import StatusBadge from '../components/StatusBadge.jsx';
import { formatDateTime } from '../format.js';

const ACTIVE_RUN_STATUSES = ['pending', 'running', 'waiting_approval'];

// Screen 3: everything about one run - its full chronological audit trail,
// the plain-English "why this path" explanation, and the actions available
// on it right now (approve/reject a paused step, cancel, recover a failed
// run). Polls while the run is still active so the audit trail and step
// statuses catch up automatically once someone acts on it elsewhere.
export default function RunDetailPage() {
  const { runId } = useParams();
  const [actionError, setActionError] = useState(null);
  const [actionBusy, setActionBusy] = useState(false);

  const runPoll = usePolling(() => api.getRun(runId), { intervalMs: 3000 }, [runId]);
  const run = runPoll.data;
  const runActive = run && ACTIVE_RUN_STATUSES.includes(run.status);

  // Re-enabling polling here (rather than a one-shot fetch) means the audit
  // trail and explanation refresh right alongside the run itself.
  const auditPoll = usePolling(() => api.getRunAudit(runId), { intervalMs: 3000, enabled: Boolean(runActive) }, [runId]);
  const explanationPoll = usePolling(() => api.getRunExplanation(runId), { intervalMs: 3000, enabled: Boolean(runActive) }, [runId]);

  async function runAction(fn) {
    setActionBusy(true);
    setActionError(null);
    try {
      await fn();
      await runPoll.refetch();
      await auditPoll.refetch();
      await explanationPoll.refetch();
    } catch (err) {
      setActionError(err.message);
    } finally {
      setActionBusy(false);
    }
  }

  if (runPoll.error) return <div className="page error-banner">{runPoll.error.message}</div>;
  if (!run) return <div className="page empty-state">Loading...</div>;

  const pausedStep = run.steps.find((s) => s.status === 'paused');
  const failedStep = run.steps.find((s) => s.status === 'failed');

  return (
    <div className="page">
      <div className="breadcrumb">
        <Link to="/">Workflows</Link> / <Link to={`/workflows/${run.workflow_id}`}>workflow</Link> / run {run.id.slice(0, 8)}
      </div>

      <div className="card-header">
        <h1>
          Run <span className="mono">{run.id}</span>
        </h1>
        <StatusBadge status={run.status} />
      </div>

      <div className="card">
        <h2>Summary</h2>
        <table>
          <tbody>
            <tr>
              <td className="muted">Input</td>
              <td className="mono small">{JSON.stringify(run.input_data)}</td>
            </tr>
            <tr>
              <td className="muted">Started</td>
              <td>{formatDateTime(run.started_at || run.created_at)}</td>
            </tr>
            <tr>
              <td className="muted">Completed</td>
              <td>{formatDateTime(run.completed_at)}</td>
            </tr>
            {run.error && (
              <tr>
                <td className="muted">Error</td>
                <td className="diff-removed">{run.error}</td>
              </tr>
            )}
            {run.final_output && (
              <tr>
                <td className="muted">Final output</td>
                <td className="mono small">{JSON.stringify(run.final_output)}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>Actions</h2>
        {actionError && <div className="error-banner">{actionError}</div>}
        <div className="button-row">
          {run.status === 'waiting_approval' && pausedStep && (
            <>
              <button
                className="primary"
                disabled={actionBusy}
                onClick={() =>
                  runAction(async () => {
                    await api.approveStep(run.id, pausedStep.step_id, { approved_by: 'ui-user' });
                    await api.executeRun(run.id);
                  })
                }
              >
                Approve "{pausedStep.step_id}"
              </button>
              <button
                className="danger"
                disabled={actionBusy}
                onClick={() =>
                  runAction(async () => {
                    await api.rejectStep(run.id, pausedStep.step_id, { rejected_by: 'ui-user' });
                    await api.executeRun(run.id);
                  })
                }
              >
                Reject "{pausedStep.step_id}"
              </button>
            </>
          )}
          {ACTIVE_RUN_STATUSES.includes(run.status) && (
            <button className="danger" disabled={actionBusy} onClick={() => runAction(() => api.cancelRun(run.id, { cancelled_by: 'ui-user' }))}>
              Cancel run
            </button>
          )}
          {run.status === 'cancelled' && (
            <button
              disabled={actionBusy}
              onClick={() =>
                runAction(async () => {
                  await api.resumeRun(run.id, { resumed_by: 'ui-user' });
                  await api.executeRun(run.id);
                })
              }
            >
              Resume run
            </button>
          )}
          {run.status === 'failed' && (
            <button
              className="primary"
              disabled={actionBusy}
              onClick={() => runAction(() => api.recoverRun(run.id, { recovered_by: 'ui-user' }))}
            >
              Recover failed run{failedStep ? ` ("${failedStep.step_id}")` : ''}
            </button>
          )}
          {run.status === 'running' && (
            <button disabled={actionBusy} onClick={() => runAction(() => api.executeRun(run.id))}>
              Advance now
            </button>
          )}
          {!ACTIVE_RUN_STATUSES.includes(run.status) && run.status !== 'failed' && run.status !== 'cancelled' && (
            <span className="muted small">This run has reached a terminal state - no further actions available.</span>
          )}
        </div>
      </div>

      <div className="card">
        <h2>Steps</h2>
        <table>
          <thead>
            <tr>
              <th>Step</th>
              <th>Type</th>
              <th>Status</th>
              <th>Retries</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>
            {run.steps.map((s) => (
              <tr key={s.id}>
                <td>{s.step_id}</td>
                <td className="muted small">{s.step_type}</td>
                <td>
                  <StatusBadge status={s.status} />
                </td>
                <td className="muted small">{s.retry_count || '-'}</td>
                <td className="diff-removed small">{s.error || ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>Why this path (plain-English explanation)</h2>
        {explanationPoll.data ? (
          <div>
            {explanationPoll.data.narrative.map((line, i) => (
              <div key={i} className="narrative-line">
                {line}
              </div>
            ))}
          </div>
        ) : (
          <p className="muted">Loading...</p>
        )}
      </div>

      <div className="card">
        <h2>Full audit trail</h2>
        {auditPoll.data ? (
          auditPoll.data.length === 0 ? (
            <p className="empty-state">No events yet.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Step</th>
                  <th>Event</th>
                  <th>Status</th>
                  <th>Payload</th>
                </tr>
              </thead>
              <tbody>
                {auditPoll.data.map((event) => (
                  <tr key={event.id}>
                    <td className="muted small">{formatDateTime(event.created_at)}</td>
                    <td className="mono small">{event.step_id || '-'}</td>
                    <td className="small">{event.event_type}</td>
                    <td className="small">{event.status}</td>
                    <td className="mono small">{event.payload ? JSON.stringify(event.payload) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : (
          <p className="muted">Loading...</p>
        )}
      </div>
    </div>
  );
}
