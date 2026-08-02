import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as api from '../api.js';
import { formatDateTime } from '../format.js';

// Screen 1 (part one): every workflow, with a way to create a new (empty)
// one. Clicking a row goes to WorkflowDetailPage, which is where version
// history + diffing (the rest of screen 1) and the step graph (screen 2)
// live.
export default function WorkflowListPage() {
  const navigate = useNavigate();
  const [workflows, setWorkflows] = useState(null);
  const [error, setError] = useState(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);

  function load() {
    api.listWorkflows().then(setWorkflows).catch((err) => setError(err.message));
  }

  useEffect(load, []);

  async function handleCreate(e) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const workflow = await api.createWorkflow({ name, description });
      navigate(`/workflows/${workflow.id}`);
    } catch (err) {
      setError(err.message);
      setCreating(false);
    }
  }

  return (
    <div className="page">
      <div className="card-header">
        <h1>Workflows</h1>
        <button className="primary" onClick={() => setShowCreateForm((v) => !v)}>
          {showCreateForm ? 'Cancel' : 'New workflow'}
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {showCreateForm && (
        <form className="card" onSubmit={handleCreate}>
          <div className="field">
            <label>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
          </div>
          <div className="field">
            <label>Description (optional)</label>
            <input value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <p className="muted small">
            This creates the workflow's identity only. You'll publish its first version (paste a definition JSON) from the
            workflow's page next.
          </p>
          <button className="primary" type="submit" disabled={creating}>
            Create
          </button>
        </form>
      )}

      <div className="card" style={{ padding: 0 }}>
        {workflows === null ? (
          <p className="empty-state">Loading...</p>
        ) : workflows.length === 0 ? (
          <p className="empty-state">No workflows yet. Create one above, or run `npm run seed` in the backend for demo data.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Description</th>
                <th>Current version</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {workflows.map((w) => (
                <tr key={w.id} className="clickable-row" onClick={() => navigate(`/workflows/${w.id}`)}>
                  <td>{w.name}</td>
                  <td className="muted">{w.description || '-'}</td>
                  <td>{w.current_version_id ? 'published' : <span className="muted">none</span>}</td>
                  <td className="muted small">{formatDateTime(w.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
