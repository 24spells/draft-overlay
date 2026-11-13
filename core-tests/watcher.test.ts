import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { LogWatcher } from '../core/log-watcher.ts';

const folder = mkdtempSync(path.join(os.tmpdir(), 'overlay-watcher-'));
after(() => rmSync(folder, { recursive: true, force: true }));

function waitFor(check: () => boolean, ms = 4000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (check()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > ms) {
        clearInterval(timer);
        reject(new Error('timed out'));
      }
    }, 25);
  });
}

describe('LogWatcher', () => {
  it('reads existing lines, then new ones, then starts over on a shorter file', async () => {
    const file = path.join(folder, 'Player.log');
    writeFileSync(file, 'one\r\ntwo\n');
    const lines: string[] = [];
    let batches = 0;
    let resets = 0;
    const watcher = new LogWatcher(file, {
      onLine: (line) => lines.push(line),
      onBatch: () => (batches += 1),
      onReset: () => (resets += 1),
      onError: (error) => assert.fail(error),
    });

    watcher.start();
    await waitFor(() => lines.length === 2);
    assert.deepEqual(lines, ['one', 'two']);
    assert.ok(batches >= 1);

    appendFileSync(file, 'partial');
    appendFileSync(file, ' line\n');
    await waitFor(() => lines.length === 3);
    assert.equal(lines[2], 'partial line');

    writeFileSync(file, 'new\n');
    await waitFor(() => lines.includes('new'));
    assert.equal(resets, 1);
    watcher.stop();
  });
});
