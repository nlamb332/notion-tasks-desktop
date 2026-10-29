import { _electron as electron, expect } from '@playwright/test';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// All HTTP responses are synthetic. This test never contacts a Plane workspace.
const root = process.cwd();
await mkdir(path.join(root, '.cache'), { recursive: true });
const data = await mkdtemp(path.join(root, '.cache', 'plane-'));
const app = await electron.launch({ args: ['.'], env: { ...process.env, NOTION_TASKS_USER_DATA: data }, timeout: 30000 });
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => Boolean(window.desktop));
  await app.evaluate(() => {
    const projectId = '11111111-1111-4111-8111-111111111111';
    const itemId = '22222222-2222-4222-8222-222222222222';
    const states = [
      { id: 'open', name: 'Backlog', group: 'backlog', sequence: 0, default: true },
      { id: 'progress', name: 'In progress', group: 'started', sequence: 1 },
      { id: 'done', name: 'Done', group: 'completed', sequence: 2 },
    ];
    const project = { id: projectId, name: 'Plane fixture', identifier: 'FIX' };
    const f = globalThis.__planeFixture = {
      project, states, offline: false, writes: [], next: 1,
      items: { [itemId]: { id: itemId, project: projectId, name: 'Review Plane integration', state: 'open', target_date: '2026-10-29', updated_at: '2026-10-28T10:00:00Z', sequence_id: 1 } },
    };
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      const method = init.method || 'GET';
      const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      if (url.origin === 'https://api.notion.com' && url.pathname === '/v1/users/me') return reply({ id: 'notion-fixture-user' });
      if (url.origin !== 'https://api.plane.so') throw new Error('Unexpected network request');
      if (init.headers?.['X-API-Key'] !== 'plane-fixture-key') throw new Error('Missing Plane authentication header');
      if (f.offline) return reply({ detail: 'Fixture unavailable' }, 503);
      const route = url.pathname.replace(/^\/api\/v1/, '');
      const collection = values => reply({ results: values, next_page_results: false, next_cursor: '' });
      if (route === '/users/me/') return reply({ id: 'plane-fixture-user' });
      if (route === '/workspaces/fixture/projects/') return collection([project]);
      if (route === `/workspaces/fixture/projects/${projectId}/`) return reply(project);
      if (route === `/workspaces/fixture/projects/${projectId}/states/`) return collection(states);
      const match = route.match(/\/projects\/[^/]+\/(?:work-items|issues)\/(?:([^/]+)\/)?$/);
      if (!match) throw new Error(`Unhandled Plane route: ${method} ${route}`);
      const id = match[1];
      const expanded = item => ({ ...item, state: states.find(state => state.id === item.state) ?? item.state });
      if (method === 'GET') return id ? reply(f.items[id] ? expanded(f.items[id]) : {}, f.items[id] ? 200 : 404) : collection(Object.values(f.items).map(expanded));
      const body = JSON.parse(init.body);
      f.writes.push({ method, body });
      if (method === 'POST') {
        const newId = `33333333-3333-4333-8333-${String(f.next++).padStart(12, '0')}`;
        const created = { id: newId, project: projectId, state: 'open', target_date: null, sequence_id: f.next, ...body, updated_at: new Date().toISOString() };
        f.items[newId] = created;
        return reply(created, 201);
      }
      if (method === 'PATCH' && f.items[id]) {
        Object.assign(f.items[id], body, { updated_at: new Date().toISOString() });
        return reply(f.items[id]);
      }
      throw new Error(`Unhandled Plane write: ${method} ${route}`);
    };
  });

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Connection', exact: true }).click();
  await page.getByRole('textbox', { name: 'Plane API key', exact: true }).fill('plane-fixture-key');
  await page.getByRole('textbox', { name: 'Plane workspace slug', exact: true }).fill('fixture');
  await page.getByRole('button', { name: 'Connect Plane', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Plane API key', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Sources', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Plane project', exact: true })).toBeEnabled();
  await page.getByRole('combobox', { name: 'Plane project', exact: true }).selectOption({ label: 'Plane fixture' });
  await page.getByRole('button', { name: 'Save source', exact: true }).click();
  await expect(page.locator('.source-card')).toHaveCount(1);
  await page.screenshot({ path: path.join(root, '.cache', 'plane-setup.png') });
  const source = (await page.evaluate(() => window.desktop.getState())).sources[0];
  assert.equal(source.provider, 'plane');
  await page.evaluate(() => window.desktop.setSettings({ selectedList: 'all' }));
  await page.reload();
  await page.getByRole('button', { name: 'Open Review Plane integration', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open in Plane', exact: true })).toBeVisible();
  await expect(page.locator('.detail-panel input[type="time"]')).toBeDisabled();
  await page.getByRole('textbox', { name: 'Task title', exact: true }).fill('Plane task revised');
  await page.locator('.detail-panel input[type="date"]').fill('2026-11-03');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByRole('button', { name: 'Open Plane task revised', exact: true }).waitFor();
  await page.screenshot({ path: path.join(root, '.cache', 'plane-details.png') });
  await page.getByRole('button', { name: 'Close task details', exact: true }).click();
  const completeTask = async () => {
    const state = await page.evaluate(() => window.desktop.getState());
    return state.tasks.find(task => task.name === 'Plane task revised');
  };
  const revised = await completeTask();
  assert.equal(revised.due.start, '2026-11-03');
  await page.getByRole('button', { name: 'Complete Plane task revised', exact: true }).click();
  await expect.poll(async () => (await completeTask()).completed).toBe(true);
  const completed = await completeTask();
  const reopened = await page.evaluate(task => window.desktop.updateTask(task.id, { status: 'Backlog' }, task), completed);
  assert.equal(reopened.task.completed, false);
  await page.getByRole('button', { name: 'Add a task', exact: true }).click();
  await page.getByRole('textbox', { name: 'Task title', exact: true }).fill('Created in Plane interface');
  await page.getByRole('combobox', { name: 'New task source', exact: true }).selectOption(source.id);
  await expect(page.locator('.draft-panel input[type="time"]')).toBeDisabled();
  await page.getByRole('button', { name: 'Create task', exact: true }).click();
  await page.getByRole('button', { name: 'Open Created in Plane interface', exact: true }).waitFor();
  await page.evaluate(() => window.desktop.setSettings({ compact: true }));
  await expect(page.locator('.compact-shell')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open Created in Plane interface', exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(root, '.cache', 'plane-compact.png') });
  await page.evaluate(() => window.desktop.setSettings({ compact: false }));

  // A stale edit is rejected before PATCH, preserving remote changes.
  const baseline = await completeTask();
  await app.evaluate(() => { Object.values(globalThis.__planeFixture.items)[0].name = 'Changed remotely'; });
  const conflict = await page.evaluate(task => window.desktop.updateTask(task.id, { name: 'Stale draft' }, task), baseline);
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.task.name, 'Changed remotely');

  // Disconnecting one provider preserves the other and cached read-only tasks.
  await page.evaluate(() => window.desktop.connect('notion-fixture-key'));
  await page.evaluate(() => window.desktop.disconnect('plane'));
  const disconnected = await page.evaluate(() => window.desktop.getState());
  assert.equal(disconnected.connected, true);
  assert.equal(disconnected.sync.onlineSources.includes(source.id), false);
  assert.equal(disconnected.tasks.length, 2);
  await assert.rejects(page.evaluate(task => window.desktop.updateTask(task.id, { name: 'Offline edit' }, task), conflict.task), /offline|connect/i);
  const persisted = await readFile(path.join(data, 'state.json'), 'utf8');
  assert.ok(!persisted.includes('plane-fixture-key'));
  const savedSource = JSON.parse(persisted).sources.find(item => item.id === source.id);
  assert.equal(savedSource.provider, 'plane');
  assert.equal(savedSource.workspaceSlug, 'fixture');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'PASS', checks: ['Plane bridge authentication', 'project discovery', 'task display', 'date-only editing', 'complete and reopen', 'create through interface', 'compact view', 'conflict protection', 'independent disconnect', 'offline write blocked', 'provider metadata persisted', 'no plaintext key in state'], data, screenshots: ['.cache/plane-details.png', '.cache/plane-compact.png'] }, null, 2));
} finally {
  await app.close();
}
