import { _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, readdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const root=process.cwd();await mkdir(path.join(root,'.cache'),{recursive:true});
const data=await mkdtemp(path.join(root,'.cache','jira-'));
const app=await electron.launch({args:['.'],env:{...process.env,NOTION_TASKS_USER_DATA:data},timeout:30000});
try {
  const page=await app.firstWindow();page.setDefaultTimeout(12000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.waitForFunction(()=>!!window.desktop);
  await app.evaluate(()=>{
    const statuses=[{name:'Task',statuses:[{id:'1',name:'To Do',statusCategory:{key:'new'}},{id:'3',name:'Done',statusCategory:{key:'done'}}]}];
    const issues=new Map([['1',{id:'1',key:'OPS-1',fields:{summary:'Ship the fixture',status:statuses[0].statuses[0],duedate:'2030-01-15',assignee:{accountId:'me',displayName:'Fixture Person'},updated:'2026-11-01T10:00:00.000+0000'}}]]);
    globalThis.fetch=async(input,init={})=>{
      const url=new URL(String(input)),p=url.pathname.replace('/rest/api/3',''),reply=(body,status=200)=>new Response(status===204?null:JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
      if(url.origin!=='https://fixture.atlassian.net')throw new Error('Unexpected network request in Jira smoke');
      if(p==='/myself')return reply({accountId:'me'});
      if(p==='/project/search')return reply({values:[{id:'10',key:'OPS',name:'Operations'}],isLast:true});
      if(p==='/project/OPS')return reply({id:'10',key:'OPS',name:'Operations',issueTypes:[{id:'7',name:'Task',subtask:false}]});
      if(p==='/project/OPS/statuses')return reply(statuses);
      if(p==='/search/jql')return reply({issues:[...issues.values()],isLast:true});
      if(p==='/issue/1/transitions'&&init.method==='POST'){issues.get('1').fields.status=statuses[0].statuses[1];return reply(null,204);}
      if(p==='/issue/1/transitions')return reply({transitions:[{id:'41',to:{id:'3'}}]});
      if(p==='/issue/1')return reply(issues.get('1'));
      throw new Error('Unexpected fixture route '+p);
    };
  });

  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await page.getByLabel('Jira site',{exact:true}).fill('fixture.atlassian.net');
  await page.getByLabel('Jira account email',{exact:true}).fill('person@example.com');
  await page.getByLabel('Jira API token',{exact:true}).fill('jira-fixture-token-only');
  await page.getByRole('button',{name:'Connect Jira',exact:true}).click();
  await page.getByText('person@example.com',{exact:false}).waitFor();
  assert.equal(await page.evaluate(()=>window.desktop.getState().then(s=>JSON.stringify(s).includes('jira-fixture-token-only'))),false);

  await page.getByRole('button',{name:'Sources',exact:true}).click();
  const picker=page.getByLabel('Jira project',{exact:true});
  await page.waitForFunction(()=>[...document.querySelectorAll('select[aria-label="Jira project"] option')].length===2);
  await picker.selectOption({index:1});
  await page.getByRole('button',{name:'Save source',exact:true}).click();
  await page.waitForFunction(()=>window.desktop.getState().then(s=>s.tasks.length===1&&s.sync.onlineSources.length===1));
  const state=await page.evaluate(()=>window.desktop.getState());
  assert.equal(state.sources[0].provider,'jira');
  const [task]=state.tasks;assert.equal(task.name,'Ship the fixture');assert.equal(task.url,'https://fixture.atlassian.net/browse/OPS-1');

  // Jira tasks reach planning as first-class references.
  await page.evaluate(([sourceId,taskId])=>window.desktop.setTaskEstimate({provider:'jira',sourceId,taskId},45),[task.sourceId,task.id]);
  assert.equal((await page.evaluate(()=>window.desktop.getState())).planning.tasks[0].ref.provider,'jira');

  // Completing a task goes through a workflow transition, and the mapping stayed on the source.
  const done=await page.evaluate(([id,expected,status])=>window.desktop.updateTask(id,{status},expected),[task.id,task,state.sources[0].mapping.complete]);
  assert.equal(done.task.status,'Done');assert.equal(done.task.completed,true);

  await page.evaluate(()=>window.desktop.disconnect('jira'));
  assert.equal((await readdir(data)).includes('jira-config.json'),false);
  assert.deepEqual(errors,[]);
  console.log('Jira smoke passed');
} finally {await app.close();}
