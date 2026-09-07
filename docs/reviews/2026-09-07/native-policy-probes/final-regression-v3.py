import importlib.util,json,base64,concurrent.futures,hashlib
from pathlib import Path
p=importlib.util.spec_from_file_location('h','artifacts/three-host-20260905/host.py');h=importlib.util.module_from_spec(p);p.loader.exec_module(h)
r=Path('artifacts/provider-policy-complete-20260907');archive=Path('/tmp/voko-provider-policy-final-regression.tgz').read_bytes()
def run(host):
 deps=str(Path.cwd()/'node_modules') if host=='macos' else (str(Path(h.ENTRY[host]).parent.parent/'node_modules') if host!='windows' else h.ENTRY[host].rsplit('\\build\\',1)[0]+'\\node_modules')
 js="const fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process');const root=fs.mkdtempSync(path.join(os.homedir(),'.voko-policy-regression-'));const file=path.join(root,'regression.tgz');fs.writeFileSync(file,fs.readFileSync(0));cp.execFileSync('tar',['-xzf',file,'-C',root]);fs.unlinkSync(file);fs.symlinkSync("+json.dumps(deps)+",path.join(root,'node_modules'),'junction');console.log(JSON.stringify({root,node:process.version,platform:process.platform}));"
 expr="eval(Buffer.from('"+base64.b64encode(js.encode()).decode()+"','base64').toString())"
 d=json.loads(h.run(host,[h.NODE[host],'-e',expr],timeout=75,input=archive));d['archiveSha256']=hashlib.sha256(archive).hexdigest();(r/(host+'-final-v3-runtime.json')).write_text(json.dumps(d,indent=2))
 try:
  out=h.run(host,[h.NODE[host],'--test',d['root']+'/test/provider-native-policy-matrix.test.js'],timeout=150);(r/(host+'-final-v3-regression.log')).write_text(out);d['status']='passed'
 except Exception as e:(r/(host+'-final-v3-regression.log')).write_text(str(e));d['status']='failed'
 (r/(host+'-final-v3-runtime.json')).write_text(json.dumps(d,indent=2));print(json.dumps({'host':host,'status':d['status']}),flush=True)
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as ex:
 for f in [ex.submit(run,host) for host in ['macos','linux','windows']]:
  try:f.result()
  except Exception as e:print(json.dumps({'errorType':type(e).__name__}),flush=True)
