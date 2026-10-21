import { build } from 'esbuild';
await build({ entryPoints: { main: 'src/main/index.ts', preload: 'src/preload.ts' }, outdir: 'dist-electron', outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], sourcemap: true });
