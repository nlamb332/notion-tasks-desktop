import { _electron as electron, expect } from '@playwright/test';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=process.cwd();
await mkdir(path.join(root,'.cache'),{recursive:true});
const data=await mkdtemp(path.join(root,'.cache','integration-'));
const app=await electron.launch({args:['.'],env:{...process.env,NOTION_TASKS_USER_DATA:data},timeout:30000});
try {
 const page=await app.firstWindow();
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.waitForFunction(()=>!!window.desktop);
 await app.evaluate(()=>{
   const dbs=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'];
   const ids=['33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444'];
   const names=['Tasks','Work Tasks'];
   const g=globalThis;
   g.__fixture={offline:[],writes:[],pages:{},next:1};
   const f=g.__fixture;
   const schema=i=>({id:ids[i],parent:{database_id:dbs[i]},title:[{plain_text:names[i]}],properties:{
     [i?'Name':'Task']:{id:'title',name:i?'Name':'Task',type:'title',title:{}},
     [i?'Due':'Due Date']:{id:'due',name:i?'Due':'Due Date',type:'date',date:{}},
     Status:{id:'status',name:'Status',type:'status',status:{options:[{id:'open',name:'Not started'},{id:'progress',name:'In progress'},{id:'done',name:'Done'}],groups:[{id:'todo',name:'To-do',option_ids:['open']},{id:'working',name:'In progress',option_ids:['progress']},{id:'complete',name:'Complete',option_ids:['done']}]}},
     ...(i?{'Status 1':{id:'unmapped',name:'Status 1',type:'select',select:{options:[{id:'blocked',name:'Blocked'}]}}}:{})
   }});
   const make=(id,i,name)=>({id,url:`https://www.notion.so/${id}`,parent:{data_source_id:ids[i]},last_edited_time:new Date().toISOString(),properties:{title:{id:'title',type:'title',title:[{plain_text:name}]},due:{id:'due',type:'date',date:{start:'2026-10-21',end:null}},status:{id:'status',type:'status',status:{id:'open',name:'Not started'}},unmapped:{id:'unmapped',type:'select',select:{id:'blocked',name:'Blocked'}}}});
   f.pages['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']=make('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',0,'Plan the week');
   f.pages['bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb']=make('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',1,'Example assignment');
   globalThis.fetch=async(input,init={})=>{
    const url=new URL(String(input));const method=init.method||'GET';const p=url.pathname.replace('/v1','');
    if(url.origin!=='https://api.notion.com')throw new Error('Unexpected network request');
    const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
    if(p==='/users/me')return reply({id:'fixture-user'});
    const dsIndex=ids.findIndex(id=>p.includes(id));
    if(dsIndex>=0&&f.offline.includes(ids[dsIndex]))return reply({message:'Source unavailable'},403);
    if(p.startsWith('/data_sources/')){
      if(dsIndex<0)return reply({message:'not found'},404);
      if(p.endsWith('/query'))return reply({results:Object.values(f.pages).filter(v=>v.parent.data_source_id===ids[dsIndex]),has_more:false});
      return reply(schema(dsIndex));
    }
    if(p.startsWith('/databases/')){const i=dbs.findIndex(id=>p.endsWith(id));return i<0?reply({},404):reply({id:dbs[i],data_sources:[{id:ids[i],name:names[i]}]});}
    if(p==='/pages'&&method==='POST'){
      const body=JSON.parse(init.body);const i=ids.indexOf(body.parent.data_source_id);const id=`cccccccc-cccc-cccc-cccc-${String(f.next++).padStart(12,'0')}`;
      const next=make(id,i,'');f.pages[id]=next;
      const fields=body.properties;for(const [key,val]of Object.entries(fields)){if(key==='title')next.properties.title.title=val.title.map(x=>({plain_text:x.text.content}));else if(key==='due')next.properties.due.date=val.date;else if(key==='status'){const s=schema(i).properties.Status.status.options.find(x=>x.id===val.status.id);next.properties.status.status=s;}}
      f.writes.push({method,body});return reply({id});
    }
    if(p.startsWith('/pages/')){
      const id=p.split('/').at(-1),row=f.pages[id];if(!row)return reply({message:'not found'},404);
      if(method==='PATCH'){
        const body=JSON.parse(init.body);
        if(f.pauseStatus && body.properties.status) { f.pendingStatus = true; await new Promise(resolve=>{f.releaseStatus=resolve;}); }
        f.writes.push({method,body});for(const[key,val]of Object.entries(body.properties)){
         if(key==='title')row.properties.title.title=val.title.map(x=>({plain_text:x.text.content}));else if(key==='due')row.properties.due.date=val.date;else if(key==='status')row.properties.status.status=schema(0).properties.Status.status.options.find(x=>x.id===val.status.id);else throw new Error('Unmapped write');
        }row.last_edited_time=new Date().toISOString();
      }return reply(row);
    }
    throw new Error(`Unhandled fixture route ${method} ${p}`);
   };
 });
 await page.evaluate(()=>window.desktop.connect('fixture-token-only'));
 const sources=await page.evaluate(async()=>{
  const links=['https://app.notion.com/p/11111111111141118111111111111111?v=55555555555545558555555555555555','https://app.notion.com/p/22222222222242228222222222222222?v=66666666666646668666666666666666'];
  const found=[];for(const link of links){const [s]=await window.desktop.resolveSource(link);const cfg={...s,mapping:{title:'title',due:'due',status:'status',complete:'done',reopen:'open'}};await window.desktop.saveSource(cfg);found.push(cfg);}await window.desktop.refresh();return found;
 });
 let state=await page.evaluate(()=>window.desktop.getState());
 assert.equal(state.sources.length,2);assert.equal(state.tasks.length,2);
 await page.evaluate(s=>window.desktop.saveSource(s),sources[0]);
 assert.equal((await page.evaluate(()=>window.desktop.getState())).sources.length,2);
 const school=state.tasks.find(t=>t.sourceId===sources[1].id);
 const updated=await page.evaluate(async t=>window.desktop.updateTask(t.id,{name:'Example assignment revised',status:'In progress'},t),school);
 assert.equal(updated.task.status,'In progress');
 const complete=await page.evaluate(async t=>window.desktop.updateTask(t.id,{status:'Done'},t),updated.task);
 assert.equal(complete.task.completed,true);
 const reopened=await page.evaluate(async t=>window.desktop.updateTask(t.id,{status:'Not started'},t),complete.task);
 assert.equal(reopened.task.completed,false);
 const before=reopened.task;
 await app.evaluate(()=>{globalThis.__fixture.pages['bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'].properties.title.title=[{plain_text:'Changed in Notion'}];});
 const conflict=await page.evaluate(t=>window.desktop.updateTask(t.id,{name:'Stale edit'},t),before);
 assert.equal(conflict.conflict,true);assert.equal(conflict.task.name,'Changed in Notion');
 const bridgeCreated=await page.evaluate(s=>window.desktop.createTask(s.id,'Created through bridge',undefined,true),sources[0]);
 const bridgeTask=bridgeCreated.tasks.find(t=>t.name==='Created through bridge');
 assert.ok(bridgeTask);assert.ok(bridgeCreated.stars.includes(bridgeTask.id));
 await page.evaluate(()=>window.desktop.setSettings({selectedList:'all'}));
 await page.reload();await page.getByRole('button',{name:'Open Created through bridge',exact:true}).waitFor();
 assert.equal(await page.locator('.sync-banner').count(),0);
 assert.ok(await page.locator('.topbar .sync-status').count());
 await page.getByLabel('Quick add task',{exact:true}).click();
 assert.equal(await page.locator('.draft-panel input[type="date"]').inputValue(),'');
 await page.getByRole('button',{name:'Close new task',exact:true}).click();
 await page.getByRole('button',{name:'Today',exact:true}).click();
 await app.evaluate(()=>{const d=new Date();d.setDate(d.getDate()-1);globalThis.__fixture.pages['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'].properties.due.date.start=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;});
 await page.evaluate(()=>window.desktop.refresh());
 await expect(page.getByRole('button',{name:'Open Plan the week',exact:true})).toHaveCount(0);
 await page.getByRole('switch',{name:'Show overdue',exact:true}).check();
 await expect(page.getByRole('button',{name:'Open Plan the week',exact:true})).toBeVisible();
 await page.screenshot({path:path.join(root,'.cache','today-overdue.png')});
 await page.reload();
 await expect(page.getByRole('switch',{name:'Show overdue',exact:true})).toBeChecked();
 await page.evaluate(()=>window.desktop.setSettings({compact:true}));
 await expect(page.getByRole('switch',{name:'Show overdue',exact:true})).toBeChecked();
 await page.screenshot({path:path.join(root,'.cache','today-overdue-compact.png')});
 await page.getByRole('switch',{name:'Show overdue',exact:true}).uncheck();
 await expect(page.getByRole('button',{name:'Open Plan the week',exact:true})).toHaveCount(0);
 await page.evaluate(()=>window.desktop.setSettings({compact:false}));
 await expect(page.getByRole('switch',{name:'Show overdue',exact:true})).not.toBeChecked();
 await page.getByLabel('Quick add task',{exact:true}).click();
 const localToday=await page.evaluate(()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;});
 assert.equal(await page.locator('.draft-panel input[type="date"]').inputValue(),localToday);
 await page.getByRole('textbox',{name:'Task title',exact:true}).fill('Created through interface');
 await page.locator('.draft-panel input[type="date"]').fill('2026-10-22');
 await page.getByRole('checkbox',{name:'Favorite this task',exact:true}).check();
 assert.equal((await page.evaluate(()=>window.desktop.getState())).tasks.length,3);
 await page.getByRole('button',{name:'Create task',exact:true}).click();
 await expect(page.locator('.draft-panel')).toHaveCount(0);
 await page.getByRole('button',{name:'All Tasks',exact:true}).click();
 await page.getByRole('button',{name:'Open Created through interface',exact:true}).waitFor();
 const interfaceState=await page.evaluate(()=>window.desktop.getState());
 const interfaceTask=interfaceState.tasks.find(t=>t.name==='Created through interface');
 assert.equal(interfaceTask.due.start,'2026-10-22');assert.ok(interfaceState.stars.includes(interfaceTask.id));
 await page.getByRole('button',{name:'Open Created through interface',exact:true}).click();
 await page.getByRole('button',{name:'Close task details',exact:true}).click();
 await page.screenshot({path:path.join(root,'.cache','tasks.png')});
 await page.getByRole('button',{name:'Open Plan the week',exact:true}).click();
 await page.waitForFunction(()=>[...document.querySelectorAll('.main-column,.detail-scroll')].every(el=>el.scrollWidth<=el.clientWidth+1));
 await page.screenshot({path:path.join(root,'.cache','details.png')});
 await page.getByRole('button',{name:'Close task details',exact:true}).click();
 const previousStatusWrites=await app.evaluate(()=>globalThis.__fixture.writes.filter(w=>w.body.properties.status).length);
 await app.evaluate(()=>{globalThis.__fixture.pauseStatus=true;});
 await page.getByRole('button',{name:'Complete Plan the week',exact:true}).click();
 await page.getByRole('button',{name:'Open Plan the week',exact:true}).waitFor({state:'hidden',timeout:1000});
 await page.getByRole('button',{name:'Undo',exact:true}).click();
 await page.getByRole('button',{name:'Open Plan the week',exact:true}).waitFor({timeout:1000});
 assert.equal(await app.evaluate(()=>globalThis.__fixture.pages['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'].properties.status.status.name),'Not started');
 await app.evaluate(()=>{const f=globalThis.__fixture;f.pauseStatus=false;f.releaseStatus?.();});
 await expect.poll(()=>app.evaluate(()=>globalThis.__fixture.writes.filter(w=>w.body.properties.status).length)).toBe(previousStatusWrites+2);
 await page.waitForFunction(async()=>{const s=await window.desktop.getState();return s.tasks.find(t=>t.name==='Plan the week')?.status==='Not started' && !s.sync.syncing;});
 await page.evaluate(()=>window.desktop.setSettings({compact:true}));
 await page.waitForFunction(()=>!!document.querySelector('.compact-shell'));
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.screenshot({path:path.join(root,'.cache','compact.png')});
 await page.getByRole('combobox',{name:'Current list',exact:true}).selectOption('today');
 await page.getByLabel('Quick add task',{exact:true}).click();
 await expect(page.locator('.draft-panel')).toBeVisible();
 assert.equal(await page.locator('.draft-panel input[type="date"]').inputValue(),localToday);
 await page.getByRole('button',{name:'Close new task',exact:true}).click();
 await page.evaluate(()=>window.desktop.setSettings({compact:false}));
 await app.evaluate((_electron,id)=>{globalThis.__fixture.offline=[id];},sources[1].id);
 state=await page.evaluate(()=>window.desktop.refresh());
 assert.equal(state.tasks.length,4);assert.equal(state.sync.onlineSources.length,1);assert.ok(state.sync.errors[sources[1].id]);
 await assert.rejects(page.evaluate(t=>window.desktop.updateTask(t.id,{name:'Offline edit'},t),conflict.task),/offline/i);
 await page.evaluate(t=>window.desktop.toggleStar(t.id),school);
 assert.ok((await page.evaluate(()=>window.desktop.getState())).stars.includes(school.id));
 const fixture=await app.evaluate(()=>globalThis.__fixture);
 assert.equal(fixture.pages[school.id].properties.unmapped.select.name,'Blocked');
 assert.ok(fixture.writes.every(w=>Object.keys(w.body.properties).every(k=>['title','due','status'].includes(k))));
 const persisted=await readFile(path.join(data,'state.json'),'utf8');
 assert.ok(!persisted.includes('fixture-token-only'));
 const encrypted=await readFile(path.join(data,'notion-token.enc'));
 assert.ok(!encrypted.includes(Buffer.from('fixture-token-only')));
 assert.ok(JSON.parse(persisted).lastSync);
 await page.evaluate(()=>window.desktop.disconnect());
 await assert.rejects(readFile(path.join(data,'notion-token.enc')),/ENOENT/);
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({result:'PASS',checks:['synthetic database URLs','two sources','duplicate source','edit correct source','complete and reopen','conflict','create','partial source failure retains tasks','offline writes blocked','offline local star','Status 1 untouched','renderer list and detail','encrypted credential storage','disconnect deletes credential','last successful sync persisted'],writes:fixture.writes.length,data,screenshots:['.cache/tasks.png','.cache/details.png','.cache/compact.png']},null,2));
}finally{await app.close();}
