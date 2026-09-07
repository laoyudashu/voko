import json,tempfile,types,sys
from pathlib import Path
source=Path('artifacts/deploy-b26db4d-20260907/quick-loop.py').read_text()
start=source.index('import importlib.util');end=source.index('def save(name,obj):')
for scenario in ['immediate_failure','transport_failure']:
 with tempfile.TemporaryDirectory(prefix='voko-probe-result-') as directory:
  root=Path(directory)
  (root/'linux-agents.json').write_text(json.dumps([{'agentName':'sender','agentId':'a','imUid':'a-im'}]))
  (root/'macos-agents.json').write_text(json.dumps([{'agentName':'target','agentId':'b','imUid':'b-im'}]))
  calls=[]
  def cli(host,args,timeout):
   calls.append(args[0])
   if args[0]=='send_message':return {'success':scenario!='immediate_failure','messageId':'synthetic-message','error':'PEER_NOT_FOUND' if scenario=='immediate_failure' else None}
   return {'success':True,'transport':{'state':'FAILED'},'execution':{'state':'UNCONFIRMED'},'reply':{'state':'PENDING'}}
  modified=source[:start]+"ROOT=Path("+repr(directory)+")\n"+source[end:]
  previous=sys.argv;sys.argv=['probe','linux','macos','sender','target','cli']
  try:
   exec(compile(modified,'probe','exec'),{'cli':cli})
  except SystemExit as e:assert e.code==2
  finally:sys.argv=previous
  assert calls==(['send_message'] if scenario=='immediate_failure' else ['send_message','get_message_result']),calls
  result=json.loads(next(root.glob('loop-*.json')).read_text());assert result['completed'] is False
  if scenario=='transport_failure':assert result['polls'][0]['transport']['state']=='FAILED'
  print(scenario,'PASS')
