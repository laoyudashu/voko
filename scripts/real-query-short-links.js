#!/usr/bin/env node
'use strict';

const { DatabaseSync } = require('node:sqlite');

const [dbPath, ...agentNames] = process.argv.slice(2);
if (!dbPath || agentNames.length === 0) {
  process.stderr.write('usage: real-query-short-links.js <db-path> <agent-name> [...]\n');
  process.exit(2);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
try {
  const query = db.prepare('SELECT agent_name AS agentName, imUid, short_link_url AS shortLinkUrl FROM agents WHERE agent_name = ?');
  const rows = agentNames.map(agentName => query.get(agentName) || { agentName, missing: true });
  process.stdout.write(`${JSON.stringify(rows)}\n`);
} finally {
  db.close();
}
