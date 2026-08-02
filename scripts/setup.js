#!/usr/bin/env node
// Explicit `npm run setup` entry point. Not required for normal use -
// src/db.js calls ensureDatabase() itself as soon as the server starts -
// but useful to provision the database file ahead of time (e.g. as a
// separate step in a Dockerfile or CI job, before the process that will
// eventually listen on a port even runs).
const { ensureDatabase } = require('../src/setupDatabase');

ensureDatabase();
