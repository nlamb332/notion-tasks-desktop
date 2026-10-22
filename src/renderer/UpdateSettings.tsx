import { useEffect, useState } from 'react';
import type { AppUpdateState } from '../shared/types';

export function UpdateSettings() {
  const [state, setState] = useState<AppUpdateState | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const stop = window.desktop.onUpdateState(next => { if (active) setState(next); });
    void window.desktop.getUpdateState().then(next => { if (active) setState(next); }).catch(() => { if (active) setError('Unable to load update information.'); });
    return () => { active = false; stop(); };
  }, []);

  async function action(operation: () => Promise<AppUpdateState>) {
    setError('');
    try { setState(await operation()); }
    catch (error) { setError(error instanceof Error ? error.message : 'Unable to update. Try again.'); }
  }

  const status = state?.status;
  const message = status === 'unsupported' ? 'Updates are available in the installed Windows app.'
    : status === 'checking' ? 'Checking GitHub for updates…'
    : status === 'current' ? 'You’re using the latest version.'
    : status === 'available' ? `Version ${state?.latestVersion} is available.`
    : status === 'downloading' ? `Downloading update… ${Math.round(state?.progress ?? 0)}%`
    : status === 'downloaded' ? `Version ${state?.latestVersion} is ready. Save any open draft before restarting.`
    : status === 'installing' ? 'Restarting to install the update…'
    : status === 'error' ? state?.message : 'Check for a newer version on GitHub.';
  return <div className="app-updates">
    <h3>App updates</h3>
    {state ? <p className="muted">Installed version: {state.currentVersion}</p> : null}
    <p role="status" aria-live="polite">{message}</p>
    {status === 'downloading' ? <progress aria-label="Update download progress" max={100} value={state?.progress ?? 0} /> : null}
    {error ? <p role="alert" className="update-error">{error}</p> : null}
    <div className="update-actions">
      <button className="button button-secondary" disabled={!state || ['unsupported', 'checking', 'downloading', 'downloaded', 'installing'].includes(status ?? '')} onClick={() => void action(() => window.desktop.checkForUpdates())}>{status === 'checking' ? 'Checking…' : 'Check for updates'}</button>
      {status === 'available' ? <button className="button button-primary" onClick={() => void action(() => window.desktop.downloadUpdate())}>Download update</button> : null}
      {status === 'downloaded' ? <button className="button button-primary" onClick={() => void action(() => window.desktop.installUpdate())}>Restart and install</button> : null}
    </div>
  </div>;
}
