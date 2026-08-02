require('dotenv').config();
const express = require('express');
// Requiring ./db is what actually creates data/workflow.db and applies
// migrations/schema.sql the first time this process runs - see
// src/setupDatabase.js. Requiring it here (rather than only indirectly via
// routes/workflows.js) makes that startup behavior visible from this file.
require('./db');
const workflowsRouter = require('./routes/workflows');
const runsRouter = require('./routes/runs');

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
app.use('/workflows', workflowsRouter);
// runsRouter declares its own full paths (/workflows/:id/runs, /runs/:id, ...)
// rather than sharing a single prefix, so it's mounted at the app root.
app.use('/', runsRouter);

// Last-resort error handler so a thrown error becomes a 500 JSON response
// instead of an unhandled exception / Express's default HTML error page.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Workflow platform listening on port ${port}`));
