// The ONLY module in this app that knows the backend's URLs. Every page
// imports functions from here rather than calling fetch() directly, so
// there's exactly one place that would need to change if a route's path
// or method ever changes. Nothing here touches SQLite, or even knows it
// exists - that's the backend's job entirely (see the Express routes in
// ../../src/routes/).
//
// Default depends on how the app is running:
//   - `npm run dev` (import.meta.env.DEV): Vite serves this app on its own
//     port (5173) separate from the Express backend (3000), so it needs an
//     absolute URL to reach it.
//   - `npm run build` (production): server.js serves these built files
//     itself, same origin as the API, so relative paths ('') are correct -
//     hardcoding localhost:3000 here would make the deployed app try to
//     call the visitor's own machine instead of the server it came from.
// VITE_API_BASE_URL always overrides both, for deploying the frontend
// separately from the backend (e.g. two Railway services, or a static host
// in front of a separately-hosted API).
const BASE_URL = import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? 'http://localhost:3000' : '');

// Every backend route is mounted under /api (see src/server.js) precisely
// so it can't collide with this app's own client-side routes - e.g.
// GET /workflows/:id is both a React Router page AND, without the prefix,
// would have been indistinguishable from this app's JSON endpoint of the
// same name once both are served from one origin.
async function request(path, options = {}) {
  const res = await fetch(`${BASE_URL}/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(body?.error || `Request to ${path} failed with status ${res.status}`);
  }
  return body;
}

const get = (path) => request(path);
const post = (path, body) => request(path, { method: 'POST', body: JSON.stringify(body || {}) });

// --- workflows ---
export const listWorkflows = () => get('/workflows');
export const getWorkflow = (workflowId) => get(`/workflows/${workflowId}`);
export const createWorkflow = (data) => post('/workflows', data);
export const listVersions = (workflowId) => get(`/workflows/${workflowId}/versions`);
export const getVersion = (workflowId, versionNumber) => get(`/workflows/${workflowId}/versions/${versionNumber}`);
export const publishVersion = (workflowId, data) => post(`/workflows/${workflowId}/versions`, data);
export const diffVersions = (workflowId, fromVersion, toVersion) =>
  get(`/workflows/${workflowId}/versions/${fromVersion}/diff/${toVersion}`);
export const validateDefinition = (definition) => post('/workflows/validate', definition);

// --- runs ---
export const listAllRuns = () => get('/runs');
export const listRunsForWorkflow = (workflowId) => get(`/workflows/${workflowId}/runs`);
export const getRun = (runId) => get(`/runs/${runId}`);
export const startRun = (workflowId, data) => post(`/workflows/${workflowId}/runs`, data);
export const executeRun = (runId, data) => post(`/runs/${runId}/execute`, data);
export const cancelRun = (runId, data) => post(`/runs/${runId}/cancel`, data);
export const resumeRun = (runId, data) => post(`/runs/${runId}/resume`, data);
export const recoverRun = (runId, data) => post(`/runs/${runId}/recover`, data);
export const approveStep = (runId, stepId, data) => post(`/runs/${runId}/steps/${stepId}/approve`, data);
export const rejectStep = (runId, stepId, data) => post(`/runs/${runId}/steps/${stepId}/reject`, data);
export const retryStep = (runId, stepId, data) => post(`/runs/${runId}/steps/${stepId}/retry`, data);
export const getRunAudit = (runId) => get(`/runs/${runId}/audit`);
export const getRunExplanation = (runId) => get(`/runs/${runId}/explanation`);
