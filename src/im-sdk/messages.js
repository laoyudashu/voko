'use strict';

const ContentType = Object.freeze({ Text: 1, Image: 2, File: 8, Command: 99 });
const ChannelType = Object.freeze({ Person: 1, Group: 2 });

function withMention(payload, mention) {
  if (!mention || (!mention.all && !mention.uids?.length)) return payload;
  return { ...payload, mention: { ...(mention.all ? { all: 1 } : {}), ...(mention.uids?.length ? { uids: mention.uids } : {}) } };
}

function encodeContent(type, fields, mention) {
  return Uint8Array.from(Buffer.from(JSON.stringify(withMention({ ...fields, type }, mention)), 'utf8'));
}

function decodeContent(payload) {
  const value = JSON.parse(Buffer.from(payload).toString('utf8'));
  if (value.mention) value.mention = { all: value.mention.all === 1, uids: value.mention.uids || [] };
  // VOKO historically emitted files as 3 or 4. Only normalize payloads with
  // an attachment shape so GIF/video/voice messages keep their real type.
  if ((value.type === 3 || value.type === 4) && value.url && (value.name || value.fileName)) {
    value.legacyType = value.type;
    value.type = ContentType.File;
  }
  return value;
}

module.exports = { ContentType, ChannelType, encodeContent, decodeContent };
