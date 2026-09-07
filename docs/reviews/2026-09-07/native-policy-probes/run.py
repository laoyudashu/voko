import importlib.util,json,concurrent.futures,base64,hashlib,time
from pathlib import Path
p=importlib.util.spec_from_file_location('h','artifacts/three-host-20260905/host.py');h=importlib.util.module_from_spec(p);p.loader.exec_module(h)
root=Path('artifacts/provider-policy-complete-20260907');archive=Path('/tmp/voko-provider-policy-complete.tgz').read_bytes();catalog=json.loads((root/'catalog.json').read_text())
archive_hash=hashlib.sha256(archive).hexdigest()
refs={host:json.loads((root.parent/'three-host-20260905'/(host+'-baseline.json')).read_text())['dbPath'] for host in ['macos','linux','windows']}
def encoded(js):return "eval(Buffer.from('"+base64.b64encode(js.encode()).decode()+"','base64').toString())"
def run(host):
 deps=str(Path.cwd()/'node_modules') if host=='macos' else (str(Path(h.ENTRY[host]).parent.parent/'node_modules') if host!='windows' else h.ENTRY[host].rsplit('\\build\\',1)[0]+'\\node_modules')
 js="const fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process');const root=fs.mkdtempSync(path.join(os.homedir(),'.voko-policy-run-'));const file=path.join(root,'probe.tgz');fs.writeFileSync(file,fs.readFileSync(0));cp.execFileSync('tar',['-xzf',file,'-C',root]);fs.unlinkSync(file);fs.symlinkSync("+json.dumps(deps)+",path.join(root,'node_modules'),'junction');console.log(JSON.stringify({root,node:process.version,platform:process.platform}));"
 try:
  runtime=json.loads(h.run(host,[h.NODE[host],'-e',encoded(js)],timeout=60,input=archive));runtime['archiveSha256']=archive_hash
  (root/(host+'-runtime.json')).write_text(json.dumps(runtime,indent=2));print(json.dumps({'host':host,'prepared':True}),flush=True)
 except Exception as e:print(json.dumps({'host':host,'prepareError':type(e).__name__}),flush=True);return
 # Same configuration/real-child-process regression on all OSes.
 testfile=runtime['root']+'/test/provider-native-policy-matrix.test.js'
 try:
  output=h.run(host,[h.NODE[host],'--test',testfile],timeout=150)
  (root/(host+'-regression.log')).write_text(output)
  print(json.dumps({'host':host,'regression':'passed'}),flush=True)
 except Exception as e:
  (root/(host+'-regression.log')).write_text(str(e));print(json.dumps({'host':host,'regression':'failed'}),flush=True)
 worker=runtime['root']+'/artifacts/provider-policy-complete-20260907/probe.cjs'
 for item in catalog:
  transport=item['id'];modes=['default']
  if any(c['editable'] and c['kind']=='enum' and len(c.get('values',[]))>1 for c in item['controls']):modes.append('native')
  for mode in modes:
   target=root/(host+'-'+transport+'-'+mode+'.json')
   try:
    d=json.loads(h.run(host,[h.NODE[host],worker,runtime['root'],transport,'',refs[host],mode],timeout=85))
   except Exception as e:d={'transportId':transport,'mode':mode,'status':'HARNESS_OR_CONNECTION_ERROR','errorType':type(e).__name__}
   d['host']=host;d['archiveSha256']=archive_hash;target.write_text(json.dumps(d,ensure_ascii=False,indent=2))
   print(json.dumps({'host':host,'transport':transport,'mode':mode,'status':d['status'],'observations':d.get('observations')}),flush=True)
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as ex:
 for f in [ex.submit(run,hst) for hst in ['macos','linux','windows']]:
  try:f.result()
  except Exception as e:print(json.dumps({'runnerError':type(e).__name__}),flush=True)
