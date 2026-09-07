import importlib.util,json,base64
from pathlib import Path
p=importlib.util.spec_from_file_location('h','artifacts/three-host-20260905/host.py');h=importlib.util.module_from_spec(p);p.loader.exec_module(h)
r=Path('artifacts/provider-policy-complete-20260907');d=json.loads((r/'linux-final-v2-runtime.json').read_text());worker=d['root']+'/probe.cjs';ref=json.loads((r.parent/'three-host-20260905/linux-baseline.json').read_text())['dbPath']
def run(js,timeout=85):return h.run('linux',[h.NODE['linux'],'-e',"eval(Buffer.from('"+base64.b64encode(js.encode()).decode()+"','base64').toString())"],timeout=timeout)
run('require("fs").writeFileSync('+json.dumps(worker)+',Buffer.from('+json.dumps(base64.b64encode((r/'probe.cjs').read_bytes()).decode())+',"base64"));')
argv=[h.NODE['linux'],worker,d['root'],'deepseek-harness-cli','',ref,'default']
out=json.loads(run('process.argv='+json.dumps(argv)+';require('+json.dumps(worker)+');'));out['host']='linux';out['archiveSha256']=d['archiveSha256'];(r/'linux-deepseek-harness-cli-default-final.json').write_text(json.dumps(out,ensure_ascii=False,indent=2));print(out['status'])
