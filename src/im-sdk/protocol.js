'use strict';

const { randomUUID } = require('node:crypto');
const { Md5 } = require('md5-typescript');

const PacketType = Object.freeze({ CONNECT: 1, CONNACK: 2, SEND: 3, SENDACK: 4, RECV: 5, RECVACK: 6, PING: 7, PONG: 8, DISCONNECT: 9, EVENT: 12 });

class Writer {
  constructor() { this.bytes = []; }
  byte(value) { this.bytes.push(value & 0xff); }
  raw(value) { for (const byte of value) this.bytes.push(byte); }
  int16(value) { this.byte(value >> 8); this.byte(value); }
  int32(value) { this.byte(value >> 24); this.byte(value >> 16); this.byte(value >> 8); this.byte(value); }
  int64(value) {
    let n = BigInt(value);
    for (let shift = 56n; shift >= 0n; shift -= 8n) this.byte(Number((n >> shift) & 0xffn));
  }
  string(value = '') { const data = Buffer.from(value, 'utf8'); if (data.length > 0xffff) throw new Error('String exceeds uint16 length'); this.int16(data.length); this.raw(data); }
  result() { return Uint8Array.from(this.bytes); }
}

class Reader {
  constructor(data) { this.data = data; this.offset = 0; }
  byte() { if (this.offset >= this.data.length) throw new Error('Unexpected end of packet'); return this.data[this.offset++]; }
  int16() { return Number(this.number(2)); }
  int32() { return Number(this.number(4)); }
  int64() { return this.number(8); }
  number(size) { let result = 0n; for (let i = 0; i < size; i += 1) result = (result << 8n) | BigInt(this.byte()); return result; }
  string() { const size = this.int16(); if (this.offset + size > this.data.length) throw new Error('Unexpected end of string'); const value = this.data.slice(this.offset, this.offset + size); this.offset += size; return Buffer.from(value).toString('utf8'); }
  remaining() { const value = this.data.slice(this.offset); this.offset = this.data.length; return value; }
  variable() { let result = 0; let multiplier = 1; let b; do { if (multiplier > 128 ** 3) throw new Error('Malformed remaining length'); b = this.byte(); result += (b & 127) * multiplier; multiplier *= 128; } while (b & 128); return result; }
}

function frame(packetType, body, flags = {}) {
  const first = (packetType << 4) | (flags.dup ? 8 : 0) | (flags.syncOnce ? 4 : 0) | (flags.reddot ? 2 : 0) | (flags.noPersist ? 1 : 0);
  if (packetType === PacketType.PING || packetType === PacketType.PONG) return Uint8Array.of(first);
  const length = [];
  let remaining = body.length;
  do { let digit = remaining % 128; remaining = Math.floor(remaining / 128); if (remaining) digit |= 128; length.push(digit); } while (remaining);
  const result = new Uint8Array(1 + length.length + body.length);
  result[0] = first; result.set(length, 1); result.set(body, 1 + length.length);
  return result;
}

class BinaryProtocol {
  constructor(cryptoContext) { this.crypto = cryptoContext; this.serverVersion = 0; }

  encode(packet) {
    if (packet.type === PacketType.PING || packet.type === PacketType.PONG) return frame(packet.type, []);
    const w = new Writer();
    if (packet.type === PacketType.CONNECT) {
      w.byte(packet.version); w.byte(packet.deviceFlag); w.string(packet.deviceId); w.string(packet.uid); w.string(packet.token); w.int64(packet.clientTimestamp); w.string(packet.clientKey);
    } else if (packet.type === PacketType.SEND) {
      w.byte(packet.setting || 0); w.int32(packet.clientSeq); w.string(packet.clientMsgNo || randomUUID().replaceAll('-', '')); w.string(packet.channelId); w.byte(packet.channelType);
      if (this.serverVersion >= 3) w.int32(packet.expire || 0);
      const encrypted = Uint8Array.from(Buffer.from(this.crypto.encryptBytes(packet.payload), 'utf8'));
      const verify = `${packet.clientSeq}${packet.clientMsgNo}${packet.channelId || ''}${packet.channelType}${Buffer.from(encrypted).toString('utf8')}`;
      w.string(Md5.init(this.crypto.encryptString(verify)));
      if ((packet.setting || 0) & 8) w.string(packet.topic || '');
      w.raw(encrypted);
    } else if (packet.type === PacketType.RECVACK) {
      w.int64(packet.messageId); w.int32(packet.messageSeq);
    } else throw new Error(`Unsupported outbound packet type ${packet.type}`);
    return frame(packet.type, w.result(), packet);
  }

  decode(data) {
    const r = new Reader(data);
    const first = r.byte();
    const type = first >> 4;
    const packet = { type, noPersist: !!(first & 1), reddot: !!(first & 2), syncOnce: !!(first & 4), dup: !!(first & 8) };
    if (type === PacketType.PING || type === PacketType.PONG) return packet;
    const remaining = r.variable();
    if (r.offset + remaining !== data.length) throw new Error('Packet remaining length mismatch');
    if (type === PacketType.CONNACK) {
      if (first & 1) this.serverVersion = r.byte();
      return { ...packet, serverVersion: this.serverVersion, timeDiff: r.int64(), reasonCode: r.byte(), serverKey: r.string(), salt: r.string(), nodeId: this.serverVersion >= 4 ? r.int64() : null };
    }
    if (type === PacketType.SENDACK) return { ...packet, messageId: r.int64(), clientSeq: r.int32(), messageSeq: r.int32(), reasonCode: r.byte() };
    if (type === PacketType.RECV) {
      const setting = r.byte();
      const result = { ...packet, setting, msgKey: r.string(), fromUid: r.string(), channelId: r.string(), channelType: r.byte() };
      if (this.serverVersion >= 3) result.expire = r.int32();
      result.clientMsgNo = r.string(); result.messageId = r.int64(); result.messageSeq = r.int32(); result.timestamp = r.int32();
      if (setting & 8) result.topic = r.string();
      result.encryptedPayload = r.remaining();
      return result;
    }
    if (type === PacketType.DISCONNECT) return { ...packet, reasonCode: r.byte(), reason: r.string() };
    if (type === PacketType.EVENT) return { ...packet, id: r.string(), eventType: r.string(), timestamp: r.int64(), data: r.remaining() };
    throw new Error(`Unsupported inbound packet type ${type}`);
  }
}

module.exports = { BinaryProtocol, PacketType, Writer, Reader, frame };
