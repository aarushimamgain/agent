// Builds the human-readable "execution explanation" for a run (requirement
// 2 of the observability work): which path was taken, which conditions
// evaluated true/false and why (with the actual compared values), which
// steps were skipped and why, read as plain English rather than a raw log
// dump.
//
// Deliberately NOT a re-analysis of the workflow definition: everything
// this function says is pulled directly from audit_log rows that engine.js
// wrote at the moment each decision was made (see the "FULL OBSERVABILITY"
// section at the top of engine.js). This function only formats what
// already happened - it never re-evaluates a condition or re-derives why a
// step was skipped, because that logic (and the risk of it drifting out of
// sync with the engine's actual behavior) already lives in one place.
const { getRun, getRunSteps, loadDefinition } = require('./engine');

function parseJsonColumn(value) {
  return value ? JSON.parse(value) : null;
}

function formatValue(value) {
  return typeof value === 'string' ? `"${value}"` : JSON.stringify(value);
}

function describeComparedValues(resolvedInputs) {
  return Object.entries(resolvedInputs || {})
    .map(([name, value]) => `${name} = ${formatValue(value)}`)
    .join(', ');
}

// Per-step-type phrasing for a step that succeeded, using whatever
// audit_log events were recorded for it to add the specific detail a
// generic "step X succeeded" wouldn't have.
function describeSucceededStep(step, events) {
  if (step.type === 'deterministic_condition') {
    const evalEvent = events.find((e) => e.event_type === 'condition_evaluated');
    if (evalEvent) {
      const { expression, resolved_inputs, decision, branch_taken, branch_skipped } = evalEvent.payload;
      const compared = describeComparedValues(resolved_inputs);
      return (
        `Step "${step.id}" (condition) evaluated "${expression}"` +
        (compared ? ` with ${compared}` : '') +
        `: the condition was ${decision ? 'TRUE' : 'FALSE'}, so the run took branch "${branch_taken}"` +
        (branch_skipped ? ` and did not take branch "${branch_skipped}".` : '.')
      );
    }
  }

  if (step.type === 'ai_extraction' || step.type === 'ai_classification') {
    const callEvent = [...events].reverse().find((e) => e.event_type === 'ai_call' && e.status === 'success');
    return `Step "${step.id}" (${step.type}) called the AI model${callEvent ? ` (tool "${callEvent.payload?.tool}")` : ''} and succeeded.`;
  }

  if (step.type === 'document_retrieval' || step.type === 'mock_external_action') {
    const callEvent = [...events].reverse().find((e) => e.event_type === 'tool_call' && e.status === 'success');
    const wasReplay = callEvent?.payload?.output?.idempotent_replay === true;
    return (
      `Step "${step.id}" (${step.type}) called tool "${callEvent?.payload?.tool || 'unknown'}" and succeeded` +
      (wasReplay ? ' (result reused from a previous attempt - the idempotency guarantee prevented calling it again).' : '.')
    );
  }

  if (step.type === 'human_approval') {
    const decisionEvent = events.find((e) => e.event_type === 'approval_decision');
    return `Step "${step.id}" (human_approval) was approved${decisionEvent?.payload?.approved_by ? ` by ${decisionEvent.payload.approved_by}` : ''}.`;
  }

  return `Step "${step.id}" (${step.type}) succeeded.`;
}

function describeRetries(events) {
  return events
    .filter((e) => e.event_type === 'retry_attempt')
    .map((e) => {
      if (e.payload?.manual) {
        return `  a human confirmed a retry${e.payload.recovered ? ' as part of recovering the run' : ''} after: ${e.payload.previous_error || e.payload.error || 'a prior failure'}`;
      }
      return `  automatic retry ${e.payload?.attempt}/${e.payload?.max_attempts} after: ${e.payload?.error}`;
    });
}

function describeFinalOutcome(run) {
  if (run.status === 'completed') {
    return `Run completed successfully.${run.final_output ? ` Final output: ${run.final_output}` : ''}`;
  }
  if (run.status === 'failed') return `Run FAILED: ${run.error || 'no error recorded'}.`;
  if (run.status === 'cancelled') return 'Run was cancelled.';
  if (run.status === 'waiting_approval') return 'Run is currently paused, waiting for human approval.';
  return `Run is currently "${run.status}".`;
}

function explainRun(db, runId) {
  const run = getRun(db, runId);
  if (!run) return null;

  const definition = loadDefinition(db, run.workflow_version_id);
  const workflow = db.prepare('SELECT name FROM workflows WHERE id = ?').get(run.workflow_id);

  const stepRowByStepId = new Map(getRunSteps(db, runId).map((row) => [row.step_id, row]));

  // created_at only has second resolution (SQLite's datetime('now')), so
  // several events in the same tick of the engine loop can share a
  // timestamp - rowid (SQLite's implicit, monotonically-increasing insert
  // order) is the tiebreaker that actually guarantees chronological order,
  // not `id` (a random UUID, which would sort those same-second rows
  // effectively at random).
  const auditRows = db
    .prepare('SELECT * FROM audit_log WHERE run_id = ? ORDER BY created_at ASC, rowid ASC')
    .all(runId)
    .map((row) => ({ ...row, payload: parseJsonColumn(row.payload) }));

  const eventsByStepId = new Map();
  for (const row of auditRows) {
    if (!row.step_id) continue;
    if (!eventsByStepId.has(row.step_id)) eventsByStepId.set(row.step_id, []);
    eventsByStepId.get(row.step_id).push(row);
  }

  const narrative = [`Run "${runId}" of workflow "${workflow?.name || run.workflow_id}" started with input ${run.input_data || '{}'}.`];
  const pathTaken = [];
  const skippedSteps = [];
  const failedSteps = [];

  for (const step of definition.steps) {
    const stepRow = stepRowByStepId.get(step.id);
    if (!stepRow) continue; // definition and run_steps are always kept in sync by createRun; defensive only
    const events = eventsByStepId.get(step.id) || [];

    if (stepRow.status === 'succeeded') {
      pathTaken.push(step.id);
      narrative.push(describeSucceededStep(step, events));
    } else if (stepRow.status === 'skipped') {
      const skipEvent = events.find((e) => e.event_type === 'step_skipped');
      const reason = skipEvent?.payload?.reason || 'an upstream branch was not taken.';
      skippedSteps.push({ step_id: step.id, reason });
      narrative.push(`Step "${step.id}" (${step.type}) was SKIPPED: ${reason}`);
    } else if (stepRow.status === 'failed') {
      const rejection = events.find((e) => e.event_type === 'approval_decision' && e.status === 'rejected');
      const reason = rejection ? `rejected${rejection.payload?.rejected_by ? ` by ${rejection.payload.rejected_by}` : ''}` : stepRow.error || 'no error recorded';
      failedSteps.push({ step_id: step.id, reason });
      narrative.push(`Step "${step.id}" (${step.type}) FAILED: ${reason}`);
    } else if (stepRow.status === 'paused') {
      narrative.push(`Step "${step.id}" (${step.type}) is PAUSED, waiting for human approval.`);
    } else {
      narrative.push(`Step "${step.id}" (${step.type}) has not run yet (${stepRow.status}).`);
    }

    narrative.push(...describeRetries(events));
  }

  narrative.push(describeFinalOutcome(run));

  return {
    run_id: runId,
    workflow_name: workflow?.name || null,
    status: run.status,
    narrative,
    path_taken: pathTaken,
    skipped_steps: skippedSteps,
    failed_steps: failedSteps,
  };
}

module.exports = { explainRun };
