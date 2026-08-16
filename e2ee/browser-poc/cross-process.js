import init, { WasmCreatorEndpoint } from '/voko_e2ee_wasm.js';

async function json(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return response.json();
}

try {
  await init();
  const directory = await json('/canary/key-package');
  const creator = new WasmCreatorEndpoint('cross-process-group', 'did:voko:cross-process-agent');
  const prepared = JSON.parse(creator.prepare_add(directory.keyPackage));
  await json('/canary/establish', prepared);
  creator.accept_add();
  const ack = await json('/canary/ack');
  if (creator.decrypt_ack(ack.ciphertext) !== 'GROUP_ESTABLISHED') throw new Error('invalid establishment ACK');
  const plaintext = 'E2EE_CROSS_PROCESS_SERVER_MUST_NOT_SEE';
  const ciphertext = creator.encrypt_message(plaintext);
  const delivered = await json('/canary/message', { ciphertext });
  if (delivered.text !== plaintext) throw new Error('Lite plaintext mismatch');
  document.body.dataset.status = 'passed';
  document.body.textContent = 'Cross-process E2EE canary passed.';
} catch (error) {
  document.body.dataset.status = 'failed';
  document.body.textContent = error instanceof Error ? error.message : String(error);
}
