// Ship a new Draft Overlay version (2026-11-14, plan: MTG AI references/overlay-public-plan.md).
//
//   npm run release -- [patch|minor|major] [--notes "first change|second change"] [--min] [--dry]
//
// 1. Bumps the version in package.json.
// 2. Builds the installer with the release feed baked in (app-update.yml), so installed copies update
//    themselves from GitHub Releases (electron-updater), and uploads it as a published release.
// 3. Writes 23spells' public/overlay/latest.json: the download button's link, the version, the notes,
//    and (with --min) the minimum version older overlays are asked to update to.
// 4. Tells you to publish the site (cd draft-trainer && npm run publish) so the download page updates.
//
// --dry builds everything (feed included) but uploads nothing and leaves latest.json alone.
//
// Needs (once): release.config.json with the GitHub owner and repo, and a GitHub token with
// "contents: write" on that repo in ~/.draft-trainer-secrets/github.env as GH_TOKEN=...
// (outside Drive and this repo). Until those exist this stops with instructions.
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const bump = ['patch', 'minor', 'major'].find((b) => args.includes(b)) ?? 'patch';
const dry = args.includes('--dry');
const raiseMin = args.includes('--min');
const notesAt = args.indexOf('--notes');
const notes = notesAt >= 0 ? String(args[notesAt + 1] ?? '').split('|').map((s) => s.trim()).filter(Boolean) : [];

const config = JSON.parse(readFileSync(path.join(ROOT, 'release.config.json'), 'utf8'));
const stop = (why) => {
  console.error(`\nRelease stopped: ${why}\n`);
  process.exit(1);
};
if (!config.owner || !config.repo) {
  stop('release.config.json has no GitHub "owner" and "repo" yet. Make the repo (public, so downloads and updates need no login), fill both in, and run again.');
}
const SECRETS = '~/.draft-trainer-secrets/github.env';
let token = process.env.GH_TOKEN ?? '';
if (!token && existsSync(SECRETS)) token = /^GH_TOKEN=(.+)$/m.exec(readFileSync(SECRETS, 'utf8'))?.[1]?.trim() ?? '';
if (!dry && !token) stop(`no GitHub token. Put GH_TOKEN=... in ${SECRETS} (a fine-grained token with Contents: write on ${config.owner}/${config.repo}).`);

// 1. Version.
const pkgPath = path.join(ROOT, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const [ma, mi, pa] = pkg.version.split('.').map(Number);
// A dry run rebuilds the current version, so it can be repeated freely.
const version = dry ? pkg.version : bump === 'major' ? `${ma + 1}.0.0` : bump === 'minor' ? `${ma}.${mi + 1}.0` : `${ma}.${mi}.${pa + 1}`;
if (!dry) {
  pkg.version = version;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
}
console.log(`Draft Overlay ${version}${dry ? ' (dry run: nothing uploaded)' : ''}`);

// 2. Build (+ upload). The feed config is passed here, not kept in package.json, so a plain
// `npm run dist` makes a build that never checks for updates.
const feed = [
  '-c.publish.provider=github',
  `-c.publish.owner=${config.owner}`,
  `-c.publish.repo=${config.repo}`,
  '-c.publish.releaseType=release',
].join(' ');
execSync(`node scripts/build-app.mjs && npx electron-builder --win nsis ${feed} --publish ${dry ? 'never' : 'always'}`, {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, ...(token ? { GH_TOKEN: token } : {}) },
});
if (dry) {
  console.log(`\nBuilt dist/${pkg.build.artifactName.replace('${ext}', 'exe')}. Dry run: no upload, latest.json unchanged.`);
  process.exit(0);
}

// 3. The site's release file.
const site = config.site ?? '~/draft-trainer';
const latestPath = path.join(site, 'public', 'overlay', 'latest.json');
let latest = {};
try {
  latest = JSON.parse(readFileSync(latestPath, 'utf8'));
} catch {
  // First release.
}
const file = pkg.build.artifactName.replace('${ext}', 'exe');
const next = {
  version,
  min: raiseMin ? version : (latest.min ?? '0.0.0'),
  released: new Date().toISOString(),
  download: `https://github.com/${config.owner}/${config.repo}/releases/latest/download/${file}`,
  notes,
};
writeFileSync(latestPath, JSON.stringify(next) + '\n');
console.log(`\nReleased ${version}. Installed overlays pick it up within 6 hours (or at their next start).`);
console.log(`Updated ${latestPath}.\nNext: cd ${site} && npm run publish   (updates the download page${raiseMin ? ' and asks older overlays to update' : ''})`);
