#!/usr/bin/env node
'use strict';

// Usage: node scripts/probe-codex-compatibility.js /absolute/path/to/codex [...]
// Builds must already exist. Does not invoke a model or use user configuration.
const fs = require('node:fs');
const path = require('node:path');
const { inspectCodexRuntime, probeCodexCompatibility, codexProbeRunner } = require('../build/core/dispatcher/codex-command');

(async () => {
  const binaries = process.argv.slice(2);
  if (!binaries.length || binaries.some(bin => !path.isAbsolute(bin))) {
    throw new Error('Pass one or more absolute Codex executable paths');
  }
  const probes = [];
  for (const executable of binaries) {
    const runtime = inspectCodexRuntime({ available: true, executable, canonicalPath: fs.realpathSync(executable),
      argvPrefix: [], pathEntries: [], resolvedAt: Date.now() });
    const run = codexProbeRunner(runtime), calls = [];
    const result = await probeCodexCompatibility(runtime, async (args, cwd, env) => {
      const output = await run(args, cwd, env);
      calls.push({ args: args.includes('--') ? args.slice(0, args.indexOf('--')) : args,
        code: output.code, ...(args.includes('--help') ? { help: output.stdout } : {}) });
      return output;
    });
    probes.push({ platform: process.platform, arch: process.arch, ...result, calls });
    if (!result.sandboxVerified) process.exitCode = 1;
  }
  console.log(JSON.stringify({ capturedAt: new Date().toISOString(),
    notice: 'Isolated CLI help and sandbox canaries. No model call or IM delivery; no user configuration or credentials used.', probes }, null, 2));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
