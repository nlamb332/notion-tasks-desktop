import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { build } from 'esbuild';
import electron from 'electron';
const preview = process.argv.includes('--preview');
const previewUserData = path.join(process.cwd(), '.cache', 'dev-preview');
if (preview) await mkdir(previewUserData, { recursive: true });
await build({ entryPoints: { main: 'src/main/index.ts', preload: 'src/preload.ts' }, outdir: 'dist-electron', outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], sourcemap: true });
const server = await createServer();
await server.listen();
const child = spawn(electron, ['.'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    VITE_DEV_SERVER_URL: 'http://127.0.0.1:5173',
    ...(preview ? { NOTION_TASKS_CHANNEL: 'preview', NOTION_TASKS_USER_DATA: previewUserData } : {}),
  },
});
child.on('exit', async code => { await server.close(); process.exit(code ?? 0); });
process.on('SIGINT', () => child.kill());
