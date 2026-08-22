import init, { WasmDirectPoc } from './voko_e2ee_wasm.js';

const toHex = (bytes) => [...new Uint8Array(bytes)]
  .map((value) => value.toString(16).padStart(2, '0'))
  .join('');

try {
  const [manifestResponse, wasmResponse] = await Promise.all([
    fetch('./asset-manifest.json', { cache: 'no-store' }),
    fetch('./voko_e2ee_wasm_bg.wasm', { cache: 'no-store' }),
  ]);
  if (!manifestResponse.ok || !wasmResponse.ok) throw new Error('E2EE browser asset unavailable');
  const manifest = await manifestResponse.json();
  const wasm = await wasmResponse.arrayBuffer();
  const digest = toHex(await crypto.subtle.digest('SHA-256', wasm));
  if (manifest.version !== 1 || digest !== manifest.wasmSha256) {
    throw new Error('E2EE WASM digest mismatch');
  }
  await init(wasm);
  const poc = new WasmDirectPoc('browser-poc-group', 'did:voko:browser-poc-agent');
  const plaintext = 'browser MLS round trip';
  const result = poc.round_trip(plaintext);
  document.body.dataset.status = result === plaintext ? 'passed' : 'failed';
  document.body.textContent = result;
} catch (error) {
  document.body.dataset.status = 'error';
  document.body.textContent = String(error && error.stack || error);
}
