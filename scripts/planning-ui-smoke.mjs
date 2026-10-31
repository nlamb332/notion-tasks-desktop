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
  await app.evaluate(()=>{globalThis.fetch=async input=>{const url=new URL(String(input));if(url.origin==='https://api.notion.com'&&url.pathname==='/v1/users/me')return new Response(JSON.stringify({object:'user',id:'planning-fixture-user'}),{status:200,headers:{'Content-Type':'application/json'}});throw new Error('Unexpected network request in planning smoke');};});
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

  assert.deepEqual(errors,[]);
  console.log('Planning UI smoke passed');
} finally {await app.close();}
