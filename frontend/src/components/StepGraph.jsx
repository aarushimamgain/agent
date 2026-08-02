import StatusBadge from './StatusBadge.jsx';

// Renders a workflow definition's steps as a vertical list of boxes (in the
// order they appear in the definition - the same order the engine
// processes them in, see engine.js's advanceRun) with SVG connector lines
// for two kinds of edges: a plain arrow for a data dependency (`inputs`
// referencing a prior step's output) and a labeled arrow for a
// deterministic_condition's on_true/on_false branch. This is deliberately
// NOT a general graph-layout algorithm (no dagre/elk) - steps are laid out
// in a single column at fixed, precomputed row positions, so connector
// coordinates are plain arithmetic instead of measured DOM positions.
//
// `liveStatusByStepId` is optional: a Map of step id -> run_steps row. When
// present (a run is active/selected), each box also shows its current
// execution status; when absent, this just renders the static structure of
// the definition.
const ROW_HEIGHT = 88;
const BOX_HEIGHT = 60;
const RAIL_WIDTH = 150;

function computeEdges(steps) {
  const edges = [];
  for (const step of steps) {
    for (const value of Object.values(step.inputs || {})) {
      if (value && typeof value === 'object' && 'from' in value) {
        edges.push({ from: value.from, to: step.id, label: null });
      }
    }
    if (step.type === 'deterministic_condition') {
      if (step.config.on_true) edges.push({ from: step.id, to: step.config.on_true, label: 'true' });
      if (step.config.on_false) edges.push({ from: step.id, to: step.config.on_false, label: 'false' });
    }
  }
  return edges;
}

// A little extra config detail per step type, shown under the step id so
// the graph carries some real information instead of just empty boxes.
function stepDetail(step) {
  switch (step.type) {
    case 'deterministic_condition':
      return `if ${step.config.expression}`;
    case 'human_approval':
      return `approvers: ${(step.config.approvers || []).join(', ')}`;
    case 'mock_external_action':
      return `action: ${step.config.action_name}`;
    case 'ai_extraction':
    case 'ai_classification':
      return `model: ${step.config.model}`;
    case 'document_retrieval':
      return `source: ${step.config.source}`;
    default:
      return null;
  }
}

export default function StepGraph({ definition, liveStatusByStepId }) {
  const steps = definition.steps;
  const indexById = new Map(steps.map((s, i) => [s.id, i]));
  const edges = computeEdges(steps).filter((e) => indexById.has(e.from) && indexById.has(e.to));

  const rowCenter = (i) => i * ROW_HEIGHT + BOX_HEIGHT / 2;
  const totalHeight = steps.length * ROW_HEIGHT;

  return (
    <div style={{ position: 'relative', paddingLeft: RAIL_WIDTH, minHeight: totalHeight }}>
      <svg
        width={RAIL_WIDTH}
        height={totalHeight}
        style={{ position: 'absolute', top: 0, left: 0, overflow: 'visible' }}
      >
        <defs>
          <marker id="arrowhead" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="var(--color-text-muted)" />
          </marker>
        </defs>
        {edges.map((edge, i) => {
          const fromIndex = indexById.get(edge.from);
          const toIndex = indexById.get(edge.to);
          const y1 = rowCenter(fromIndex);
          const y2 = rowCenter(toIndex);
          const distance = Math.max(1, Math.abs(toIndex - fromIndex));
          const bulge = Math.min(RAIL_WIDTH - 20, 24 + distance * 12);
          const x1 = RAIL_WIDTH;
          const x2 = RAIL_WIDTH - bulge;
          const path = `M ${x1} ${y1} C ${x2} ${y1} ${x2} ${y2} ${x1} ${y2}`;
          const stroke = edge.label === 'false' ? 'var(--color-failed)' : edge.label === 'true' ? 'var(--color-succeeded)' : 'var(--color-text-muted)';
          return (
            <g key={i}>
              <path d={path} fill="none" stroke={stroke} strokeWidth="1.5" markerEnd="url(#arrowhead)" />
              {edge.label && (
                <text x={x2 - 4} y={(y1 + y2) / 2} fontSize="10" fill={stroke} textAnchor="end">
                  {edge.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {steps.map((step, i) => {
        const liveStatus = liveStatusByStepId?.get(step.id);
        const detail = stepDetail(step);
        return (
          <div
            key={step.id}
            className="card"
            style={{
              position: 'absolute',
              top: i * ROW_HEIGHT,
              left: RAIL_WIDTH,
              right: 0,
              height: BOX_HEIGHT,
              margin: 0,
              padding: '8px 12px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <strong>{step.id}</strong>
                <span className="muted small">{step.type}</span>
              </div>
              {detail && (
                <div className="muted small mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {detail}
                </div>
              )}
            </div>
            {liveStatus && <StatusBadge status={liveStatus.status} />}
          </div>
        );
      })}
    </div>
  );
}
