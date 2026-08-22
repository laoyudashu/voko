import init, { WasmDirectPoc } from '/voko_e2ee_wasm.js';

const DB_NAME = 'voko-e2ee-indexeddb-poc';
const CANARY = 'INDEXEDDB_PLAINTEXT_CANARY';

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('transaction aborted'));
  });
}

async function openDatabase() {
  const request = indexedDB.open(DB_NAME, 1);
  request.onupgradeneeded = () => {
    const database = request.result;
    database.createObjectStore('keys');
    database.createObjectStore('state');
    database.createObjectStore('outbox');
  };
  return requestResult(request);
}

async function read(database, storeName, key) {
  return requestResult(database.transaction(storeName).objectStore(storeName).get(key));
}

async function encryptState(key, stateSnapshot) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(stateSnapshot);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: new TextEncoder().encode('voko-wasm-state/1') },
    key,
    plaintext,
  );
  plaintext.fill(0);
  return { nonce, ciphertext };
}

async function decryptState(key, record) {
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: record.nonce, additionalData: new TextEncoder().encode('voko-wasm-state/1') },
    key,
    record.ciphertext,
  );
  return new TextDecoder().decode(plaintext);
}

await init();
const database = await openDatabase();
let key = await read(database, 'keys', 'device-key');
if (!key) {
  key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const keyTx = database.transaction('keys', 'readwrite');
  keyTx.objectStore('keys').put(key, 'device-key');
  await transactionDone(keyTx);
}

const existingState = await read(database, 'state', 'test-group');
if (!existingState) {
  const poc = new WasmDirectPoc('indexeddb-group', 'did:voko:indexeddb-agent');
  const prepared = JSON.parse(poc.prepare_record(CANARY));
  const encryptedState = await encryptState(key, prepared.stateSnapshot);
  const transaction = database.transaction(['state', 'outbox'], 'readwrite');
  transaction.objectStore('state').put(encryptedState, 'test-group');
  transaction.objectStore('outbox').put({
    messageId: prepared.messageId,
    ciphertext: prepared.ciphertext,
  }, prepared.messageId);
  await transactionDone(transaction);
  document.body.dataset.status = 'prepared';
} else {
  const outbox = await read(database, 'outbox', 'wasm-message-1');
  if (!outbox || JSON.stringify(outbox).includes(CANARY)) {
    throw new Error('IndexedDB outbox leaked plaintext or was incomplete');
  }
  const snapshot = await decryptState(key, existingState);
  const poc = WasmDirectPoc.restore(snapshot);
  const decrypted = poc.decrypt_record(outbox.messageId, outbox.ciphertext);
  if (decrypted !== CANARY) throw new Error('restored WASM state did not decrypt fixed ciphertext');
  const next = JSON.parse(poc.prepare_record('after browser reload'));
  if (next.messageId !== 'wasm-message-2') throw new Error('WASM sequence did not survive reload');

  const beforeState = await read(database, 'state', 'test-group');
  const beforeOutbox = await read(database, 'outbox', outbox.messageId);
  const aborted = database.transaction(['state', 'outbox'], 'readwrite');
  const abortedDone = transactionDone(aborted);
  aborted.objectStore('state').put({ corrupt: true }, 'test-group');
  aborted.objectStore('outbox').delete(outbox.messageId);
  aborted.abort();
  try { await abortedDone; } catch {}
  const afterState = await read(database, 'state', 'test-group');
  const afterOutbox = await read(database, 'outbox', outbox.messageId);
  if (!afterState?.ciphertext || afterOutbox?.ciphertext !== beforeOutbox.ciphertext) {
    throw new Error('aborted IndexedDB transaction partially changed state or outbox');
  }
  if (beforeState.ciphertext.byteLength !== afterState.ciphertext.byteLength) {
    throw new Error('state changed after aborted IndexedDB transaction');
  }
  document.body.dataset.status = 'restored';
}
