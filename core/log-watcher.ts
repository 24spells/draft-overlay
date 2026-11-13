// Follows Arena's Player.log as it grows. Reads from the start of the file,
// so a draft already in progress is picked up. Adapted from 17-buddy (MIT).

import { type Stats, unwatchFile, watchFile } from 'node:fs';
import { open } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';

const READ_BUFFER_SIZE = 64 * 1024;
const POLL_MS = 250;

export type LogWatcherHandlers = {
  onLine: (line: string) => void;
  /** Called after each read that produced lines. */
  onBatch: () => void;
  /** Called when the log was replaced, which happens when Arena restarts. */
  onReset: () => void;
  onError: (error: Error) => void;
};

export class LogWatcher {
  private path: string;
  private handlers: LogWatcherHandlers;
  private offset = 0;
  private decoder = new StringDecoder('utf8');
  private pending = '';
  private queue: Promise<void> = Promise.resolve();
  private started = false;
  private sawLines = false;

  constructor(path: string, handlers: LogWatcherHandlers) {
    this.path = path;
    this.handlers = handlers;
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    watchFile(this.path, { interval: POLL_MS }, this.handleChange);
    this.enqueue(false);
  }

  stop(): void {
    if (this.started) {
      this.started = false;
      unwatchFile(this.path, this.handleChange);
    }
  }

  private handleChange = (current: Stats, previous: Stats): void => {
    const replaced = previous.ino !== 0 && current.ino !== previous.ino;
    this.enqueue(replaced || current.size < previous.size);
  };

  private enqueue(reset: boolean): void {
    this.queue = this.queue
      .then(async () => {
        if (!this.started) {
          return;
        }
        if (reset) {
          this.resetPosition();
        }
        await this.read();
      })
      .catch((error: unknown) => {
        this.handlers.onError(
          error instanceof Error ? error : new Error(String(error)),
        );
      });
  }

  private async read(): Promise<void> {
    let file;
    try {
      file = await open(this.path, 'r');
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw error;
    }

    try {
      const { size } = await file.stat();
      if (size < this.offset) {
        this.resetPosition();
      }

      const buffer = Buffer.allocUnsafe(READ_BUFFER_SIZE);
      this.sawLines = false;
      while (this.offset < size) {
        const { bytesRead } = await file.read(
          buffer,
          0,
          Math.min(buffer.length, size - this.offset),
          this.offset,
        );
        if (bytesRead === 0) {
          break;
        }
        this.offset += bytesRead;
        this.process(this.decoder.write(buffer.subarray(0, bytesRead)));
      }
      if (this.sawLines) {
        this.handlers.onBatch();
      }
    } finally {
      await file.close();
    }
  }

  private process(text: string): void {
    const lines = `${this.pending}${text}`.split('\n');
    this.pending = lines.pop() ?? '';
    for (const line of lines) {
      const clean = line.endsWith('\r') ? line.slice(0, -1) : line;
      if (clean.length > 0) {
        this.sawLines = true;
        this.handlers.onLine(clean);
      }
    }
  }

  private resetPosition(): void {
    this.offset = 0;
    this.decoder = new StringDecoder('utf8');
    this.pending = '';
    this.handlers.onReset();
  }
}
