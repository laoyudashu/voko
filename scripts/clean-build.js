#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const build = path.join(__dirname, '..', 'build');
fs.rmSync(build, { recursive: true, force: true });
console.log('[clean-build] build/ 已清空');
