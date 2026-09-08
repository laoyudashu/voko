'use strict';
const { createProjectClient } = require('../core/project-client');
const projectStyle = require('./project-style');
const { jsonForInlineScript } = require('./html-security');

function mountProjectRoutes(router, db, renderPage, client = createProjectClient(db), navigation) {
  const base = '/agents/:agentId/g/:channelId/project';
  router.get(base, async (req, res) => {
    const target = '/agents/' + encodeURIComponent(req.params.agentId) + '/g/' + encodeURIComponent(req.params.channelId);
    res.redirect(target + '?tab=plans');
  });
  const respond = action => async (req, res) => {
    const result = await client(req.params.agentId, req.params.channelId, action || req.params.action, req.body || {});
    res.set('Cache-Control', 'no-store').status(result.status).json(result.body);
  };
  router.get(base + '/state', respond('get'));
  router.get(base + '/storage', respond('storageGet'));
  router.post(base + '/action/:action', respond());
}
function renderProjectFragment(req, members = []) {
  const labels = Object.fromEntries(keys.map(key => [key, req.t('web.project.' + key)]));
  const base = '/agents/' + encodeURIComponent(req.params.agentId) + '/g/' + encodeURIComponent(req.params.channelId) + '/project';
  return '<style>'+projectStyle+'</style><section id="project"><div id="project-content"></div></section><script>('+projectBrowser.toString()+')('+jsonForInlineScript(labels)+','+jsonForInlineScript({base,embedded:true,memberNames:Object.fromEntries(members.map(m => [m.uid,m.name || m.nickname || m.uid]))})+');</script>';
}

const keys = ['error_PROJECT_TASK_OWNER_REQUIRED', 'error_PROJECT_EXECUTOR_NOT_AGENT', 'error_PROJECT_EXECUTION_ACTIVE', 'error_PROJECT_TASK_CLOSED', 'error_PROJECT_STORAGE_NOT_CONFIGURED', 'error_PROJECT_EXECUTION_NOT_UNCERTAIN', 'error_PROJECT_EXECUTION_CANNOT_CANCEL', 'error_PROJECT_ASSET_SIZE', 'error_PROJECT_ASSET_UPLOAD_UNCONFIRMED', 'error_PROJECT_STORAGE_HAS_ASSETS', 'error_PROJECT_ASSET_UPLOAD_FAILED', 'error_PROJECT_TASK_MESSAGE_LIMIT', 'error_PROJECT_EXECUTION_LIMIT'].concat(['resolveExecution','resolveEvidence','resultDraft','fromMessage','cancelled', 'backTasks', 'sharedTask', 'reopen', 'complete', 'taskMessage', 'sendMessage', 'dispatch', 'executor', 'chooseAgent', 'workInstruction', 'executions', 'cancelExecution', 'download', 'upload', 'uploadPending', 'emptyAssets', 'run_queued', 'run_working', 'run_unknown', 'run_succeeded', 'run_failed', 'run_input_required', 'run_cancelled'].concat(['title','chat','plans','activity','tasks','assets','members','settings','enable','disabled','loading','todo','doing','done','add','edit','archive','save','cancel','name','description','assignee','due','unassigned','notice','instructions','active','paused','status','unavailableTasks','unavailableAssets','empty','error','conflict','unknown','refresh','truncated','workspace','overview','planHint','memberHint','settingsHint','emptyPlan','enableTitle','soon','owner','admin','member','eventEnabled','eventUpdated','eventCreated','eventEdited','eventMoved','eventArchived','unavailableProject','eventProjectCreated', 'cloudSpace','configureStorage','manageStorage','storageHint','storageAdminHint','storageConnected','storageNotConfigured','storagePendingAssets','qiniu','bucket','bucketHint','region','endpoint','accessKey','secretKey','keyHint','keepKeys','verifySave','verifying','storageVerified','storageReadOnlyCheck','storageKeyMissing','storageLoadError','storageConfigTitle','storagePrivacy','regionEast1','regionEast2','regionNorth','regionSouth','regionUS','regionSingapore','regionHanoi','regionHCM','storageErrorAuth','storageErrorBucket','storageErrorConflict','storageErrorKeys','storageErrorInUse','storageErrorConnection','storageErrorConfig','storageErrorCredentials']));

