#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PACKAGE_NAMES = {
  'win32:x64': '@voko/e2ee-win32-x64',
  'linux:x64': '@voko/e2ee-linux-x64',
  'linux:arm64': '@voko/e2ee-linux-arm64',
  'darwin:x64': '@voko/e2ee-darwin-x64',
  'darwin:arm64': '@voko/e2ee-darwin-arm64',
};

function required(name) {
  const prefix = `--${name}=`;
  const value = process.argv.find(argument => argument.startsWith(prefix));
  if (!value || !value.slice(prefix.length)) throw new Error(`Missing ${prefix}<value>`);
  return path.resolve(value.slice(prefix.length));
}

function stagePackage({ endpoint, manifest, output, version }) {
  const parsedManifest = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  const platform = String(parsedManifest.platform || '');
  const arch = String(parsedManifest.arch || '');
  const packageName = PACKAGE_NAMES[`${platform}:${arch}`];
  if (!packageName) throw new Error(`Unsupported E2EE platform package: ${platform}/${arch}`);
  if (!fs.statSync(endpoint).isFile() || !fs.statSync(manifest).isFile()) throw new Error('E2EE package input is not a file');

  const binDirectory = path.join(output, 'bin');
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(binDirectory, { recursive: true });
  const executableName = platform === 'win32' ? 'voko-e2ee-endpoint.exe' : 'voko-e2ee-endpoint';
  const destination = path.join(binDirectory, executableName);
  fs.copyFileSync(endpoint, destination);
  fs.copyFileSync(manifest, `${destination}.manifest.json`);
  if (platform !== 'win32') fs.chmodSync(destination, 0o755);
  fs.writeFileSync(path.join(output, 'package.json'), `${JSON.stringify({
    name: packageName,
    version,
    description: `VOKO E2EE native endpoint for ${platform}-${arch}`,
    license: 'AGPL-3.0-only',
    os: [platform],
    cpu: [arch],
    files: ['bin/'],
    engines: { node: '>=22.5.0' },
    repository: { type: 'git', url: 'git+https://github.com/laoyudashu/voko.git' },
  }, null, 2)}\n`);
  return { packageName, output };
}

if (require.main === module) {
  const rootPackage = require('../package.json');
  const result = stagePackage({
    endpoint: required('endpoint'),
    manifest: required('manifest'),
    output: required('output'),
    version: String(rootPackage.version),
  });
  console.log(`Staged ${result.packageName} in ${result.output}`);
}

module.exports = { stagePackage, PACKAGE_NAMES };
