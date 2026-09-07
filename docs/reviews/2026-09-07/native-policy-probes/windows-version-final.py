import importlib.util,json,base64
from pathlib import Path
p=importlib.util.spec_from_file_location('h','artifacts/three-host-20260905/host.py');h=importlib.util.module_from_spec(p);p.loader.exec_module(h)
r=Path('artifacts/provider-policy-complete-20260907');d=json.loads((r/'windows-final-v3-runtime.json').read_text());js='const c=require('+json.dumps(d['root']+'/build/core/dispatcher/provider-catalog')+');console.log(JSON.stringify(["cursor-cli","github-copilot-cli"].map(id=>({id,version:c.instantiateProviderTransport(c.listProviderTransports().find(t=>t.id===id),{}).getProviderVersion()}))));'
expr="eval(Buffer.from('"+base64.b64encode(js.encode()).decode()+"','base64').toString())";out=h.run('windows',[h.NODE['windows'],'-e',expr],timeout=45);rows=json.loads(out);(r/'windows-version-final.json').write_text(json.dumps({'archiveSha256':d['archiveSha256'],'rows':rows},indent=2));print(out)
