#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildNativeRelease } = require('./build-e2ee-native-release');
const { stagePackage } = require('./stage-e2ee-platform-package');

function option(name, fallback = '') {
  const prefix = `--${name}=`;
  const value = process.argv.find(argument => argument.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

const root = path.resolve(__dirname,'..');
const output = path.resolve(option('output',path.join(root,'dist','e2ee-native')));
const temporaryRelease = path.join(root,`.e2ee-native-release-${process.pid}`);
try {
  const release = buildNativeRelease({
    root,
    privateKeyFile:path.resolve(String(process.env.VOKO_E2EE_RELEASE_PRIVATE_KEY_FILE || '')),
    outputDirectory:temporaryRelease,
  });
  const staged = stagePackage({ endpoint:release.executable,manifest:release.manifestPath,output,
    version:String(require('../package.json').version) });
  console.log(`Built ${staged.packageName} in ${staged.output}`);
} finally {
  fs.rmSync(temporaryRelease,{ recursive:true,force:true });
}
