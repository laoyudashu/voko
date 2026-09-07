import subprocess,base64,shlex,json,os
from pathlib import Path
ROOT=Path(__file__).resolve().parent
NODE={'macos':'/Users/laoyu/.hermes/node/bin/node','linux':'/home/tjyu/.local/node-v22.22.3-linux-arm64/bin/node','windows':r'C:\Users\laoyu\AppData\Local\Programs\nodejs\node.exe'}
ENTRY={'macos':'/Users/laoyu/.local/lib/node_modules/@voko/lite/build/index.js','linux':'/home/tjyu/.local/node-v22.22.3-linux-arm64/lib/node_modules/@voko/lite/build/index.js','windows':r'C:\Users\laoyu\AppData\Local\Programs\nodejs\node_modules\@voko\lite\build\index.js'}
SSH={'linux':['ssh','-o','BatchMode=yes','-o','LogLevel=ERROR','-o','ConnectTimeout=10','-i','/Users/laoyu/.ssh/voko_ubuntu_ed25519','tjyu@192.168.64.2'],'windows':['ssh','-o','BatchMode=yes','-o','LogLevel=ERROR','-o','ConnectTimeout=10','voko-windows']}
def run(host,args,timeout=90,input=None):
 if host=='macos': cmd=args
 elif host=='linux':
  env='export PATH=/home/tjyu/.local/node-v22.22.3-linux-arm64/bin:/home/tjyu/.hermes/hermes-agent/venv/bin:/home/tjyu/.hermes/node/bin:/home/tjyu/.local/bin:/home/tjyu/.hermes/bin:$PATH; export XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus; '
  cmd=SSH[host]+['bash -lc '+shlex.quote(env+'exec '+shlex.join(args))]
 else:
  def q(x): return "'"+str(x).replace("'","''")+"'"
  s="$ProgressPreference='SilentlyContinue'; $env:NODE_NO_WARNINGS='1'; & "+' '.join(q(x) for x in args)+"; exit $LASTEXITCODE"
  cmd=SSH[host]+['powershell.exe','-NoProfile','-NonInteractive','-EncodedCommand',base64.b64encode(s.encode('utf-16le')).decode()]
 r=subprocess.run(cmd,input=input,capture_output=True,timeout=timeout,env={**os.environ,'NODE_NO_WARNINGS':'1'})
 out=r.stdout.decode('utf8','replace')
 if r.returncode: raise RuntimeError(host+' exit '+str(r.returncode)+' '+(r.stderr.decode('utf8','replace') or out)[-700:])
 return out
def cli(host,args,timeout=90): return json.loads(run(host,[NODE[host],ENTRY[host],*args],timeout))
def save(name,obj): (ROOT/name).write_text(json.dumps(obj,ensure_ascii=False,indent=2))
def brief(d):
 o={k:d.get(k) for k in ['runtimeState','version','pid','port','buildDigest','runtimeBuildDigest','buildMismatch','dbPath','schemaVersion','instanceId','startedAt']}
 o['agents']=[{k:a.get(k) for k in ['agentId','agentName','imConnected','automaticDeliveryReady','activeAutomaticMode']} for a in d.get('agents',[])]
 return o
