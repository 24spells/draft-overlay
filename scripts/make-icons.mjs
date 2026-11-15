// Renders build/icon.svg (the 24spells mark) into every icon the app needs (Windows only: uses Edge).
//   node scripts/make-icons.mjs [outDirForSitePngs]
// -> build/icon.png (512, electron-builder), build/icon.ico (16-256), app/icons/tray*.png (16/24/32 for
//    100/150/200% displays) and, when given a folder, icon-{32,180,192,512}.png for the website.
// Sizes up to 32 px use a simpler drawing (no shadow or shine, bigger numerals) so they stay readable.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const siteOut = process.argv[2];
const svg = readFileSync(path.join(ROOT, 'build', 'icon.svg'), 'utf8');
const small = svg
  .replace(/<circle class="shadow"[^>]*\/>/, '')
  .replace(/<ellipse class="shine"[^>]*\/>/, '')
  .replace('cx="256" cy="250" r="230"', 'cx="256" cy="256" r="240"')
  .replace('stroke-width="10"', 'stroke-width="26"')
  .replace('y="252"', 'y="262"')
  .replace('font-size="262"', 'font-size="300"')
  .replace('letter-spacing="-14"', 'letter-spacing="-10"');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const port = 9341;
const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(path.join(os.tmpdir(), 'icons-'))}`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets = null;
for (let i = 0; i < 60 && !targets; i += 1) {
  await sleep(250);
  try {
    targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  } catch {
    // Edge is still starting.
  }
}
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
const send = (method, params = {}) =>
  new Promise((r) => {
    id += 1;
    pending.set(id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });
await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });

async function render(size) {
  const art = size <= 32 ? small : svg;
  const html = `<!doctype html><html style="overflow:hidden"><body style="margin:0;overflow:hidden;background:transparent">${art.replace('<svg ', `<svg width="${size}" height="${size}" style="display:block" `)}</body></html>`;
  await send('Emulation.setDeviceMetricsOverride', { width: size, height: size, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `data:text/html;base64,${Buffer.from(html).toString('base64')}` });
  await sleep(400);
  const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: size, height: size, scale: 1 } });
  return Buffer.from(shot.result.data, 'base64');
}

// An .ico whose entries are PNGs (fine on Windows Vista and later).
function ico(entries) {
  const head = Buffer.alloc(6 + 16 * entries.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(entries.length, 4);
  let offset = head.length;
  entries.forEach(({ size, png }, i) => {
    const at = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, at);
    head.writeUInt8(size >= 256 ? 0 : size, at + 1);
    head.writeUInt16LE(1, at + 4);
    head.writeUInt16LE(32, at + 6);
    head.writeUInt32LE(png.length, at + 8);
    head.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([head, ...entries.map((e) => e.png)]);
}

const pngs = {};
for (const size of [16, 24, 32, 48, 64, 128, 180, 192, 256, 512]) pngs[size] = await render(size);
writeFileSync(path.join(ROOT, 'build', 'icon.png'), pngs[512]);
writeFileSync(path.join(ROOT, 'build', 'icon.ico'), ico([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, png: pngs[size] }))));
mkdirSync(path.join(ROOT, 'app', 'icons'), { recursive: true });
writeFileSync(path.join(ROOT, 'app', 'icons', 'tray.png'), pngs[16]);
writeFileSync(path.join(ROOT, 'app', 'icons', 'tray@1.5x.png'), pngs[24]);
writeFileSync(path.join(ROOT, 'app', 'icons', 'tray@2x.png'), pngs[32]);
if (siteOut) {
  mkdirSync(siteOut, { recursive: true });
  for (const size of [32, 180, 192, 512]) writeFileSync(path.join(siteOut, `icon-${size}.png`), pngs[size]);
}
console.log('icons written');
ws.close();
edge.kill();
process.exit(0);
