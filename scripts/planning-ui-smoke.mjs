import { _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const root=process.cwd();await mkdir(path.join(root,'.cache'),{recursive:true});
const data=await mkdtemp(path.join(root,'.cache','planning-ui-'));
// PLANNING_SMOKE_EXE targets an unpacked preview build; preview builds honor NOTION_TASKS_USER_DATA, stable packaged builds do not.
const launch=process.env.PLANNING_SMOKE_EXE?{executablePath:process.env.PLANNING_SMOKE_EXE,args:[]}:{args:['.']};
const app=await electron.launch({...launch,env:{...process.env,NOTION_TASKS_USER_DATA:data},timeout:30000});
try {
  const page=await app.firstWindow();page.setDefaultTimeout(12000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.waitForFunction(()=>!!window.desktop);
  const hours=()=>page.evaluate(()=>window.desktop.getState().then(s=>[s.planning.settings.startHour,s.planning.settings.endHour]));
  await app.evaluate(()=>{
    const database='11111111-1111-4111-8111-111111111111',source='33333333-3333-4333-8333-333333333333';
    const properties={Name:{id:'title',name:'Name',type:'title',title:{}},Status:{id:'status',name:'Status',type:'status',status:{options:[{id:'todo',name:'To do'},{id:'done',name:'Done'}],groups:[]}}};
    const page=(id,name)=>({object:'page',id,url:`https://www.notion.so/${id.replaceAll('-','')}`,parent:{data_source_id:source},last_edited_time:'2026-10-30T00:00:00.000Z',properties:{Name:{id:'title',type:'title',title:[{plain_text:name}]},Status:{id:'status',type:'status',status:{id:'todo',name:'To do'}}}});
    globalThis.fetch=async input=>{
      const url=new URL(String(input)),p=url.pathname,reply=body=>new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
      if(url.origin!=='https://api.notion.com')throw new Error('Unexpected network request in planning smoke');
      if(p==='/v1/users/me')return reply({object:'user',id:'planning-fixture-user'});
      if(p===`/v1/databases/${database}`)return reply({object:'database',id:database,data_sources:[{id:source,name:'Fixture tasks'}]});
      if(p===`/v1/data_sources/${source}`)return reply({object:'data_source',id:source,parent:{database_id:database},title:[{plain_text:'Fixture tasks'}],properties});
      if(p===`/v1/data_sources/${source}/query`)return reply({results:[page('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Write report'),page('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Review notes')],has_more:false});
      throw new Error('Unexpected fixture route '+p);
    };
  });
  await page.evaluate(()=>window.desktop.connect('planning-fixture-token-only'));
  await page.getByRole('button',{name:'Planning',exact:true}).click();
  const start=page.getByLabel('Start hour',{exact:true}),end=page.getByLabel('End hour',{exact:true});

  // Typing, replacing, and clearing leave the saved value alone until commit.
  await start.fill('');assert.deepEqual(await hours(),[9,17]);assert.equal(await start.inputValue(),'');
  await start.pressSequentially('1');await start.pressSequentially('0');assert.deepEqual(await hours(),[9,17]);
  await start.press('Enter');await page.waitForFunction(()=>window.desktop.getState().then(s=>s.planning.settings.startHour===10));

  // Keyboard-only: tab into End, select its text, replace, and leave the field.
  await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('aria-label')),'End hour');
  await page.keyboard.press('Control+A');await page.keyboard.type('18');await page.keyboard.press('Tab');
  await page.waitForFunction(()=>window.desktop.getState().then(s=>s.planning.settings.endHour===18));

  // Arrow-key stepping still works.
  await end.focus();await page.keyboard.press('ArrowUp');assert.equal(await end.inputValue(),'19');await page.keyboard.press('Enter');
  await page.waitForFunction(()=>window.desktop.getState().then(s=>s.planning.settings.endHour===19));

  // Invalid values keep the draft, explain why, and save nothing.
  await end.fill('30');await end.press('Enter');await page.getByRole('alert').filter({hasText:'from 1 to 24'}).waitFor();
  assert.equal(await end.getAttribute('aria-invalid'),'true');assert.equal(await end.inputValue(),'30');assert.deepEqual(await hours(),[10,19]);
  await end.press('Escape');assert.equal(await end.inputValue(),'19');

  // A later start can wait for its matching end, then both save together.
  await start.fill('20');await start.press('Enter');await page.getByRole('alert').filter({hasText:'later than the start'}).waitFor();
  await end.fill('22');await end.press('Enter');await page.waitForFunction(()=>window.desktop.getState().then(s=>s.planning.settings.startHour===20&&s.planning.settings.endHour===22));

  // Local fallback lives in Diagnostics, and the planning view names the data it is using.
  assert.equal(await page.getByLabel('Import ICS calendar',{exact:true}).count(),0);
  await page.getByRole('status').filter({hasText:'No calendar connected'}).getByRole('button',{name:'Open Diagnostics',exact:true}).click();
  await page.getByRole('heading',{name:'Calendar fallback tools',exact:true}).waitFor();
  const zone=await page.evaluate(()=>window.desktop.getState().then(s=>s.planning.settings.timezone));
  const stamp=date=>date.toISOString().replace(/[-:]|\.\d{3}/g,'');
  const tomorrow=new Date();tomorrow.setDate(tomorrow.getDate()+1);tomorrow.setHours(10,0,0,0);
  const last=new Date();last.setDate(last.getDate()+6);const lastDate=last.toLocaleDateString(undefined,{timeZone:zone});
  const pad=n=>String(n).padStart(2,'0');
  const dentist={local:`${tomorrow.getFullYear()}-${pad(tomorrow.getMonth()+1)}-${pad(tomorrow.getDate())}T10:00`};
  await page.getByLabel('Import ICS calendar',{exact:true}).setInputFiles({name:'snapshot.ics',mimeType:'text/calendar',buffer:Buffer.from(`BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:snapshot\r\nDTSTART:${stamp(tomorrow)}\r\nDTEND:${stamp(new Date(tomorrow.getTime()+3600000))}\r\nSUMMARY:Imported dentist\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`)});
  await page.getByText('Imported dentist',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Planning',exact:true}).click();
  await page.getByRole('status').filter({hasText:'Planning from local data'}).waitFor();

  // Proposals appear on the week calendar, and moves stay drafts until approval.
  const candidates=await page.evaluate(()=>window.desktop.resolveSource('https://www.notion.so/11111111111141118111111111111111'));
  await page.evaluate(candidate=>window.desktop.saveSource({...candidate,mapping:{title:'title',due:null,status:'status',complete:'done',reopen:'todo'}}),candidates[0]);
  await page.waitForFunction(()=>window.desktop.getState().then(s=>s.tasks.length===2&&s.sync.onlineSources.length===1));
  const refs=await page.evaluate(()=>window.desktop.getState().then(s=>s.tasks.map(t=>({provider:'notion',sourceId:t.sourceId,taskId:t.id,name:t.name}))));
  for(const {name,...ref} of refs)await page.evaluate(([value,minutes])=>window.desktop.setTaskEstimate(value,minutes),[ref,name==='Write report'?60:30]);
  await page.evaluate(()=>window.desktop.updatePlanningSettings({workdays:[1,2,3,4,5,6,7],startHour:8,endHour:18}));
  await page.getByRole('button',{name:'Planning',exact:true}).click();
  await page.getByText('Nothing is written to a calendar until you approve it.',{exact:false}).waitFor();
  await page.getByRole('button',{name:'Generate plan',exact:true}).click();
  const proposed=name=>page.getByRole('button',{name:new RegExp('^Proposed: '+name)});
  await proposed('Write report').waitFor();assert.equal(await page.locator('.plan-week-day').count(),7);
  assert.equal(await page.locator('.plan-block.event').filter({hasText:'Imported dentist'}).count(),1);
  const blocks=()=>page.evaluate(()=>window.desktop.getState().then(s=>s.planning.blocks));

  const lastDay=page.locator('.plan-week-body').nth(6);
  await proposed('Write report').scrollIntoViewIfNeeded();
  await proposed('Write report').dragTo(lastDay,{targetPosition:{x:30,y:200}});
  await page.getByText('Moved by you',{exact:false}).waitFor();
  const moved=await proposed('Write report').getAttribute('aria-label');
  assert.equal((await lastDay.locator('.plan-block.proposed').count()),1);assert.deepEqual(await blocks(),[]);

  await proposed('Write report').focus();await page.keyboard.press('ArrowDown');
  await page.waitForFunction(label=>![...document.querySelectorAll('.plan-block.proposed')].some(x=>x.getAttribute('aria-label')===label),moved);
  const nudged=await proposed('Write report').getAttribute('aria-label');

  await page.getByLabel('New time for Review notes',{exact:true}).fill(dentist.local);
  await page.locator('.placement-form').filter({has:page.getByLabel('New time for Review notes',{exact:true})}).getByRole('button',{name:'Move',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'overlaps Imported dentist'}).waitFor();

  await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'Planning',exact:true}).click();
  assert.equal(await proposed('Write report').getAttribute('aria-label'),nudged);

  await page.locator('.plan-week').screenshot({path:path.join(root,'.cache','plan-week.png')});
  await page.evaluate(()=>window.desktop.setSettings({theme:'dark'}));await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
  await page.locator('.plan-week').screenshot({path:path.join(root,'.cache','plan-week-dark.png')});
  await page.getByRole('button',{name:'Approve selected',exact:true}).click();
  await page.waitForFunction(()=>window.desktop.getState().then(s=>s.planning.blocks.length===2));
  const approved=await blocks();const report=approved.find(b=>b.ref.taskId===refs.find(r=>r.name==='Write report').taskId);
  assert.equal(new Date(report.end)-new Date(report.start),3600000);
  assert.equal(new Date(report.start).toLocaleDateString(undefined,{timeZone:zone}),lastDate);

  // Approved blocks move only after Save move; calendar events cannot be dragged.
  assert.equal(await page.locator('button.plan-block.event').count(),0);
  const approvedBlock=name=>page.getByRole('button',{name:new RegExp('^(Approved|Unsaved move): '+name)});
  await approvedBlock('Write report').scrollIntoViewIfNeeded();
  await approvedBlock('Write report').focus();await page.keyboard.press('ArrowUp');
  await page.getByRole('button',{name:'Save move',exact:true}).waitFor();
  assert.equal((await blocks()).find(b=>b.id===report.id).start,report.start);
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'Save move',exact:true}).count(),0);
  await approvedBlock('Write report').dragTo(lastDay,{targetPosition:{x:30,y:40}});
  await page.getByRole('button',{name:'Save move',exact:true}).click();
  await page.waitForFunction(([id,old])=>window.desktop.getState().then(s=>s.planning.blocks.find(b=>b.id===id).start!==old),[report.id,report.start]);
  const movedBlock=(await blocks()).find(b=>b.id===report.id);
  assert.equal(new Date(movedBlock.end)-new Date(movedBlock.start),3600000);

  assert.deepEqual(errors,[]);
  console.log('Planning UI smoke passed');
} finally {await app.close();}
