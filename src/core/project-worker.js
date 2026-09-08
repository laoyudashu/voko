'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createProjectClient } = require('./project-client');
const { RESULT_INSTRUCTION, parseProjectResult } = require('./project-result');

// Durable result outbox: a lost response or process restart never re-executes a claimed command.
function createProjectWorker({ db, dispatcher, client = createProjectClient(db), safety, fetchImpl = fetch }) {
  db.exec(`CREATE TABLE IF NOT EXISTS project_execution_outbox (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, channel_id TEXT NOT NULL, claim_id TEXT NOT NULL,
    state TEXT NOT NULL, payload TEXT NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS project_execution_recovery (
    id TEXT PRIMARY KEY, directory TEXT NOT NULL, task_id TEXT NOT NULL, late_reply TEXT)`);
  let stopped = false, timer, running = false;
  async function cleanup(id) {
    const record=db.prepare('SELECT directory FROM project_execution_recovery WHERE id=?').get(id);
    if(record)await fs.rm(record.directory,{recursive:true,force:true});
    db.prepare('DELETE FROM project_execution_recovery WHERE id=?').run(id);
    db.prepare('DELETE FROM project_execution_outbox WHERE id=?').run(id);
  }
  async function api(agent, channel, action, body) {
    const result = await client(agent, channel, action, body);
    if (!result.body.success) { const error = new Error(result.body.code); error.status = result.status; throw error; }
    return result.body.data;
  }
  async function flush() {
    for (const row of db.prepare("SELECT * FROM project_execution_outbox WHERE state='result'").all()) {
      try {
        await api(row.agent_id,row.channel_id,'executionFinish',{execution_id:row.id,claim_id:row.claim_id,...JSON.parse(row.payload)});
        if(JSON.parse(row.payload).status==='unknown')db.prepare("UPDATE project_execution_outbox SET state='uncertain' WHERE id=?").run(row.id);
        else await cleanup(row.id);
      } catch(error) {
        if(error.message==='PROJECT_EXECUTION_TERMINAL'){await cleanup(row.id);continue;}
        if ([401,403,404].includes(error.status)) db.prepare("UPDATE project_execution_outbox SET state='denied',payload='{}' WHERE id=?").run(row.id);
      }
    }
  }
  async function upload(agent,channel,task,run,file,name) {
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 50*1024*1024) throw new Error('PROJECT_ASSET_SIZE');
    const prepared = await api(agent,channel,'assetPrepare',{id:task,execution_id:run,name,size:info.size});
    const response = await fetchImpl(prepared.url,{method:'PUT',redirect:'error',headers:prepared.headers,body:await fs.readFile(file),signal:AbortSignal.timeout(120000)});
    if (!response.ok) throw new Error('PROJECT_ASSET_UPLOAD_FAILED');
    await api(agent,channel,'assetCommit',{asset_id:prepared.id});
  }
  async function finishReply(agent,channel,task,run,directory,reply) {
    if(reply.error) return {status:'unknown',result:'Provider 返回错误，执行结果仍待确认；工作目录已保留。'};
    const raw=String(reply.content || '').slice(0,60000);
    await safety?.assertAllowed(raw,'outbound');
    const parsed=parseProjectResult(raw);
    if(!parsed)return {status:'unknown',result:`${raw}\n\n未收到有效执行回执，不能确认执行成功；请核对结果，勿直接重复派单。`.slice(0,60000)};
    if(parsed.status!=='succeeded')return {status:parsed.status,result:parsed.result};
    const outputs=path.join(directory,'outputs'),names=await fs.readdir(outputs);
    if(names.length!==parsed.files.length || names.some(name=>!parsed.files.includes(name)))
      return {status:'unknown',result:parsed.result+'\n\n执行回执与实际成果文件不一致；工作目录已保留，请核对结果。'};
    // Validate the full set before beginning any network writes.
    for(const name of names){const info=await fs.lstat(path.join(outputs,name));
      if(!info.isFile()||info.isSymbolicLink()||info.size<1||info.size>50*1024*1024)throw new Error('PROJECT_ASSET_SIZE');}
    for(const name of names)await upload(agent,channel,task,run,path.join(outputs,name),name);
    return {status:'succeeded',result:parsed.result};
  }
  async function recover() {
    for(const row of db.prepare("SELECT * FROM project_execution_outbox WHERE state='uncertain'").all()){
      const record=db.prepare('SELECT * FROM project_execution_recovery WHERE id=?').get(row.id);
      if(!record)continue;
      try{
        const current=await api(row.agent_id,row.channel_id,'taskGet',{id:record.task_id});
        const run=current.executions.find(run=>run.id===row.id);
        if(!run || !['working','unknown'].includes(run.status)){await cleanup(row.id);continue;}
        if(!record.late_reply)continue;
        // Consume once. An uncertain upload is never blindly replayed on another tick.
        db.prepare('UPDATE project_execution_recovery SET late_reply=NULL WHERE id=?').run(row.id);
        let result;
        try { result=await finishReply(row.agent_id,row.channel_id,record.task_id,row.id,record.directory,JSON.parse(record.late_reply)); }
        catch { result={status:'unknown',result:'迟到结果已收到，但成果校验或上传未确认；工作目录已保留，请核对。'}; }
        db.prepare("UPDATE project_execution_outbox SET state='result',payload=? WHERE id=?").run(JSON.stringify(result),row.id);
      }catch { /* Keep the late receipt and directory until membership/server access is available. */ }
    }
  }
  async function execute(agent,job) {
    const claim = crypto.randomUUID();
    db.prepare('INSERT INTO project_execution_outbox VALUES(?,?,?,?,?,?)').run(job.id,agent.agent_id,job.channel_id,claim,'claiming','{}');
    let data;
    try { data = await api(agent.agent_id,job.channel_id,'executionClaim',{execution_id:job.id,claim_id:claim}); }
    catch(error) {
      // A claim may have committed even when its response was lost. Never claim it again.
      db.prepare("UPDATE project_execution_outbox SET state='result',payload=? WHERE id=?").run(JSON.stringify({status:'unknown',result:'领取响应未确认；未在本机启动执行。'}),job.id);
      return;
    }
    db.prepare("UPDATE project_execution_outbox SET state='running' WHERE id=?").run(job.id);
    let directory, result = '', status = 'unknown';
    try {
      directory = await fs.mkdtemp(path.join(os.tmpdir(),'voko-collaboration-'));
      const outputs=path.join(directory,'outputs');await fs.mkdir(outputs);
      db.prepare('INSERT INTO project_execution_recovery VALUES(?,?,?,NULL)').run(job.id,directory,data.task.id);
      const storage = await api(agent.agent_id,job.channel_id,'storageGet',{});
      // File-producing collaboration requires the configured customer storage before Provider delivery.
      if (!storage.configuration) {status='input_required';result='请管理员先在资产页配置云空间，再重新派单。';return;}
      const files=[];
      for(const asset of data.assets.filter(a=>a.status==='ready').slice(-10)) {
        const signed=await api(agent.agent_id,job.channel_id,'assetDownload',{asset_id:asset.id});
        const response=await fetchImpl(signed.url,{redirect:'error',signal:AbortSignal.timeout(120000)});
        if(!response.ok)throw new Error('PROJECT_ASSET_DOWNLOAD_FAILED');
        const chunks=[];let total=0;for await (const chunk of response.body){total+=chunk.length;if(total>Number(asset.size)||total>50*1024*1024)throw new Error('PROJECT_ASSET_SIZE');chunks.push(chunk);}const bytes=Buffer.concat(chunks);
        if(/\.(txt|md|json|csv|yaml|yml)$/i.test(asset.name))await safety?.assertAllowed(bytes.toString('utf8'),'inbound');
        if(bytes.length!==Number(asset.size) || bytes.length>50*1024*1024)throw new Error('PROJECT_ASSET_SIZE');
        const local=path.join(directory,asset.id+path.extname(asset.name).replace(/[^.a-zA-Z0-9]/g,''));await fs.writeFile(local,bytes);files.push(`${asset.name}: ${local}`);
      }
      const history=data.messages.slice(-20).map(m=>`${m.actor_uid}: ${m.content}`).join('\n');
      const prior=data.executions.filter(e=>e.status==='succeeded').slice(-4).map(e=>e.result).join('\n');
      const content=`协作任务：${data.task.title}\n目标：${data.task.description}\n协作约定：${data.instructions}\n最近讨论（最多20条）：\n${history}\n最近结果（最多4次）：\n${prior.slice(-30000)}\n输入文件：\n${files.join('\n')}\n本次明确派单：${data.execution.instruction}\n请把文件成果写入 ${outputs}，最终回复简述结果。不要向公共群自动发消息，不要宣称业务任务已经完成。\n${RESULT_INSTRUCTION}`;
      await safety?.assertAllowed(content,'inbound');
      const scope=crypto.createHash('sha256').update(JSON.stringify(['voko-project',job.channel_id,data.task.id,agent.agent_id])).digest('hex');
      const output=await dispatcher.executeIsolated({agentId:agent.agent_id,taskId:job.id,contextId:scope,protocolContextId:scope,
        executionScope:'a2a_mailbox',sourceType:'external',principalScope:`project:${scope}`,sessionScopeId:`project:${job.id}`,bindingGeneration:1,
        content,timeoutMs:120000,attachmentOutputDirectory:outputs,
        onLateReply:async reply=>{
          let safe={content:String(reply.content||'').slice(0,60000),error:Boolean(reply.error)};
          try{await safety?.assertAllowed(safe.content,'outbound');}catch{safe={content:'',error:true};}
          db.prepare('UPDATE project_execution_recovery SET late_reply=? WHERE id=?').run(JSON.stringify(safe),job.id);
        }});
      ({result,status}=await finishReply(agent.agent_id,job.channel_id,data.task.id,job.id,directory,output.reply || {}));
    } catch(error) {
      if(error.name==='A2ASafetyRejection')result='';
      status = ['not_delivered','rejected'].includes(error.deliveryOutcome) || error.name==='A2ASafetyRejection' ? 'failed' : 'unknown';
      // Never persist provider/network errors that can contain credentials or presigned URLs.
      result = result ? `${result}\n\n成果上传或后续确认失败，请先核对本次结果，不要直接重复执行。` : (status==='failed'?'本次请求未执行成功。':'执行或成果状态未确认，请核对结果。');
    } finally {
      db.prepare("UPDATE project_execution_outbox SET state='result',payload=? WHERE id=?").run(JSON.stringify({status,result:result.slice(0,60000)}),job.id);
      // Retain files until terminal result acknowledgement, including timeout/restart recovery.
    }
  }
  async function tick() {
    if(running || stopped)return;running=true;
    try {
      await flush();
      await recover();
      const agents=db.prepare("SELECT agent_id FROM agents WHERE publish_status='published'").all();
      for(const agent of agents){
        if(stopped)break;
        try {
          if(!dispatcher.getAgentDeliveryStatus?.(agent.agent_id)?.automaticDeliveryReady)continue;
          const queue=await api(agent.agent_id,'','executionQueue',{});
          const job=queue.jobs.find(job=>!db.prepare('SELECT id FROM project_execution_outbox WHERE id=?').get(job.id));
          if(job)await execute(agent,job);
        } catch { /* A stale or unavailable Agent must not starve other Agents. Keep its durable outbox. */ }
      }
      await flush();
    } catch { /* Unavailable server/old deployment: retain outbox; no task replay. */ }
    finally {running=false;}
  }
  function start() {
    db.prepare("UPDATE project_execution_outbox SET state='result',payload=? WHERE state IN ('claiming','running')").run(JSON.stringify({status:'unknown',result:'本地运行端重启，本次执行结果待确认，未自动重试。'}));
    const loop=async()=>{await tick();if(!stopped){timer=setTimeout(loop,5000);timer.unref?.();}};void loop();
    return ()=>{stopped=true;clearTimeout(timer);};
  }
  return { start, tick };
}
module.exports={createProjectWorker};
