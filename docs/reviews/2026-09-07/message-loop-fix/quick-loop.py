import sys,json,time
from pathlib import Path
import importlib.util
p=importlib.util.spec_from_file_location('host','artifacts/three-host-20260905/host.py');h=importlib.util.module_from_spec(p);p.loader.exec_module(h)
run=h.run;cli=h.cli;NODE=h.NODE;ENTRY=h.ENTRY;ROOT=Path('artifacts/deploy-b26db4d-20260907')
def save(name,obj): (ROOT/name).write_text(json.dumps(obj,ensure_ascii=False,indent=2))
senderHost,targetHost,senderName,targetName,transport=sys.argv[1:]
def agent(h,name): return next(a for a in json.loads((ROOT/(h+'-agents.json')).read_text()) if a['agentName']==name)
sender,target=agent(senderHost,senderName),agent(targetHost,targetName)
marker='VOKO-DEPLOY-b26db4d-20260907-'+targetHost+'-'+str(time.time_ns())
content='VOKO 三端部署快速检测 '+marker+'。这是无工具的连通性测试，请仅回复一句收到并包含此标记，不调用工具或执行其他工作。'
args={'agentId':sender['agentId'],'toUid':target['imUid'],'channelType':1,'content':content}
def mcp(name,args):
 request={'jsonrpc':'2.0','id':1,'method':'tools/call','params':{'name':'voko_'+name,'arguments':args}}
 raw=run(senderHost,[NODE[senderHost],ENTRY[senderHost],'mcp'],60,input=(json.dumps(request)+'\n').encode())
 for line in raw.splitlines():
  try:
   r=json.loads(line)
   if r.get('id')==1:
    if 'error' in r: return r
    text=next(x['text'] for x in r['result']['content'] if x.get('type')=='text')
    return json.loads(text)
  except (ValueError,StopIteration): pass
 raise RuntimeError('Missing MCP response')
def call(name,args):
 if transport=='mcp': return mcp(name,args)
 argv=[name]
 for k,v in args.items(): argv.extend(['--'+k,str(v)])
 return cli(senderHost,argv,60)
r=call('send_message',args)
record={'senderHost':senderHost,'targetHost':targetHost,'senderAgentId':sender['agentId'],'targetAgentId':target['agentId'],'targetName':targetName,'senderUid':sender['imUid'],'targetUid':target['imUid'],'transport':transport,'marker':marker,'sentAt':time.time(),'send':{k:r.get(k) for k in ['success','messageId','conversationId','securityMode','deliveryState','error','code']},'polls':[]}
filename='loop-'+targetHost+'-'+str(int(record['sentAt']))+'.json'
save(filename,record);print('SEND',json.dumps(record['send']),flush=True)
if not r.get('success') or not r.get('messageId'):
 record['completed']=False;record['finishedAt']=time.time();record['failureStage']='send';save(filename,record);raise SystemExit(2)
deadline=time.time()+200
while time.time()<deadline:
 result=call('get_message_result',{'agentId':sender['agentId'],'messageId':r['messageId']})
 safe={k:result.get(k) for k in ['success','messageId','securityMode','transport','execution','reply','error','code']}
 # The result contract contains only state metadata; exclude any future content additions.
 for k in ['execution','reply','transport']:
  if isinstance(safe.get(k),dict): safe[k]={x:y for x,y in safe[k].items() if x in ['state','phase','reasonCode','provider','mode','source','updatedAt','code','messageId','count','status','providerOutcome','deliveryState']}
 record['polls'].append(safe);save(filename,record)
 state=(result.get('execution') or {}).get('state');reply=(result.get('reply') or {}).get('state')
 print('RESULT',targetHost,state,reply,(result.get('execution') or {}).get('reasonCode'),flush=True)
 if (state=='COMPLETED' and reply=='DELIVERED') or state in ['FAILED','AUTH_REQUIRED','DELIVERY_UNKNOWN'] or (result.get('transport') or {}).get('state') in ['FAILED','UNKNOWN']: break
 time.sleep(5)
record['completed']=state=='COMPLETED' and reply=='DELIVERED';record['finishedAt']=time.time();save(filename,record)
raise SystemExit(0 if record['completed'] else 2)
