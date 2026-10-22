import { _electron as electron, expect } from '@playwright/test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
await mkdir(path.join(root, '.cache'), { recursive: true });
const data = await mkdtemp(path.join(root, '.cache', 'updates-'));
const app = await electron.launch({ args: ['.'], env: { ...process.env, NOTION_TASKS_USER_DATA: data }, timeout: 30000 });
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => !!window.desktop);
  await page.getByRole('button', { name: 'Preferences', exact: true }).click();
  await expect(page.getByText('Installed version: 0.1.4')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check for updates', exact: true })).toBeDisabled();

  // Simulate an installed build with a mock engine. Never download or run an installer.
  assert.deepEqual(errors, []);
} finally { await app.close(); }

const installed = await electron.launch({ args: ['.'], env: { ...process.env, NOTION_TASKS_USER_DATA: data }, timeout: 30000 });
try {
  const page = await installed.firstWindow();
  await page.waitForFunction(() => !!window.desktop);
  await installed.evaluate(({ app }) => {
    Object.defineProperty(app, 'isPackaged', { configurable: true, value: true });
    const updater = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')('electron-updater').autoUpdater;
    globalThis.__updateFixture = { installs: 0, checks: 0 };
    updater.checkForUpdates = async () => {
      globalThis.__updateFixture.checks++;
      updater.emit('update-available', { version: '0.2.0' });
      return null;
    };
    updater.downloadUpdate = async () => {
      updater.emit('download-progress', { percent: 50 });
      updater.emit('update-downloaded', { version: '0.2.0' });
      return [];
    };
    updater.quitAndInstall = () => { globalThis.__updateFixture.installs++; };
  });
  await page.getByRole('button', { name: 'Preferences', exact: true }).click();
  await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
  await expect(page.getByText('Version 0.2.0 is available.')).toBeVisible();
  await page.getByRole('button', { name: 'Download update', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Restart and install', exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(root, '.cache', 'app-updates.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: path.join(root, '.cache', 'app-updates-dark.png') });
  assert.equal(await installed.evaluate(() => globalThis.__updateFixture.installs), 0);
  await page.getByRole('button', { name: 'Restart and install', exact: true }).click();
  await expect.poll(() => installed.evaluate(() => globalThis.__updateFixture.installs)).toBe(1);
  console.log(JSON.stringify({ result: 'PASS', checks: ['development gate', 'version display', 'check releases', 'download opt-in', 'restart opt-in', 'light/dark layouts'] }));
} finally { await installed.close(); }
