import { readFile } from 'node:fs/promises';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
if (!/-[0-9A-Za-z]/.test(packageJson.version)) {
  console.error(`Preview packaging requires a prerelease package version, received ${packageJson.version}.`);
  console.error('Use a version such as 0.1.5-rc.1 before running npm run package:preview.');
  process.exit(1);
}

console.log(`Validated preview package ${packageJson.version}.`);
