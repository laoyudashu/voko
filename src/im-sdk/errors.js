'use strict';

class VokoIMError extends Error {
  constructor(message, code, details = {}) { super(message); this.name = this.constructor.name; this.code = code; Object.assign(this, details); }
}

class VokoIMSendError extends VokoIMError {
  constructor(message, details = {}) { super(message, details.code || 'SEND_FAILED', details); }
}

class VokoIMProtocolError extends VokoIMError {
  constructor(message, details = {}) { super(message, details.code || 'PROTOCOL_ERROR', details); }
}

module.exports = { VokoIMError, VokoIMSendError, VokoIMProtocolError };
