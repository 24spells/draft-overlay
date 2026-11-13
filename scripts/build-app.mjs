// Turns core/ and overlay/ into plain JavaScript for the real app.
// Uses only Node, so there is no bundler to install.

import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';

process.removeAllListeners('warning');

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'app', 'build');

rmSync(OUT, { recursive: true, force: true });

for (const folder of ['core', 'coach', 'overlay']) {
  mkdirSync(path.join(OUT, folder), { recursive: true });
  for (const name of readdirSync(path.join(ROOT, folder))) {
    if (!name.endsWith('.ts')) {
      continue;
    }
    const source = readFileSync(path.join(ROOT, folder, name), 'utf8');
    const output = stripTypeScriptTypes(source).replace(
      /(from\s+'\.{1,2}\/[^']+)\.ts'/g,
      "$1.js'",
    );
    writeFileSync(path.join(OUT, folder, name.replace(/\.ts$/, '.js')), output);
  }
}

copyFileSync(path.join(ROOT, 'overlay', 'overlay.css'), path.join(OUT, 'overlay.css'));
console.log('App build written to app/build');
