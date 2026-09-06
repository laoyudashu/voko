const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {randomUUID}=require('node:crypto');
const vm=require('node:vm');
const {createRequire}=require('node:module');
const entry=require.resolve('../build/core/process-lifecycle');
function load(spawnResult){
  const mod={exports:{}};
  const localRequire=createRequire(entry);
  vm.runInNewContext(fs.readFileSync(entry,'utf8'),{
    exports:mod.exports,module:mod,require:id=>id==='child_process'?{spawnSync:()=>spawnResult}:localRequire(id),
    process:{platform:'win32',pid:process.pid},Buffer,console,setTimeout,clearTimeout,
  },{filename:entry});
  return mod.exports;
}
const failures=[
  ['timeout',{status:null,error:Object.assign(new Error('private diagnostic'),{code:'ETIMEDOUT'}),stdout:''}],
  ['query error',{status:1,stderr:'private diagnostic',stdout:''}],
  ['malformed response',{status:0,stdout:'not JSON private diagnostic'}],
];
for(const [name,result] of failures){
  test(`Windows ${name} is unknown, never proof that a process exited`,async()=>{
    const lifecycle=load(result);
    assert.throws(()=>lifecycle.inspectProcess(4242),e=>e.code==='PROCESS_INSPECTION_FAILED'&&!e.message.includes('private diagnostic'));
    await assert.rejects(lifecycle.waitForProcessExit(4242,0),{code:'PROCESS_INSPECTION_FAILED'});
    await assert.rejects(lifecycle.terminateInstance({pid:4242}),{code:'PROCESS_INSPECTION_FAILED'});
  });
  test(`Windows ${name} preserves an existing instance lock`,async()=>{
    const lifecycle=load(result);
    const root=path.join(os.tmpdir(),'voko-inspection-'+randomUUID());
    const db=path.join(root,'voko.db');
    const paths=lifecycle._test.getRuntimePaths(db);
    const owner={version:1,pid:4242,creationId:'existing',instanceId:'existing-instance',entryPath:entry};
    fs.mkdirSync(paths.lockDir,{recursive:true});
    fs.writeFileSync(paths.ownerFile,JSON.stringify(owner));
    try{
      let failure;
      try{await lifecycle.acquireInstanceLock(db,entry,{securePath:()=>{}});}catch(error){failure=error;}
      assert.equal(fs.readFileSync(paths.ownerFile,'utf8'),JSON.stringify(owner));
      assert.equal(failure?.code,'PROCESS_INSPECTION_FAILED');
    }finally{fs.rmSync(root,{recursive:true,force:true});}
  });
  test(`Windows batch ${name} cannot silently omit live workers`,()=>{
    assert.throws(()=>load(result).registerWorkers('unused.db',{},[{worker:{pid:4242}}]),{code:'PROCESS_INSPECTION_FAILED'});
  });
}
test('Windows successful empty query still means absent',()=>{
  assert.equal(load({status:0,stdout:''}).inspectProcess(4242),null);
});
test('Windows successful process query preserves PID reuse evidence',()=>{
  const identity={pid:4242,parentPid:2,creationId:'123',executablePath:'C:\\node.exe',commandLine:'C:\\node.exe C:\\voko\\index.js'};
  const actual=load({status:0,stdout:JSON.stringify(identity)}).inspectProcess(4242);
  assert.equal(JSON.stringify(actual),JSON.stringify(identity));
});