function projectBrowser(L, options = {}) {
  let root = document.getElementById('project-content');
  const alert = document.getElementById('project-alert');
  const base = options.base || location.pathname.replace(/\/$/, '');
  let snapshot, tab = new URL(location.href).searchParams.get('tab') || 'plans', busy = false, dialog = null;
  let selectedTask = new URL(location.href).searchParams.get('task'), taskData = null; const drafts = new Map(), mutationIds = new Map();
  let storageState, storageLoading = false, storageOpen = false, storageGeneration = 0;
  function el(tag, text, parent, attrs = {}) {
    const node = document.createElement(tag); if (text != null) node.textContent = text;
    Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value));
    if (parent) parent.appendChild(node); return node;
  }
  function button(text, parent, click, disabled = false) {
    const node = el('button', text, parent, { type: 'button' }); node.disabled = disabled; node.onclick = click; return node;
  }
  function close() { if (dialog) { dialog.remove(); dialog = null; } }
  async function request(action, body = {}) {
    if (busy) return false;
    const {expected_revision:_revision,client_request_id:_request,...mutationBody}=body;const mutationKey=JSON.stringify([action,mutationBody]);if(body.client_request_id){if(mutationIds.has(mutationKey))body.client_request_id=mutationIds.get(mutationKey);else mutationIds.set(mutationKey,body.client_request_id);}
    busy = true; alert.textContent = '';
    try {
      const response = await fetch(base + (action ? '/action/' + action : '/state'), {
        method: action ? 'POST' : 'GET', cache: 'no-store', redirect: 'error',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        ...(action ? { body: JSON.stringify(body) } : {})
      });
      const result = await response.json();
      if (!response.ok || !result.success) {
        if ([401,403,404].includes(response.status)) { snapshot = null; close(); document.querySelectorAll('[data-project-event]').forEach(node => node.remove()); document.querySelectorAll('#project-content,#project-settings').forEach(node => { node.replaceChildren(); delete node.dataset.dirty; }); }
        const err = new Error(result.code || 'PROJECT_UNAVAILABLE'); err.status = response.status; throw err;
      }
      if (result.data.task) { taskData = result.data; const state = await fetch(base+'/state',{cache:'no-store'}); const fresh=await state.json(); if (!state.ok || !fresh.success) throw new Error(fresh.code || 'PROJECT_UNAVAILABLE'); snapshot=fresh.data; } else snapshot = result.data;
      if (selectedTask && !result.data.task) {const id=selectedTask;const detail=await storageRequest('taskGet',{id});if(selectedTask===id)taskData=detail;}
      if (action === 'update') { const settingsRoot = document.getElementById('project-settings'); if (settingsRoot) delete settingsRoot.dataset.dirty; }
      renderEvents();
      if (action) close();
      mutationIds.delete(mutationKey);render(); return true;
    } catch (error) {
      alert.textContent = (L['error_'+error.message] || (error.message === 'PROJECT_CONFLICT' ? L.conflict : action && (!error.status || error.status >= 500 || error.message === 'PROJECT_TIMEOUT') ? L.unknown : L.error)) + ' (' + error.message + ')';
      return false;
    } finally { busy = false; }
  }
  function revision() { return tab === 'tasks' && taskData?.project_revision != null ? taskData.project_revision : snapshot.project.row_version; }
  function field(parent, label, value, type = 'text') {
    const wrap = el('label', label, parent), node = el(type === 'textarea' ? 'textarea' : 'input', null, wrap);
    if (type !== 'textarea') node.type = type;
    node.value = value || ''; return node;
  }
  function select(parent, label, values, current) {
    const wrap = el('label', label, parent), node = el('select', null, wrap, {'aria-label':label});
    values.forEach(([value, text]) => el('option', text, node, { value })); node.value = current || ''; return node;
  }
  function edit(item, source = '') {
    close(); const expected_revision = revision(), client_request_id = crypto.randomUUID();
    dialog = el('dialog', null, document.getElementById('project'));
    el('h2', item ? L.edit : L.add, dialog);
    const title = field(dialog, L.name, item?.title); title.maxLength = 160;
    const description = field(dialog, L.description, item?.description || source, 'textarea'); description.maxLength = 4000;
    const row = el('div',null,dialog,{class:'form-row'});
    const assignee = select(row, L.assignee, [['', L.unassigned], ...snapshot.members.map(m => [m.uid, memberName(m.uid)])], item?.assignee_uid || snapshot.viewer_uid);
    const due = field(row, L.due, item?.due_date?.slice(0,10), 'date');
    const actions = el('div',null,dialog,{class:'dialog-actions'});
    button(L.cancel,actions,close);
    const save = button(L.save, actions, async () => {
      if (!title.value.trim()) { title.focus(); return; }
      save.disabled = true;
      await request(item ? 'edit' : 'create', { id: item?.id, title: title.value, description: description.value, assignee_uid: assignee.value || null, due_date: due.value || null, expected_revision, client_request_id });
      save.disabled = false;
    });
    save.className = 'primary'; dialog.addEventListener('cancel', close); dialog.showModal();
  }
  function settings(parent) {
    const settingsRoot = root;
    parent.addEventListener('input', () => { settingsRoot.dataset.dirty = 'true'; });
    const editable = snapshot.permissions.manage, expected_revision = revision(), expected_notice = snapshot.group.notice || '';
    const notice = field(parent, L.notice, expected_notice, 'textarea');
    const instructions = field(parent, L.instructions, snapshot.project.instructions, 'textarea');
    const status = select(parent, L.status, [['active', L.active], ['paused', L.paused]], snapshot.project.status);
    [notice,instructions,status].forEach(n => { n.disabled = !editable; });
    const save = button(L.save, parent, () => request('update', { expected_revision, expected_notice, notice: notice.value, instructions: instructions.value, status: status.value }), !editable);
    save.className = 'primary';
  }
  function icon(name, parent) {
    const paths = {
      plans:'M4 4h6v16H4zM14 4h6v10h-6z', activity:'M3 12h4l3-8 4 16 3-8h4', tasks:'M9 6h11M9 12h11M9 18h11M3 6l1 1 2-2M3 12l1 1 2-2M3 18l1 1 2-2',
      assets:'M3 7V5h7l2 2h9v13H3z', members:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8M17 4a4 4 0 0 1 0 7M22 21v-2a4 4 0 0 0-3-4',
      settings:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2',
      plus:'M12 5v14M5 12h14', refresh:'M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-2l2 3M4 16l2 3a7 7 0 0 0 12-2',
      chat:'M21 11a8 8 0 0 1-8 8H7l-5 3 2-6a8 8 0 1 1 17-5', empty:'M4 5h16v15H4zM4 14h4l2 3h4l2-3h4', calendar:'M4 5h16v15H4zM8 3v4M16 3v4M4 10h16'
    };
    const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
    for (const [key,value] of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.6','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true',class:'icon'})) svg.setAttribute(key,value);
    const path = document.createElementNS('http://www.w3.org/2000/svg','path'); path.setAttribute('d',paths[name] || paths.plans); svg.appendChild(path); parent.prepend(svg);
  }
  function decoratedButton(text, parent, click, disabled, symbol, style) {
    const node = button(text,parent,click,disabled); node.setAttribute('aria-label',text);
    if (symbol) icon(symbol,node); if (style) node.className = style; return node;
  }
  function shortUid(uid) { return uid.length > 20 ? uid.slice(0,8) + '…' + uid.slice(-4) : uid; }
  function memberName(uid) {
    if (!uid) return L.unassigned;
    const member = snapshot?.members.find(m => m.uid === uid);
    const name = member?.name || member?.nickname || (Object.hasOwn(options.memberNames || {},uid) ? options.memberNames[uid] : '');
    return name && name !== uid ? name : shortUid(uid);
  }
  function emptyState(parent, symbol, title, text) {
    const box = el('div',null,parent,{class:'empty-state'}); icon(symbol,box); el('h3',title,box); el('p',text,box); return box;
  }
  function render() {
    if (!snapshot) return;
    if (options.embedded) {
      if (!['plans','tasks','assets','settings'].includes(tab)) return;
      root = document.getElementById(tab === 'settings' ? 'project-settings' : 'project-content');
      if (!root) return;
    }
    if (tab === 'settings' && snapshot.permissions.manage && root.dataset.dirty === 'true') return;
    if (tab === 'assets' && storageOpen && snapshot.permissions.manage && root.querySelector('.storage-form')) return;
    if (!snapshot.permissions.manage) storageOpen = false;
    root.replaceChildren();
    delete root.dataset.dirty;
    if (!options.embedded) {
    const context = el('div',null,root,{class:'card project-context'});
    const identity = el('div',null,context); el('h2',snapshot.group.name,identity); el('p',L.memberHint,identity);
    const back = el('a',L.chat,context,{href:document.getElementById('project').dataset.chatUrl,class:'chat-link'}); icon('chat',back);
    const nav = el('nav',null,root,{'aria-label':L.title,class:'project-tabs'});
    ['activity','plans','tasks','assets','members','settings'].forEach(key => {
      const node = decoratedButton(L[key],nav,() => {tab = key; render();},false,key,'project-tab');
      if (tab === key) node.setAttribute('aria-current','page');
      if (key === 'plans') el('span',String(snapshot.items.length),node,{class:'nav-count','aria-hidden':'true'});
    });
    }
    const main = root;
    const content = el('div',null,main,{class:'content'}), heading = el('div',null,content,{class:'page-heading'});
    const headingText = el('div',null,heading); el('h2',L[tab],headingText);
    if (tab === 'plans' || tab === 'settings') el('p',tab === 'plans' ? L.planHint : L.settingsHint,headingText,{class:'subtitle'});
    const tools = el('div',null,heading,{class:'tools'});
    if (snapshot.project?.status === 'paused') el('span',L.paused,tools,{class:'badge'});
    decoratedButton(L.refresh,tools,() => tab === 'assets' ? loadStorage() : request(),false,'refresh');
    if (snapshot.project && ['plans','tasks'].includes(tab)) decoratedButton(L.add,tools,() => edit(),!snapshot.permissions.write,'plus','primary');
    if (!snapshot.project) {
      emptyState(content,'plans',L.error,L.unavailableProject);
      return;
    }
    if (tab === 'plans') {
      const board = el('div',null,content,{class:'board'});
      ['todo','doing','done','cancelled'].forEach(status => {
        const items = snapshot.items.filter(item => item.status === status);
        const column = el('section',null,board,{class:'column '+status}), header = el('div',null,column,{class:'column-header'});
        el('span',null,header,{class:'status-dot'}); el('h3',L[status],header); el('span',String(items.length),header,{class:'count'});
        if (!items.length) {
          const empty = el('div',null,column,{class:'empty-column'}); icon('empty',empty); el('p',L.emptyPlan,empty);

        }
        items.forEach(item => {
          const card = el('article',null,column); button(item.title,card,() => openTask(item.id));
          if (item.description) el('p',item.description,card,{class:'description'});
          const meta = el('div',null,card,{class:'card-meta'});
          el('span',item.assignee_uid ? memberName(item.assignee_uid).slice(0,1).toUpperCase() : '–',meta,{class:'avatar'});
          el('span',memberName(item.assignee_uid),meta,{title:item.assignee_uid || L.unassigned});
          if (item.due_date) { const due = el('span',item.due_date.slice(0,10),meta); icon('calendar',due); }
          const actions = el('div',null,card,{class:'card-actions'});
          const move = select(actions,L.status,['todo','doing','done','cancelled'].map(s => [s,L[s]]),status); move.disabled = !canOwn(item);
          move.onchange = () => {const next = move.value; move.value = status; request('move',{id:item.id,status:next,expected_revision:revision()});};
          button(L.edit,actions,() => edit(item),!snapshot.permissions.write);
          button(L.archive,actions,() => request('archive',{id:item.id,expected_revision:revision()}),!snapshot.permissions.write || !(snapshot.permissions.manage || snapshot.viewer_uid === item.created_by_uid));
        });
      });
    } else if (tab === 'settings') settings(el('div',null,content,{class:'settings-panel'}));
    else if (tab === 'assets') renderStorage(content);
    else if (tab === 'tasks') renderTasks(content);
    else if (tab === 'members') {
      const list = el('div',null,content,{class:'member-list'});
      snapshot.members.forEach(m => { const row = el('div',null,list,{class:'member-row'}); el('span',memberName(m.uid).slice(0,1).toUpperCase(),row,{class:'avatar'}); el('span',memberName(m.uid),row,{title:m.uid}); el('span',L[m.role] || m.role,row,{class:'badge'}); });
      if (snapshot.members_truncated) el('p',L.truncated,content,{class:'subtitle'});
    } else {
      if (!snapshot.events.length) emptyState(content,'activity',L.empty,L.overview);
      else {
        const timeline = el('div',null,content,{class:'timeline'});
        const names = {'project.created':L.eventProjectCreated,'project.enabled':L.eventEnabled,'project.updated':L.eventUpdated,'plan.created':L.eventCreated,'plan.updated':L.eventEdited,'plan.moved':L.eventMoved,'plan.archived':L.eventArchived};
        snapshot.events.forEach(e => {const row = el('div',null,timeline,{class:'event'}); el('span',null,row,{class:'dot'}); const detail = el('div',null,row); el('span',names[e.event_type] || e.event_type,detail); el('small',memberName(e.actor_uid)+' · '+e.created_at,detail);});
      }
    }
  }

  function canOwn(item) {return snapshot.permissions.write && (snapshot.permissions.manage || (item.assignee_uid || item.created_by_uid)===snapshot.viewer_uid);}
  async function openTask(id) {
    selectedTask=id;taskData=null;window.vokoSelectGroupTab?.('tasks');const url=new URL(location.href);url.searchParams.set('task',id);history.replaceState(null,'',url);tab='tasks';render();
    try {const data=await storageRequest('taskGet',{id});if(selectedTask===id){taskData=data;render();}}
    catch(error){alert.textContent=(L['error_'+error.message]||L.error)+' ('+error.message+')';}
  }
  function renderTasks(parent) {
    if (!selectedTask) {
      if (!snapshot.items.length) el('p',L.emptyPlan,parent);
      snapshot.items.forEach(item=>{const card=el('article',null,parent,{class:'task-card'});button(item.title,card,()=>openTask(item.id));el('p',L.assignee+': '+memberName(item.assignee_uid)+' · '+L[item.status],card);});return;
    }
    button(L.backTasks,parent,()=>{selectedTask=null;taskData=null;const url=new URL(location.href);url.searchParams.delete('task');history.replaceState(null,'',url);render();});
    if(!taskData){el('p',L.loading,parent);return;}
    const {task,messages,executions,assets}=taskData;
    el('h3',task.title,parent);el('p',task.description,parent,{class:'description'});
    el('p',L.assignee+': '+memberName(task.assignee_uid)+' · '+L[task.status],parent);
    el('p',L.sharedTask,parent,{class:'subtitle'});
    button(L.edit,parent,()=>edit(task),!canOwn(task));
    const active=executions.some(e=>['queued','working','unknown'].includes(e.status));
    button(task.status==='done'||task.status==='cancelled'?L.reopen:L.complete,parent,()=>request('move',{id:task.id,status:['done','cancelled'].includes(task.status)?'doing':'done',expected_revision:revision()}),!canOwn(task)||active);
    const conversation=el('div',null,parent,{class:'task-messages'});
    messages.forEach(message=>{const card=el('div',null,conversation,{class:'task-card'});el('small',memberName(message.actor_uid)+' · '+message.created_at,card);el('p',message.content,card,{class:'description'});});
    const draft=drafts.get(task.id)||{content:'',executor:'',instruction:''};drafts.set(task.id,draft);
    const content=field(parent,L.taskMessage,draft.content,'textarea');content.oninput=()=>{draft.content=content.value;};
    button(L.sendMessage,parent,async()=>{if(!content.value.trim())return; if(await request('taskMessage',{id:task.id,content:content.value,client_request_id:crypto.randomUUID(),expected_revision:revision()})){draft.content='';render();}},!taskData.permissions.write||['done','cancelled'].includes(task.status));
    const assignment=el('div',null,parent,{class:'task-card'});el('h3',L.dispatch,assignment);
    const executor=select(assignment,L.executor,[['',L.chooseAgent],...snapshot.members.filter(m=>(snapshot.executor_uids || []).includes(m.uid)).map(m=>[m.uid,memberName(m.uid)])],draft.executor);executor.onchange=()=>{draft.executor=executor.value;};
    const instruction=field(assignment,L.workInstruction,draft.instruction,'textarea');instruction.oninput=()=>{draft.instruction=instruction.value;};
    button(L.dispatch,assignment,async()=>{if(!executor.value||!instruction.value.trim())return;if(await request('taskDispatch',{id:task.id,executor_uid:executor.value,instruction:instruction.value,client_request_id:crypto.randomUUID(),expected_revision:revision()})){draft.instruction='';render();}},!canOwn(task)||active||['done','cancelled'].includes(task.status));
    el('h3',L.executions,parent);
    executions.forEach(run=>{const card=el('div',null,parent,{class:'task-card'});el('strong',memberName(run.executor_uid)+' · '+(L['run_'+run.status]||run.status),card);el('p',run.instruction,card,{class:'description'});if(run.result)el('p',run.result,card,{class:'description'});if(run.status==='queued')button(L.cancelExecution,card,()=>request('executionCancel',{id:task.id,execution_id:run.id,expected_revision:revision()}),!canOwn(task));});
    executions.filter(run=>['working','unknown'].includes(run.status)).forEach(run=>{const box=el('details',null,parent);el('summary',L.resolveExecution,box);const evidence=field(box,L.resolveEvidence,'','textarea');const outcome=select(box,L.status,[['succeeded',L.run_succeeded],['failed',L.run_failed]],'');button(L.resolveExecution,box,()=>{if(evidence.value.trim())request('executionResolve',{id:task.id,execution_id:run.id,status:outcome.value,evidence:evidence.value,confirmed:true,expected_revision:revision()});},!canOwn(task));});
    el('h3',L.assets,parent);assets.forEach(asset=>assetRow(parent,asset));uploadControl(parent,task.id);
    const latest=executions.filter(run=>run.result).at(-1);if(latest)button(L.resultDraft,parent,()=>{window.vokoSelectGroupTab?.('messages');const input=document.getElementById('group-reply-input');if(input && !input.disabled){input.value=task.title+'\n'+latest.result.slice(0,2000);input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();}});
    if(taskData.truncated)el('p',L.truncated,parent);
  }
  async function downloadAsset(asset) {
    try {const signed=await storageRequest('assetDownload',{asset_id:asset.id});const response=await fetch(signed.url,{redirect:'error',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(120000)});if(!response.ok)throw new Error('Download failed');const blob=await response.blob();if(blob.size!==Number(asset.size))throw new Error('Download size mismatch');const url=URL.createObjectURL(blob);const a=el('a',null,document.body,{href:url,download:asset.name});a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);}
    catch(error){alert.textContent=(L['error_'+error.message]||L.error)+' ('+error.message+')';}
  }
  function assetRow(parent,asset){const row=el('div',null,parent,{class:'task-card'});el('span',asset.name+' · '+Math.ceil(Number(asset.size)/1024)+' KB',row);if(asset.status==='ready')button(L.download,row,()=>downloadAsset(asset));else el('span',L.uploadPending,row);}
  function uploadControl(parent,id) {
    if(!snapshot.permissions.write)return;
    const file=el('input',null,parent,{type:'file','aria-label':L.upload});
    const upload=button(L.upload,parent,async()=>{
      const selected=file.files[0];if(!selected)return;upload.disabled=true;
      try{const ticket=await storageRequest('assetPrepare',{id,name:selected.name,size:selected.size});const result=await fetch(ticket.url,{method:'PUT',redirect:'error',headers:ticket.headers,body:selected,signal:AbortSignal.timeout(120000)}).catch(()=>{throw new Error('PROJECT_ASSET_UPLOAD_FAILED')});if(!result.ok)throw new Error('PROJECT_ASSET_UPLOAD_FAILED');await storageRequest('assetCommit',{asset_id:ticket.id});if(id)await openTask(id);else render();}
      catch(error){alert.textContent=(L['error_'+error.message]||L.error)+' ('+error.message+')';}finally{upload.disabled=false;}
    });
  }
  function renderAssets(parent,config) {
    if(!config){el('p',L.storageHint,parent);return;}
    uploadControl(parent);
    const list=el('div',L.loading,parent);
    storageRequest('assetsList').then(data=>{if(!list.isConnected)return;list.replaceChildren();if(!data.assets.length)el('p',L.emptyAssets,list);data.assets.forEach(asset=>assetRow(list,asset));}).catch(error=>{if(list.isConnected)list.textContent=L.error+' ('+error.message+')';});
  }

  function storageError(code) {
    const labels = { PROJECT_STORAGE_AUTH_FAILED:L.storageErrorAuth, PROJECT_STORAGE_BUCKET_NOT_FOUND:L.storageErrorBucket,
      PROJECT_STORAGE_CONFLICT:L.storageErrorConflict, PROJECT_STORAGE_KEYS_REQUIRED:L.storageErrorKeys,
      PROJECT_STORAGE_BUCKET_IN_USE:L.storageErrorInUse, PROJECT_STORAGE_CONNECTION_FAILED:L.storageErrorConnection,
      PROJECT_STORAGE_INVALID_CONFIG:L.storageErrorConfig, PROJECT_STORAGE_KEY_REQUIRED:L.storageKeyMissing,
      PROJECT_STORAGE_CREDENTIALS_UNAVAILABLE:L.storageErrorCredentials };
    return labels[code] || L['error_'+code] || L.storageLoadError;
  }
  async function storageRequest(action, body = {}) {
    const read = action === 'storageGet';
    const response = await fetch(base+(read ? '/storage' : '/action/'+action),{method:read ? 'GET' : 'POST',cache:'no-store',redirect:'error',headers:{'Content-Type':'application/json',Accept:'application/json'},...(read ? {} : {body:JSON.stringify(body)})});
    const result = await response.json();
    if (!response.ok || !result.success) {
      if ([401,403].includes(response.status)) {
        storageOpen = false; storageState = undefined; snapshot = null; close();
        alert.textContent = L.error + ' (' + result.code + ')';
        document.querySelectorAll('#project-content,#project-settings').forEach(node => node.replaceChildren());
        document.querySelectorAll('[data-project-event]').forEach(node => node.remove());
      }
      throw new Error(result.code || 'PROJECT_STORAGE_UNAVAILABLE');
    }
    return result.data;
  }
  async function loadStorage() {
    if (storageLoading) return;
    storageLoading = true;
    try { storageState = await storageRequest('storageGet'); }
    catch(error) { storageState = null; alert.textContent = storageError(error.message); }
    finally { storageLoading = false; if (tab === 'assets') render(); }
  }
  function renderStorage(parent) {
    const config = storageState?.configuration;
    const summary = el('div',null,parent,{class:'storage-summary'});
    const text = el('div',null,summary); el('h3',L.cloudSpace,text);
    el('p',config ? L.qiniu+' · '+config.bucket : L.storageHint,text,{class:'subtitle'});
    el('span',config ? L.storageConnected : L.storageNotConfigured,text,{class:'storage-status'});
    if (snapshot.permissions.manage) button(config ? L.manageStorage : L.configureStorage,summary,() => {storageOpen=true;render();},!storageState || !storageState.permissions.manage);
    else el('p',L.storageAdminHint,parent,{class:'subtitle'});
    if (storageState === undefined) { el('p',L.loading,parent); void loadStorage(); return; }
    if (storageState === null) { button(L.refresh,parent,loadStorage); return; }
    if (!storageOpen) { renderAssets(parent,config); return; }
    const form = el('form',null,parent,{class:'storage-form',autocomplete:'off'});
    el('h3',L.storageConfigTitle,form); el('p',L.storagePrivacy,form,{class:'subtitle'});
    const bucket = field(form,L.bucket,config?.bucket); bucket.required=true; bucket.maxLength=63; bucket.pattern='[a-z0-9][a-z0-9.\\-]{1,61}[a-z0-9]';
    el('small',L.bucketHint,form);
    const region = select(form,L.region,[['cn-east-1',L.regionEast1],['cn-east-2',L.regionEast2],['cn-north-1',L.regionNorth],['cn-south-1',L.regionSouth],['us-north-1',L.regionUS],['ap-southeast-1',L.regionSingapore],['ap-southeast-2',L.regionHanoi],['ap-southeast-3',L.regionHCM]],config?.region || 'cn-east-1');
    const endpoint = field(form,L.endpoint,''); endpoint.readOnly=true;
    const updateEndpoint=() => { endpoint.value='https://s3.'+region.value+'.qiniucs.com'; }; region.onchange=updateEndpoint; updateEndpoint();
    const access = field(form,L.accessKey,'','password'), secret = field(form,L.secretKey,'','password');
    [access,secret].forEach(input => {input.autocomplete='new-password';input.maxLength=256;input.required=!config;input.placeholder=config ? L.keepKeys : '';});
    if (config) el('small',L.accessKey+': '+config.access_key_hint,form);
    el('small',L.keyHint,form); el('p',L.storageReadOnlyCheck,form,{class:'subtitle'});
    const status = el('p',null,form,{role:'status',class:'storage-feedback'});
    if (!storageState.configuration_available) status.textContent=L.storageKeyMissing;
    const actions=el('div',null,form,{class:'dialog-actions'});
    button(L.cancel,actions,() => {form.reset(); storageOpen=false;storageGeneration++;render();});
    const save=button(L.verifySave,actions,() => form.requestSubmit(),!storageState.configuration_available);save.className='primary';
    form.onsubmit=async event => {
      event.preventDefault(); if (save.disabled) return;
      if (Boolean(access.value)!==Boolean(secret.value)) {status.textContent=L.storageErrorKeys;return;}
      save.disabled=true; save.textContent=L.verifying; status.textContent='';
      const generation=++storageGeneration;
      try {
        const result=await storageRequest('storageConfigure',{provider:'qiniu',bucket:bucket.value.trim(),region:region.value,access_key:access.value,secret_key:secret.value,expected_storage_revision:config?.row_version || 0});
        if (generation!==storageGeneration) return;
        access.value='';secret.value='';storageState=result;storageOpen=false;render();alert.textContent=L.storageVerified;
      } catch(error) {if (generation===storageGeneration) status.textContent=storageError(error.message);}
      finally {save.disabled=false;save.textContent=L.verifySave;}
    };
  }
  function renderEvents() {
    if (!options.embedded || !snapshot) return;
    const box = document.getElementById('msg-box');
    if (!box) return;
    const names = {'project.created':L.eventProjectCreated,'project.enabled':L.eventEnabled,'project.updated':L.eventUpdated,'plan.created':L.eventCreated,'plan.updated':L.eventEdited,'plan.moved':L.eventMoved,'plan.archived':L.eventArchived};
    for (const event of [...snapshot.events].reverse()) {
      if(event.event_type.startsWith('task.'))continue;
      if (box.querySelector('[data-project-event="'+event.event_seq+'"]')) continue;
      const time = Date.parse(event.created_at.includes('T') ? event.created_at : event.created_at.replace(' ','T')+'Z');
      const row = el('div',null,null,{class:'tip','data-project-event':event.event_seq});
      const text = document.createTextNode(new Date(time).toLocaleString()+' · '+memberName(event.actor_uid)+' · '+(names[event.event_type] || event.event_type)+' ');
      row.appendChild(text);
      const item = snapshot.items.find(item => item.id === event.entity_id);
      if (item) button(item.title,row,() => openTask(item.id));
      const next = [...box.children].find(child => { const stamp = child.querySelector('time')?.getAttribute('datetime'); return stamp && Date.parse(stamp) > time; });
      box.insertBefore(row,next || null);
    }
    const notice = document.getElementById('group-notice-text');
    if (notice) { notice.textContent = snapshot.group.notice || ''; document.getElementById('group-notice').hidden = !snapshot.group.notice; }
  }
  if (options.embedded) {
    tab = new URL(location.href).searchParams.get('tab') || 'messages';
    if (tab === 'ops') tab = 'settings';
    document.addEventListener('click',event=>{const source=event.target.closest('[data-task-source]');if(source&&snapshot?.project)edit(null,source.dataset.taskSource);});
    window.addEventListener('voko-task-from-message',event=>{if(snapshot?.project)edit(null,String(event.detail||'').slice(0,4000));});
    window.addEventListener('voko-collaboration-refresh', () => request());
    window.addEventListener('voko-collaboration-tab',event => {
      if (event.detail !== 'assets') { storageOpen = false; storageGeneration++; root.querySelector('.storage-form')?.reset(); }
      tab = event.detail === 'ops' ? 'settings' : event.detail;
      if (!snapshot) request(); else render();
    });
  }
  alert.textContent = L.loading;
  request();
  setInterval(() => { if (!document.hidden && !dialog && !busy && tab !== 'settings') request(); }, 15000);
}
module.exports = { mountProjectRoutes, renderProjectFragment, projectBrowser };
