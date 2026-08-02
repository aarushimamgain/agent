// Renders the structured output of diffWorkflowVersions() (see
// src/validation/diffWorkflowVersions.js) - added/removed/modified steps
// plus workflow-level metadata changes - as a readable comparison instead
// of a raw JSON dump.
function ValueBlock({ value }) {
  return <pre className="json-block">{JSON.stringify(value, null, 2)}</pre>;
}

export default function DiffView({ diff }) {
  const hasChanges =
    diff.metadataChanges.length > 0 || diff.addedSteps.length > 0 || diff.removedSteps.length > 0 || diff.modifiedSteps.length > 0;

  if (!hasChanges) {
    return <p className="muted">These two versions are identical.</p>;
  }

  return (
    <div>
      {diff.metadataChanges.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <h3>Workflow metadata</h3>
          {diff.metadataChanges.map((c) => (
            <div key={c.field} className="small">
              <strong>{c.field}</strong>: <span className="diff-removed">{JSON.stringify(c.from)}</span>
              {' -> '}
              <span className="diff-added">{JSON.stringify(c.to)}</span>
            </div>
          ))}
        </div>
      )}

      {diff.addedSteps.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <h3 className="diff-added">+ Added steps ({diff.addedSteps.length})</h3>
          {diff.addedSteps.map((step) => (
            <div key={step.id} style={{ marginBottom: 8 }}>
              <div className="small">
                <strong>{step.id}</strong> <span className="muted">({step.type})</span>
              </div>
              <ValueBlock value={step} />
            </div>
          ))}
        </div>
      )}

      {diff.removedSteps.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <h3 className="diff-removed">- Removed steps ({diff.removedSteps.length})</h3>
          {diff.removedSteps.map((step) => (
            <div key={step.id} style={{ marginBottom: 8 }}>
              <div className="small">
                <strong>{step.id}</strong> <span className="muted">({step.type})</span>
              </div>
              <ValueBlock value={step} />
            </div>
          ))}
        </div>
      )}

      {diff.modifiedSteps.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <h3 className="diff-modified">~ Modified steps ({diff.modifiedSteps.length})</h3>
          {diff.modifiedSteps.map((mod) => (
            <div key={mod.id} style={{ marginBottom: 12 }}>
              <div className="small" style={{ marginBottom: 4 }}>
                <strong>{mod.id}</strong>
              </div>
              {mod.changes.map((change) => (
                <div key={change.field} style={{ display: 'grid', gridTemplateColumns: '100px 1fr 1fr', gap: 8, marginBottom: 6 }}>
                  <span className="muted small">{change.field}</span>
                  <ValueBlock value={change.from} />
                  <ValueBlock value={change.to} />
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {diff.unchangedStepIds.length > 0 && (
        <p className="muted small">Unchanged: {diff.unchangedStepIds.join(', ')}</p>
      )}
    </div>
  );
}
