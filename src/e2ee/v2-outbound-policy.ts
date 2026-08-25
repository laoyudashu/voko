const audit = require('../core/audit');
const safetyClassifier = require('../core/safety-classifier');
const { stripStateBlock } = require('../core/dispatcher/parse-state');
const { logEvent } = require('../core/event-log');
const { t, systemMessagePrefix } = require('../core/i18n');

type ReviewInput = {
  db:any;
  databaseAPI:any;
  enqueueIntervention?:(record:any)=>void;
  agentId:string;
  channelId:string;
  content:string;
  messageId:string;
};

function visitorLocale(db:any,channelId:string):'zh'|'en' {
  try {
    const locale=String(db.prepare('SELECT locale FROM user_cache WHERE uid=? LIMIT 1').get(channelId)?.locale||'').toLowerCase();
    if(locale==='en')return'en';
  } catch {}
  return'zh';
}

/** Apply the same outbound safety policy before an Agent reply becomes wire ciphertext. */
export async function reviewE2eeOutboundReply(input:ReviewInput):Promise<string> {
  const visible=String(stripStateBlock(String(input.content||''))||'').trim();
  if(!visible)throw new Error('E2EE_V2_PROVIDER_EMPTY_REPLY');
  let decision=audit.checkAuditRules(visible,'outbound',input.db);
  if(decision.verdict==='uncertain'||decision.action==='soft_deny'){
    decision=await safetyClassifier.classifyUncertain(input.db,visible,'outbound',decision);
  }
  if(decision.action==='hard_deny'||decision.action==='soft_deny'){
    logEvent('audit.hit',{level:'warn',agentId:input.agentId,visitorId:input.channelId,messageId:input.messageId,
      data:{ruleId:decision.matchedKeyword||decision.reasonCode,direction:'outbound',action:decision.action,e2ee:true}});
    if(input.databaseAPI){
      audit.triggerManualSendAuditIntervention({agentId:input.agentId,channelId:input.channelId},decision,
        input.db,input.databaseAPI,input.enqueueIntervention);
    }
  }
  if(decision.action!=='hard_deny')return visible;
  const locale=visitorLocale(input.db,input.channelId);
  return systemMessagePrefix(locale)+t('visitor.reply_sensitive',{},locale);
}

module.exports={reviewE2eeOutboundReply};
