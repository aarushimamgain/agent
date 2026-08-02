import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import * as api from '../api.js';
import { usePolling } from '../hooks/usePolling.js';
import StepGraph from '../components/StepGraph.jsx';
import DiffView from '../components/DiffView.jsx';
import StatusBadge from '../components/StatusBadge.jsx';
import { formatDateTime } from '../format.js';

const ACTIVE_RUN_STATUSES = ['pending', 'running', 'waiting_approval'];

export default function WorkflowDetailPage() {
  const { workflowId } = useParams();
  const navigate = useNavigate();
  const [tab, setTab] = useState('graph');
  const [workflow, setWorkflow] = useState(null);
  const [versions, setVersions] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.getWorkflow(workflowId).then(setWorkflow).catch((err) => setError(err.message));
    api.listVersions(workflowId).then(setVersions).catch((err) => setError(err.message));
  }, [workflowId]);

  function reloadVersions() {
    api.listVersions(workflowId).then(setVersions);
    api.getWorkflow(workflowId).then(setWorkflow);
  }

  if (error) {
    return (
      <div className="page">
        <div className="error-banner">{error}</div>
      </div>
    );
  }
  if (!workflow || !versions) {
    return (
      <div className="page">
        <p className="empty-state">Loading...</p>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="breadcrumb">
        <Link to="/">Workflows</Link> / {workflow.name}
      </div>
      <h1>{workflow.name}</h1>
      {workflow.description && <p className="muted">{workflow.description}</p>}

      <div className="tabs">
        <button className={tab === 'graph' ? 'active' : ''} onClick={() => setTab('graph')}>
          Graph &amp; Runs
        </button>
        <button className={tab === 'versions' ? 'active' : ''} onClick={() => setTab('versions')}>
          Versions &amp; Diff
        </button>
      </div>

      {tab === 'graph' && <GraphAndRunsTab workflow={workflow} versions={versions} navigate={navigate} />}
      {tab === 'versions' && (
        <VersionsTab workflowId={workflowId} workflow={workflow} versions={versions} onChanged={reloadVersions} />
      )}
    </div>
  );
}

