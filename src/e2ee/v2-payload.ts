export const E2EE_V2_PAYLOAD_VERSION='voko.e2ee.payload/1';

export function normalizeE2eeRouteContext(value:unknown):Record<string,unknown>|undefined{
  if(value===undefined||value===null)return undefined;
  if(!value||typeof value!=='object'||Array.isArray(value)||(value as any).protocolVersion!==1){
    throw new Error('E2EE_V2_ROUTE_CONTEXT_INVALID');
  }
  const row=JSON.parse(JSON.stringify(value));
  const routeId=(candidate:unknown)=>typeof candidate==='string'&&candidate.length>=24&&candidate.length<=128
    &&/^[A-Za-z0-9_-]+$/.test(candidate);
  const conversationKey=(candidate:unknown)=>typeof candidate==='string'&&candidate.length>0&&candidate.length<=192;
  for(const key of ['routeId','replyToRouteId'])if(row[key]!==undefined&&!routeId(row[key])){
    throw new Error('E2EE_V2_ROUTE_CONTEXT_INVALID');
  }
  for(const key of ['conversationKey','canonicalConversationKey'])if(row[key]!==undefined&&!conversationKey(row[key])){
    throw new Error('E2EE_V2_ROUTE_CONTEXT_INVALID');
  }
  if(row.conversationStart!==undefined&&typeof row.conversationStart!=='boolean'){
    throw new Error('E2EE_V2_ROUTE_CONTEXT_INVALID');
  }
  if(row.conversationDisposition!==undefined&&!['created','reused'].includes(row.conversationDisposition)){
    throw new Error('E2EE_V2_ROUTE_CONTEXT_INVALID');
  }
  if(Buffer.byteLength(JSON.stringify(row))>4096)throw new Error('E2EE_V2_ROUTE_CONTEXT_INVALID');
  return row;
}

export function encodeE2eeTextPayload(text:string,routeContext?:unknown):string{
  const route=normalizeE2eeRouteContext(routeContext);
  return JSON.stringify({version:E2EE_V2_PAYLOAD_VERSION,kind:'text',text,...(route?{routeContext:route}:{})});
}

export function encodeE2eeAttachmentPayload(attachment:unknown,routeContext?:unknown):string{
  if(!attachment||typeof attachment!=='object'||Array.isArray(attachment))throw new Error('E2EE_V2_PAYLOAD_INVALID');
  const route=normalizeE2eeRouteContext(routeContext);
  return JSON.stringify({version:E2EE_V2_PAYLOAD_VERSION,kind:'attachment_manifest',attachment,
    ...(route?{routeContext:route}:{})});
}

export function decodeE2eePayload(plaintext:string):{
  structured:boolean;kind:'text'|'attachment_manifest'|null;text?:string;attachment?:unknown;
  caption?:string;routeContext?:Record<string,unknown>;
}{
  let payload:any=null;
  try{payload=JSON.parse(plaintext);}catch{}
  if(payload?.version!==E2EE_V2_PAYLOAD_VERSION||!['text','attachment_manifest'].includes(payload?.kind)){
    return{structured:false,kind:null};
  }
  const routeContext=normalizeE2eeRouteContext(payload.routeContext);
  if(payload.kind==='text'){
    if(typeof payload.text!=='string')throw new Error('E2EE_V2_PAYLOAD_INVALID');
    return{structured:true,kind:'text',text:payload.text,routeContext};
  }
  if(!payload.attachment||typeof payload.attachment!=='object'||Array.isArray(payload.attachment)){
    throw new Error('E2EE_V2_PAYLOAD_INVALID');
  }
  if(payload.caption!==undefined&&(typeof payload.caption!=='string'||Buffer.byteLength(payload.caption)>128*1024)){
    throw new Error('E2EE_V2_PAYLOAD_INVALID');
  }
  return{structured:true,kind:'attachment_manifest',attachment:payload.attachment,
    caption:payload.caption||'',routeContext};
}
