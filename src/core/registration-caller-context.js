const { AsyncLocalStorage } = require('node:async_hooks');

const storage = new AsyncLocalStorage();

function runWithRegistrationCaller(caller, callback) {
  return storage.run(caller || null, callback);
}

function getRegistrationCaller() {
  return storage.getStore() || null;
}

module.exports = { getRegistrationCaller, runWithRegistrationCaller };
