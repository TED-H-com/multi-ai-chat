const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

const packageJson = readJson('package.json');
const packageLock = readJson('package-lock.json');
const sourceManifest = readJson('public/manifest.json');
const builtManifest = readJson('dist/manifest.json');

const versions = new Map([
  ['package.json', packageJson.version],
  ['package-lock.json', packageLock.version],
  ['package-lock.json packages[""]', packageLock.packages?.['']?.version],
  ['public/manifest.json', sourceManifest.version],
  ['dist/manifest.json', builtManifest.version],
]);

const expected = packageJson.version;
const mismatches = [...versions].filter(([, version]) => version !== expected);

if (mismatches.length > 0) {
  const details = mismatches.map(([file, version]) => `${file}: ${String(version)}`).join('\n');
  throw new Error(`Extension versions must all match ${expected}:\n${details}`);
}

console.log(`Version ${expected} is consistent across package and manifest files.`);
