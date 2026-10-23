import { readFile } from 'node:fs/promises';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;

if (!tag) {
  console.error('Usage: npm run validate:release -- v0.1.5-rc.1');
  process.exit(1);
}

const tagVersion = tag.replace(/^v/, '');
if (tagVersion !== packageJson.version) {
  console.error(`Release tag ${tag} does not match package version ${packageJson.version}.`);
  process.exit(1);
}

const channel = packageJson.version.includes('-') ? 'preview' : 'stable';
console.log(`Validated ${channel} release ${tag}.`);
