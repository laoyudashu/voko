'use strict';

const ENDPOINTS = require('../endpoints.json');

function migrateOfficialHttpsUrls(db) {
  const now = Date.now();
  const result = { agents: 0, oss: 0 };
  result.agents += db.prepare('UPDATE agents SET im_server_url = ?, updated_at = ? WHERE im_server_url IN (?, ?)')
    .run(ENDPOINTS.im.wsUrl, now, 'ws://8.153.167.187:5200', 'ws://im.vokovoko.com:5200').changes;
  result.agents += db.prepare('UPDATE agents SET chatroom_url = ? || substr(chatroom_url, length(?) + 1), updated_at = ? WHERE chatroom_url = ? OR chatroom_url LIKE ?')
    .run(ENDPOINTS.im.baseUrl, 'http://im.vokovoko.com', now, 'http://im.vokovoko.com', 'http://im.vokovoko.com/%').changes;
  for (const legacyBase of ['http://www.vokovoko.com', 'http://vokovoko.com']) {
    result.agents += db.prepare('UPDATE agents SET short_link_url = ? || substr(short_link_url, length(?) + 1), updated_at = ? WHERE short_link_url = ? OR short_link_url LIKE ?')
      .run(ENDPOINTS.api.baseUrl, legacyBase, now, legacyBase, legacyBase + '/%').changes;
  }
  const row = db.prepare("SELECT data FROM config WHERE type = 'oss_config'").get();
  if (row && row.data) {
    try {
      const config = JSON.parse(row.data);
      if (config.publicUrl === 'http://files.vokovoko.com') {
        config.publicUrl = ENDPOINTS.oss.publicUrl;
        db.prepare('UPDATE config SET data = ?, updated_at = ? WHERE type = ?')
          .run(JSON.stringify(config), now, 'oss_config');
        result.oss = 1;
      }
    } catch (_) {}
  }
  return result;
}

module.exports = { migrateOfficialHttpsUrls };
