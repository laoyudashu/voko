import importlib.util,json,base64
from pathlib import Path
p=importlib.util.spec_from_file_location('h','artifacts/three-host-20260905/host.py');h=importlib.util.module_from_spec(p);p.loader.exec_module(h)
r=Path('artifacts/provider-policy-complete-20260907');runtime=json.loads((r/'windows-runtime.json').read_text());ref=json.loads((r.parent/'three-host-20260905/windows-baseline.json').read_text())['dbPath'];worker=runtime['root']+'/artifacts/provider-policy-complete-20260907/probe.cjs'
for item in json.loads((r/'catalog.json').read_text()):
 modes=['default']
 if any(c['editable'] and c['kind']=='enum' and len(c.get('values',[]))>1 for c in item['controls']):modes.append('native')
 for mode in modes:
  argv=[h.NODE['windows'],worker,runtime['root'],item['id'],'',ref,mode]
  js='process.argv='+json.dumps(argv)+';require('+json.dumps(worker)+');'
  expr="eval(Buffer.from('"+base64.b64encode(js.encode()).decode()+"','base64').toString())"
  try:d=json.loads(h.run('windows',[h.NODE['windows'],'-e',expr],timeout=85))
  except Exception as e:d={'transportId':item['id'],'mode':mode,'status':'HARNESS_OR_CONNECTION_ERROR','errorType':type(e).__name__}
  d['host']='windows';d['archiveSha256']=runtime['archiveSha256'];(r/('windows-'+item['id']+'-'+mode+'-v2.json')).write_text(json.dumps(d,ensure_ascii=False,indent=2));print(json.dumps({'host':'windows','transport':item['id'],'mode':mode,'status':d['status'],'observations':d.get('observations')}),flush=True)
