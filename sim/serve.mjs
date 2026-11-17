// Local-only server for the preview. Strips TypeScript types on the way out,
// so the preview needs nothing installed beyond Node.
//
//   node sim/serve.mjs

import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.PORT ?? 5199);
const FOLDERS = new Set(['sim', 'core', 'coach', 'overlay', 'card-data', 'sim-data']);
// The coach hint's files: the web trainer's, from the site (as the real app does).
const COACH_SITE = 'https://24spells.com/sets';
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/') {
      response.writeHead(302, { Location: '/sim/index.html' }).end();
      return;
    }
    const mullFile = url.pathname.match(/^\/mull-data\/([A-Z0-9]{2,5}-mull\.json)$/);
    if (mullFile) {
      // The trainer's freshly exported model first (preview before publishing), else the live site's.
      const local = path.join('C:/Users/taway/draft-trainer/public/sets', mullFile[1]);
      let body = existsSync(local) ? readFileSync(local, 'utf8') : null;
      if (!body) {
        const upstream = await fetch(`${COACH_SITE}/${mullFile[1]}`).catch(() => null);
        body = upstream?.ok && (upstream.headers.get('content-type') ?? '').includes('json') ? await upstream.text() : null;
      }
      response.writeHead(body ? 200 : 404, { 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-store' }).end(body ?? 'null');
      return;
    }
    const coachFile = url.pathname.match(/^\/coach-data\/([A-Z0-9]{2,5}(?:-flow|-builds|-splash)?\.json)$/);
    if (coachFile) {
      const upstream = await fetch(`${COACH_SITE}/${coachFile[1]}`).catch(() => null);
      const json = upstream?.ok && (upstream.headers.get('content-type') ?? '').includes('json');
      response
        .writeHead(json ? 200 : 404, { 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-store' })
        .end(json ? await upstream.text() : 'null');
      return;
    }

    const relative = path.normalize(decodeURIComponent(url.pathname).slice(1));
    const extension = path.extname(relative);
    const folder = relative.split(path.sep)[0];
    if (!FOLDERS.has(folder) || !TYPES[extension] || relative.includes('..')) {
      response.writeHead(404).end('Not found');
      return;
    }

    let body = await readFile(path.join(ROOT, relative), 'utf8');
    if (extension === '.ts') {
      body = stripTypeScriptTypes(body);
    }
    response
      .writeHead(200, { 'Content-Type': TYPES[extension], 'Cache-Control': 'no-store' })
      .end(body);
  } catch {
    response.writeHead(404).end('Not found');
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Preview running at http://127.0.0.1:${PORT}/`);
});