// --------------------------------------------------------------------
// Graph & Runs tab (requirement 2): visual step graph for a chosen
// version, live per-step execution state for whichever run is selected
// (defaulting to the most recent one), and a form to start a new run.
// --------------------------------------------------------------------
function GraphAndRunsTab({ workflow, versions, navigate }) {
  const currentVersionNumber = versions.find((v) => v.id === workflow.current_version_id)?.version_number ?? versions[0]?.version_number;
  const [graphVersionNumber, setGraphVersionNumber] = useState(currentVersionNumber);
  const [versionDetail, setVersionDetail] = useState(null);
  const [recentRuns, setRecentRuns] = useState(null);
  const [liveRunId, setLiveRunId] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (graphVersionNumber == null) return;
    api.getVersion(workflow.id, graphVersionNumber).then(setVersionDetail).catch((err) => setError(err.message));
  }, [workflow.id, graphVersionNumber]);

  function loadRuns() {
    api
      .listRunsForWorkflow(workflow.id)
      .then((runs) => {
        setRecentRuns(runs);
        if (liveRunId === null && runs.length > 0) setLiveRunId(runs[0].id);
      })
      .catch((err) => setError(err.message));
  }
  useEffect(loadRuns, [workflow.id]);

  const liveRunPoll = usePolling(
    () => (liveRunId ? api.getRun(liveRunId) : Promise.resolve(null)),
    { intervalMs: 3000, enabled: Boolean(liveRunId) },
    [liveRunId]
  );
  const liveRun = liveRunPoll.data;
  // Stop polling once the run reaches a terminal state - no point hammering
  // the backend for a run that will never change again.
  const liveRunActive = liveRun && ACTIVE_RUN_STATUSES.includes(liveRun.status);

  const liveStatusByStepId = useMemo(() => {
    if (!liveRun) return null;
    return new Map(liveRun.steps.map((s) => [s.step_id, s]));
  }, [liveRun]);

  if (error) return <div className="error-banner">{error}</div>;
  if (!versionDetail || recentRuns === null) return <p className="empty-state">Loading...</p>;

  return (
    <div>
      <div className="card">
        <div className="card-header">
          <h2>Step graph</h2>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            {versions.length > 1 && (
              <select value={graphVersionNumber} onChange={(e) => setGraphVersionNumber(Number(e.target.value))}>
                {versions.map((v) => (
                  <option key={v.id} value={v.version_number}>
                    v{v.version_number}
                    {v.id === workflow.current_version_id ? ' (current)' : ''}
                  </option>
                ))}
              </select>
            )}
            {recentRuns.length > 0 && (
              <select value={liveRunId || ''} onChange={(e) => setLiveRunId(e.target.value)}>
                <option value="">no live overlay</option>
                {recentRuns.map((r) => (
                  <option key={r.id} value={r.id}>
                    live state: run {r.id.slice(0, 8)} ({r.status})
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
        {liveRun && (
          <p className="muted small">
            {liveRunActive ? 'Polling every 3s while this run is active.' : 'This run has finished; no longer polling.'} Showing
            live state for run{' '}
            <Link to={`/workflows/${workflow.id}/runs/${liveRun.id}`}>{liveRun.id.slice(0, 8)}</Link>.
          </p>
        )}
        <StepGraph definition={versionDetail.definition} liveStatusByStepId={liveStatusByStepId} />
      </div>

      <StartRunForm workflow={workflow} versions={versions} defaultVersionNumber={graphVersionNumber} navigate={navigate} />

      <div className="card">
        <h2>Recent runs</h2>
        {recentRuns.length === 0 ? (
          <p className="empty-state">No runs yet - start one above.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Run</th>
                <th>Status</th>
                <th>Input</th>
                <th>Started</th>
              </tr>
            </thead>
            <tbody>
              {recentRuns.map((r) => (
                <tr key={r.id} className="clickable-row" onClick={() => navigate(`/workflows/${workflow.id}/runs/${r.id}`)}>
                  <td className="mono">{r.id.slice(0, 8)}</td>
                  <td>
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="mono small">{JSON.stringify(r.input_data)}</td>
                  <td className="muted small">{formatDateTime(r.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function StartRunForm({ workflow, versions, defaultVersionNumber, navigate }) {
  const [versionNumber, setVersionNumber] = useState(defaultVersionNumber);
  const [versionDetail, setVersionDetail] = useState(null);
  const [fieldValues, setFieldValues] = useState({});
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => setVersionNumber(defaultVersionNumber), [defaultVersionNumber]);

  useEffect(() => {
    if (versionNumber == null) return;
    api.getVersion(workflow.id, versionNumber).then((v) => {
      setVersionDetail(v);
      const entryStep = v.definition.steps.find((s) => s.type === 'structured_input');
      const initial = {};
      for (const field of entryStep?.config.fields || []) initial[field.name] = '';
      setFieldValues(initial);
    });
  }, [workflow.id, versionNumber]);

  const entryStep = versionDetail?.definition.steps.find((s) => s.type === 'structured_input');

  async function handleSubmit(e) {
    e.preventDefault();
    setStarting(true);
    setError(null);
    try {
      const run = await api.startRun(workflow.id, {
        input_data: fieldValues,
        created_by: 'ui-user',
        version_number: versionNumber,
      });
      await api.executeRun(run.id).catch(() => {}); // kick off processing; the run detail page takes it from here
      navigate(`/workflows/${workflow.id}/runs/${run.id}`);
    } catch (err) {
      setError(err.message);
      setStarting(false);
    }
  }

  return (
    <form className="card" onSubmit={handleSubmit}>
      <h2>Start a new run</h2>
      {error && <div className="error-banner">{error}</div>}
      <div className="field">
        <label>Workflow version</label>
        <select value={versionNumber ?? ''} onChange={(e) => setVersionNumber(Number(e.target.value))}>
          {versions.map((v) => (
            <option key={v.id} value={v.version_number}>
              v{v.version_number}
              {v.id === workflow.current_version_id ? ' (current)' : ''}
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
        {starting ? 'Starting...' : 'Start run'}
      </button>
    </form>
  );
}

// --------------------------------------------------------------------
// Versions & Diff tab (requirement 1): version history plus a picker to
// diff any two versions, and a form to publish a new one.
// --------------------------------------------------------------------
function VersionsTab({ workflowId, workflow, versions, onChanged }) {
  const [fromVersion, setFromVersion] = useState(versions[1]?.version_number ?? versions[0]?.version_number);
  const [toVersion, setToVersion] = useState(versions[0]?.version_number);
  const [diff, setDiff] = useState(null);
  const [error, setError] = useState(null);
  const [showPublishForm, setShowPublishForm] = useState(versions.length === 0);

  async function handleCompare() {
    setError(null);
    setDiff(null);
    try {
      const result = await api.diffVersions(workflowId, fromVersion, toVersion);
      setDiff(result);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div>
      <div className="card">
        <div className="card-header">
          <h2>Version history</h2>
          <button onClick={() => setShowPublishForm((v) => !v)}>{showPublishForm ? 'Cancel' : 'Publish new version'}</button>
        </div>
        {versions.length === 0 ? (
          <p className="empty-state">No versions published yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Version</th>
                <th>Created by</th>
                <th>Created</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {versions.map((v) => (
                <tr key={v.id}>
                  <td>v{v.version_number}</td>
                  <td className="muted">{v.created_by || '-'}</td>
                  <td className="muted small">{formatDateTime(v.created_at)}</td>
                  <td>{v.id === workflow.current_version_id ? <span className="status-badge" style={{ background: 'var(--color-succeeded)' }}>current</span> : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showPublishForm && (
        <PublishVersionForm
          workflowId={workflowId}
          latestDefinition={null}
          onPublished={() => {
            setShowPublishForm(false);
            onChanged();
          }}
        />
      )}

      {versions.length >= 2 && (
        <div className="card">
          <h2>Compare versions</h2>
          <div className="button-row" style={{ marginBottom: 12, alignItems: 'center' }}>
            <select value={fromVersion} onChange={(e) => setFromVersion(Number(e.target.value))}>
              {versions.map((v) => (
                <option key={v.id} value={v.version_number}>
                  v{v.version_number}
                </option>
              ))}
            </select>
            <span className="muted">vs</span>
            <select value={toVersion} onChange={(e) => setToVersion(Number(e.target.value))}>
              {versions.map((v) => (
                <option key={v.id} value={v.version_number}>
                  v{v.version_number}
                </option>
              ))}
            </select>
            <button className="primary" onClick={handleCompare}>
              Compare
            </button>
          </div>
          {error && <div className="error-banner">{error}</div>}
          {diff && <DiffView diff={diff} />}
        </div>
      )}
    </div>
  );
}

function PublishVersionForm({ workflowId, onPublished }) {
  const [definitionText, setDefinitionText] = useState(
    JSON.stringify(
      { name: 'New workflow', steps: [{ id: 'intake', type: 'structured_input', inputs: {}, config: { fields: [] }, permissions: { tools: [] } }] },
      null,
      2
    )
  );
  const [publishAsCurrent, setPublishAsCurrent] = useState(true);
  const [validationErrors, setValidationErrors] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function handleValidate() {
    setError(null);
    try {
      const definition = JSON.parse(definitionText);
      const result = await api.validateDefinition(definition);
      setValidationErrors(result.valid ? [] : result.errors);
    } catch (err) {
      setError(err.message);
    }
  }

  async function handlePublish(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const definition = JSON.parse(definitionText);
      await api.publishVersion(workflowId, { definition, publish: publishAsCurrent, created_by: 'ui-user' });
      onPublished();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={handlePublish}>
      <h2>Publish a new version</h2>
      <p className="muted small">
        Paste a full workflow definition (see src/schema/workflowDefinition.schema.json in the backend for the shape).
      </p>
      <div className="field">
        <textarea rows={12} className="mono" value={definitionText} onChange={(e) => setDefinitionText(e.target.value)} />
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 }}>
        <input type="checkbox" style={{ width: 'auto' }} checked={publishAsCurrent} onChange={(e) => setPublishAsCurrent(e.target.checked)} />
        Set as the current version
      </label>
      {error && <div className="error-banner">{error}</div>}
      {validationErrors && (
        <div className={validationErrors.length ? 'error-banner' : 'card'} style={{ marginBottom: 12 }}>
          {validationErrors.length === 0 ? (
            'Definition is valid.'
          ) : (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {validationErrors.map((e, i) => (
                <li key={i}>
                  <span className="mono small">{e.path}</span>: {e.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="button-row">
        <button type="button" onClick={handleValidate}>
          Validate
        </button>
        <button className="primary" type="submit" disabled={busy}>
          {busy ? 'Publishing...' : 'Publish'}
        </button>
      </div>
    </form>
  );
}
