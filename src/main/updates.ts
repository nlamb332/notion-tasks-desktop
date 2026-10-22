import type { AppUpdater } from 'electron-updater';
import type { AppUpdateState } from '../shared/types';

type Engine = Pick<AppUpdater, 'autoDownload' | 'autoInstallOnAppQuit' | 'allowPrerelease' | 'allowDowngrade' | 'on' | 'checkForUpdates' | 'downloadUpdate' | 'quitAndInstall'>;

/** Only the main process selects the feed and starts executable downloads. */
export class UpdateController {
  private state: AppUpdateState;
  private engine: Promise<Engine> | null = null;

  constructor(
    version: string,
    supported: boolean,
    private readonly loadEngine: () => Promise<Engine>,
    private readonly notify: (state: AppUpdateState) => void,
    private readonly prepareInstall: () => void,
    private readonly cancelInstall: () => void = () => {},
  ) {
    this.state = { currentVersion: version, status: supported ? 'idle' : 'unsupported' };
  }

  snapshot(): AppUpdateState { return { ...this.state }; }

  private set(patch: Partial<AppUpdateState>) {
    this.state = { ...this.state, ...patch };
    this.notify(this.snapshot());
  }

  private failure() {
    if (this.state.status === 'installing') this.cancelInstall();
    // Avoid exposing provider errors (which can contain URLs or environment details).
    this.set({ status: 'error', message: 'Could not update. Check your internet connection and try checking again.' });
  }

  private getEngine(): Promise<Engine> {
    if (!this.engine) {
      this.engine = this.loadEngine().then(engine => {
        engine.autoDownload = false;
        engine.autoInstallOnAppQuit = false;
        engine.allowPrerelease = false;
        engine.allowDowngrade = false;
        engine.on('update-available', info => this.set({ status: 'available', latestVersion: info.version }));
        engine.on('update-not-available', () => this.set({ status: 'current' }));
        engine.on('download-progress', progress => this.set({ status: 'downloading', progress: Math.max(0, Math.min(100, progress.percent)) }));
        engine.on('update-downloaded', info => this.set({ status: 'downloaded', latestVersion: info.version, progress: 100 }));
        engine.on('error', () => this.failure());
        return engine;
      }).catch(error => { this.engine = null; throw error; });
    }
    return this.engine;
  }

  async check(): Promise<AppUpdateState> {
    if (['unsupported', 'checking', 'downloading', 'downloaded', 'installing'].includes(this.state.status)) return this.snapshot();
    this.set({ status: 'checking', latestVersion: undefined, progress: undefined, message: undefined });
    try { await (await this.getEngine()).checkForUpdates(); }
    catch { this.failure(); }
    return this.snapshot();
  }

  async download(): Promise<AppUpdateState> {
    if (this.state.status !== 'available') return this.snapshot();
    this.set({ status: 'downloading', progress: 0, message: undefined });
    try { await (await this.getEngine()).downloadUpdate(); }
    catch { this.failure(); }
    return this.snapshot();
  }

  async install(): Promise<AppUpdateState> {
    if (this.state.status !== 'downloaded') throw new Error('Download an update before installing it.');
    const engine = await this.getEngine();
    if (this.state.status !== 'downloaded') return this.snapshot();
    this.prepareInstall();
    this.set({ status: 'installing' });
    // Let the IPC response reach the renderer before the process exits.
    setImmediate(() => {
      try { engine.quitAndInstall(false, true); }
      catch { this.failure(); }
    });
    return this.snapshot();
  }
}
