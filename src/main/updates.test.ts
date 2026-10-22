import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { UpdateController } from './updates';

function setup(supported = true) {
  const engine = Object.assign(new EventEmitter(), {
    autoDownload: true, autoInstallOnAppQuit: true, allowPrerelease: true, allowDowngrade: true,
    checkForUpdates: vi.fn(async () => { engine.emit('update-available', { version: '0.2.0' }); return null; }),
    downloadUpdate: vi.fn(async () => {
      engine.emit('download-progress', { percent: 42 });
      engine.emit('update-downloaded', { version: '0.2.0' });
      return [];
    }),
    quitAndInstall: vi.fn(),
  });
  const notify = vi.fn();
  const prepare = vi.fn();
  const cancel = vi.fn();
  const loader = vi.fn(async () => engine as any);
  return { engine, notify, prepare, cancel, loader, controller: new UpdateController('0.1.4', supported, loader, notify, prepare, cancel) };
}

describe('desktop updates', () => {
  it.each(['throw', 'event'])('restores normal window behavior when installation fails via %s', async mode => {
    const s = setup();
    await s.controller.check(); await s.controller.download();
    s.engine.quitAndInstall.mockImplementationOnce(() => {
      if (mode === 'throw') throw new Error('Installer failed');
      s.engine.emit('error', new Error('Installer failed'));
    });
    await s.controller.install();
    await new Promise(resolve => setImmediate(resolve));
    expect(s.prepare).toHaveBeenCalledTimes(1);
    expect(s.cancel).toHaveBeenCalledTimes(1);
    expect(s.controller.snapshot().status).toBe('error');
    await s.controller.check(); await s.controller.download(); await s.controller.install();
    await new Promise(resolve => setImmediate(resolve));
    expect(s.controller.snapshot().status).toBe('installing');
    expect(s.engine.quitAndInstall).toHaveBeenCalledTimes(2);
  });

  it('does not access the feed in development mode', async () => {
    const s = setup(false);
    expect((await s.controller.check()).status).toBe('unsupported');
    expect((await s.controller.download()).status).toBe('unsupported');
    expect(s.loader).not.toHaveBeenCalled();
  });

  it('downloads only on request and installs only after a verified download', async () => {
    const s = setup();
    await expect(s.controller.install()).rejects.toThrow('Download');
    await s.controller.check();
    expect(s.controller.snapshot()).toMatchObject({ currentVersion: '0.1.4', latestVersion: '0.2.0', status: 'available' });
    expect(s.engine).toMatchObject({ autoDownload: false, autoInstallOnAppQuit: false, allowPrerelease: false, allowDowngrade: false });
    expect(s.engine.downloadUpdate).not.toHaveBeenCalled();
    await s.controller.download();
    expect(s.notify).toHaveBeenCalledWith(expect.objectContaining({ status: 'downloading', progress: 42 }));
    expect(s.controller.snapshot().status).toBe('downloaded');
    expect(s.engine.quitAndInstall).not.toHaveBeenCalled();
    await Promise.all([s.controller.install(), s.controller.install()]);
    await new Promise(resolve => setImmediate(resolve));
    expect(s.prepare).toHaveBeenCalledTimes(1);
    expect(s.engine.quitAndInstall).toHaveBeenCalledExactlyOnceWith(false, true);
  });

  it('retains a ready update when active task writes prevent restart', async () => {
    const s = setup();
    await s.controller.check(); await s.controller.download();
    s.prepare.mockImplementation(() => { throw new Error('Wait for task changes'); });
    await expect(s.controller.install()).rejects.toThrow('Wait');
    expect(s.controller.snapshot().status).toBe('downloaded');
    expect(s.engine.quitAndInstall).not.toHaveBeenCalled();
  });

  it('allows retry after feed failures without leaking raw provider errors', async () => {
    const s = setup();
    s.engine.checkForUpdates.mockRejectedValueOnce(new Error('private provider URL'));
    expect((await s.controller.check()).status).toBe('error');
    expect(s.controller.snapshot().message).not.toContain('private');
    s.engine.checkForUpdates.mockImplementationOnce(async () => { s.engine.emit('update-not-available', { version: '0.1.4' }); return null; });
    expect((await s.controller.check()).status).toBe('current');
  });

  it('prevents duplicate downloads and blocks install after checksum/network errors', async () => {
    const s = setup();
    await s.controller.check();
    s.engine.downloadUpdate.mockImplementationOnce(async () => {
      await Promise.resolve();
      s.engine.emit('error', new Error('sha512 mismatch'));
      throw new Error('sha512 mismatch');
    });
    await Promise.all([s.controller.download(), s.controller.download()]);
    expect(s.engine.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(s.controller.snapshot().status).toBe('error');
    await expect(s.controller.install()).rejects.toThrow('Download');
  });
});
