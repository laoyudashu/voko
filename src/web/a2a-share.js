'use strict';
const {serverAgentIdFromDid}=require('../core/agent-invitations');
const {jsonForInlineScript}=require('./html-security');

function renderA2AShare({agent, row, enabled, baseUrl, t, esc}) {
  const id=encodeURIComponent(agent.agentId);
  const reason=!enabled?'share_disabled':row?.publish_status!=='published'?'verify_not_published':Number(agent.visibilityType)===2?'share_hidden':null;
  const heading='<style>#a2a-share [hidden]{display:none!important}#a2a-share button.is-copied{color:#168447;background:#edf9f1}</style><section class="card a2a-section" id="a2a-share"><h2 class="a2a-section-title">'+esc(t('web.agent.caps.share_title'))+'</h2><p class="meta">'+esc(t('web.agent.caps.share_hint'))+'</p>';
  if(reason)return heading+'<p role="status">'+esc(t('web.agent.caps.'+reason))+'</p><a href="'+(reason==='share_hidden'?'/agents/'+id+'/visibility':'/')+'">'+esc(t(reason==='share_hidden'?'web.agent.op.visibility':'common.nav.home'))+'</a></section>';
  const publicId=serverAgentIdFromDid(row.did)||agent.agentId;
  const url=String(baseUrl).replace(/\/+$/,'')+'/a2a/agents/'+encodeURIComponent(publicId)+'/.well-known/agent-card.json';
  return heading+'<p id="a2a-share-status" role="status">'+esc(t('web.agent.caps.verifying'))+'</p><div id="a2a-share-ready" hidden><code style="display:block;overflow-wrap:anywhere;white-space:normal;padding:10px;background:#f7f9fc;border-radius:6px">'+esc(url)+'</code><div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:12px"><button type="button" data-voko-copy-restore-label="true" data-voko-copy-value="'+esc(url)+'">'+esc(t('web.agent.caps.share_copy'))+'</button><a class="btn btn-outline" href="'+esc(url)+'" target="_blank" rel="noopener noreferrer">'+esc(t('web.agent.caps.share_view'))+'</a></div></div><button type="button" id="a2a-share-retry" hidden>'+esc(t('web.agent.caps.verify_card'))+'</button></section><script>(function(){var status=document.getElementById("a2a-share-status"),ready=document.getElementById("a2a-share-ready"),retry=document.getElementById("a2a-share-retry");async function verify(){retry.hidden=true;ready.hidden=true;status.textContent='+jsonForInlineScript(t('web.agent.caps.verifying'))+';try{var response=await fetch('+jsonForInlineScript('/agents/'+id+'/caps/verify-a2a-card')+',{headers:{Accept:"application/json"}});var result=await response.json();if(!response.ok||!result.success)throw new Error(result.error||'+jsonForInlineScript(t('web.agent.caps.verify_failed'))+');status.textContent=result.message;ready.hidden=false}catch(error){status.textContent=error.message||'+jsonForInlineScript(t('web.agent.caps.verify_failed'))+';retry.hidden=false}}retry.onclick=verify;verify()})();</script>';
}
module.exports={renderA2AShare};
