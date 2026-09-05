const { performance } = require('node:perf_hooks');
const root = process.cwd();
const { initDatabase } = require(root + '/build/core/database');
const { createToolHandlers } = require(root + '/build/mcp/tools');
(async () => {
  for (const total of [10000, 100000]) {
    const db = initDatabase(':memory:', { silent: true });
    db.prepare("INSERT OR REPLACE INTO config(type,data,updated_at) VALUES('current_user_email',?,0)").run(JSON.stringify('synthetic@example.test'));
    db.prepare("INSERT INTO agents(id,agent_id,imUid,imToken,im_server_url,owner_email,created_at,updated_at) VALUES('a','a','a','synthetic','','synthetic@example.test',0,0)").run();
    const c = db.prepare("INSERT INTO conversations(user_uid,channel_id,channel_type,name,last_timestamp,agent_id) VALUES('a',?,1,?,?,'a')");
    const m = db.prepare("INSERT INTO messages(id,from_uid,to_uid,content,channel_id,channel_type,agent_id,timestamp,is_me,status,content_type) VALUES(?,'visitor','a','synthetic',?,1,'a',?,?,'received',1)");
    db.exec('BEGIN');
    for (let i = 0; i < 1000; i++) {
      c.run('channel-' + i, 'synthetic-' + i, i + 1);
      for (let j = 0; j < total / 1000; j++) m.run(`${i}-${j}`, 'channel-' + i, j + 1, j % 2 ? 0 : 1);
    }
    db.exec('COMMIT');
    let queries = [];
    const handlers = createToolHandlers({ db, query(sql, params = []) { queries.push({ sql, params }); return db.prepare(sql).all(...params); }, exec: (sql, params = []) => db.prepare(sql).run(...params) });
    await handlers.list_conversations({ agentId: 'a', limit: 100 });
    const samples = []; let result;
    for (let i = 0; i < 10; i++) {
      queries = []; const start = performance.now();
      result = await handlers.list_conversations({ agentId: 'a', limit: 100 });
      samples.push(performance.now() - start);
    }
    samples.sort((a,b) => a-b);
    const plans = queries.filter(q => q.sql.includes('FROM conversations') || q.sql.startsWith('WITH summaries AS')).slice(0, 2).map(q => db.prepare('EXPLAIN QUERY PLAN ' + q.sql).all(...q.params).map(row => row.detail));
    process.stdout.write(JSON.stringify({ totalMessages: total, totalConversations: 1000, resultTotal: result.total, pageCount: result.conversations.length, queries: queries.length, medianMs: samples[5], p95Ms: samples[9], plans }) + '\n');
    db.close();
  }
})();
