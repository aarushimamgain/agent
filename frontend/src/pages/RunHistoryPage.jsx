import { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import * as api from '../api.js';
import StatusBadge from '../components/StatusBadge.jsx';
import { formatDateTime } from '../format.js';

// Screen 4: every run across every workflow, plus "rerun with new input" -
// pick any past run, pick which version of ITS workflow to run against,
// supply fresh sample input, and start a new run from it.
export default function RunHistoryPage() {
  const navigate = useNavigate();
  const [runs, setRuns] = useState(null);
  const [error, setError] = useState(null);
  const [rerunTarget, setRerunTarget] = useState(null); // the run row being reran

  useEffect(() => {
    api.listAllRuns().then(setRuns).catch((err) => setError(err.message));
  }, []);

  return (
    <div className="page">
      <h1>Run history</h1>
      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ padding: 0 }}>
        {runs === null ? (
          <p className="empty-state">Loading...</p>
        ) : runs.length === 0 ? (
          <p className="empty-state">No runs yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Run</th>
                <th>Workflow</th>
                <th>Version</th>
                <th>Status</th>
                <th>Started</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="clickable-row" onClick={() => navigate(`/runs/${r.id}`)}>
                  <td className="mono">{r.id.slice(0, 8)}</td>
                  <td>
                    <Link to={`/workflows/${r.workflow_id}`} onClick={(e) => e.stopPropagation()}>
                      {r.workflow_name}
                    </Link>
                  </td>
                  <td className="muted">v{r.workflow_version_number}</td>
                  <td>
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="muted small">{formatDateTime(r.created_at)}</td>
                  <td>
                    <button
                      className="small"
                      onClick={(e) => {
                        e.stopPropagation();
                        setRerunTarget(r);
                      }}
                    >
                      Rerun with new input
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {rerunTarget && (
        <RerunForm run={rerunTarget} onClose={() => setRerunTarget(null)} onStarted={(newRunId) => navigate(`/runs/${newRunId}`)} />
      )}
    </div>
  );
}

function RerunForm({ run, onClose, onStarted }) {
  const [versions, setVersions] = useState(null);
  const [versionNumber, setVersionNumber] = useState(run.workflow_version_number);
  const [versionDetail, setVersionDetail] = useState(null);
  const [fieldValues, setFieldValues] = useState({});
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.listVersions(run.workflow_id).then(setVersions);
  }, [run.workflow_id]);

  useEffect(() => {
    if (versionNumber == null) return;
    api.getVersion(run.workflow_id, versionNumber).then((v) => {
      setVersionDetail(v);
      const entryStep = v.definition.steps.find((s) => s.type === 'structured_input');
      const initial = {};
      for (const field of entryStep?.config.fields || []) {
        // Pre-fill with the original run's input as a starting point, since
        // this is explicitly "rerun with NEW input", not "rerun blank".
        initial[field.name] = run.input_data?.[field.name] ?? '';
      }
      setFieldValues(initial);
    });
  }, [run.workflow_id, versionNumber]);

  const entryStep = versionDetail?.definition.steps.find((s) => s.type === 'structured_input');

  async function handleSubmit(e) {
    e.preventDefault();
    setStarting(true);
    setError(null);
    try {
      const newRun = await api.startRun(run.workflow_id, {
        input_data: fieldValues,
        created_by: 'ui-user',
        version_number: versionNumber,
      });
      await api.executeRun(newRun.id).catch(() => {});
      onStarted(newRun.id);
    } catch (err) {
      setError(err.message);
      setStarting(false);
    }
  }

  return (
    <form className="card" onSubmit={handleSubmit}>
      <div className="card-header">
        <h2>
          Rerun {run.workflow_name} (originally run {run.id.slice(0, 8)})
        </h2>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
      {error && <div className="error-banner">{error}</div>}
      <div className="field">
        <label>Workflow version</label>
        <select value={versionNumber} onChange={(e) => setVersionNumber(Number(e.target.value))} disabled={!versions}>
          {versions?.map((v) => (
            <option key={v.id} value={v.version_number}>
              v{v.version_number}
            </option>
          ))}
        </select>
      </div>
      {entryStep && entryStep.config.fields.length > 0 ? (
        entryStep.config.fields.map((field) => (
          <div className="field" key={field.name}>
            <label>
              {field.name} <span className="muted">({field.type})</span>
            </label>
            <input
              value={fieldValues[field.name] ?? ''}
              onChange={(e) => setFieldValues({ ...fieldValues, [field.name]: e.target.value })}
              required
            />
          </div>
        ))
      ) : (
        <p className="muted small">This version's entry step takes no input fields.</p>
      )}
      <button className="primary" type="submit" disabled={starting}>
        {starting ? 'Starting...' : 'Start new run'}
      </button>
    </form>
  );
}
