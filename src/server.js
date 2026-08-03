require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
// Requiring ./db is what actually creates data/workflow.db and applies
// migrations/schema.sql the first time this process runs - see
// src/setupDatabase.js. Requiring it here (rather than only indirectly via
// routes/workflows.js) makes that startup behavior visible from this file.
require('./db');
const workflowsRouter = require('./routes/workflows');
const runsRouter = require('./routes/runs');
const { seedIfNeeded } = require('../scripts/seedJobApplicationScreening');

// Ensures the demo workflow exists every time this process boots, not just
// once via a manually-run `npm run seed`. This matters specifically because
// many hosts (e.g. a Railway service with no persistent volume attached)
// wipe the filesystem - and therefore data/workflow.db - on every redeploy,
// so relying on someone remembering to re-seed after each deploy isn't
// reliable. seedIfNeeded() checks for the workflow by name first and is a
// no-op if it's already there (see scripts/seedJobApplicationScreening.js),
// so this is safe to run unconditionally on every boot and never touches
// any other workflow a user has created themselves.
try {
  // seedIfNeeded takes no argument - it requires src/db itself, which
  // resolves to this same cached singleton (Node's require cache), not a
  // second connection.
  seedIfNeeded();
} catch (err) {
  console.error('Demo data seeding failed (server will still start):', err.message);
}

const app = express();
app.use(express.json());

// The React frontend (frontend/) runs on its own Vite dev server port and
// talks to this API directly over fetch, so it needs CORS enabled. A
// wide-open '*' is fine for this local, single-user demo; a real
// deployment would restrict this to the frontend's actual origin.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', (req, res) => res.json({ ok: true }));
// Mounted under /api specifically because the React app's own client-side
// routes (WorkflowDetailPage at /workflows/:id, RunHistoryPage at /runs,
// RunDetailPage at /runs/:id) use the exact same-looking paths as this
// JSON API. As long as both are served from one origin (see the static
// block below), that's a real collision, not a hypothetical one: without
// the /api prefix, a browser hitting /workflows/abc123 would get this
// router's JSON 404 instead of the React app. frontend/src/api.js prefixes
// every request with /api to match.
app.use('/api/workflows', workflowsRouter);
// runsRouter declares its own full paths (/workflows/:id/runs, /runs/:id, ...)
// rather than sharing a single prefix, so it's mounted at /api directly.
app.use('/api', runsRouter);

// Serves the built React app (frontend/) from this SAME process, so a
// single deployment (one Railway service, one URL) shows the UI instead of
// just the JSON API. This only activates if frontend/dist exists - i.e. if
// `npm run build` was run first (see the root "build" script in
// package.json, which Railway's build step runs automatically). Running
// the backend alone locally without building the frontend still works
// exactly as before: this block is skipped and only the API is served.
//
// The API routes above are registered first and are all under /api, so
// they always win there; everything else - including the frontend's own
// client-side routes like /workflows/abc123, which aren't real files - is
// answered with the same index.html so React Router can take over.
const frontendDistPath = path.join(__dirname, '..', 'frontend', 'dist');
if (fs.existsSync(frontendDistPath)) {
  app.use(express.static(frontendDistPath));
  app.get('*', (req, res) => res.sendFile(path.join(frontendDistPath, 'index.html')));
  console.log('Serving frontend from', frontendDistPath);
} else {
  console.log('frontend/dist not found - serving API only (run `npm run build` to include the UI)');
}

// Last-resort error handler so a thrown error becomes a 500 JSON response
// instead of an unhandled exception / Express's default HTML error page.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Workflow platform listening on port ${port}`));
