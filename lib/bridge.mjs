import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Client for the long-lived PowerShell automation bridge.
 *
 * The bridge speaks newline-delimited JSON: every request carries an id and
 * every response echoes it, so concurrent callers can be matched up. A dead or
 * wedged bridge is killed and respawned on the next call.
 */
export class PowerShellBridge {
  constructor({ scriptPath, timeoutMs = 30000, logger }) {
    this.scriptPath = scriptPath;
    this.timeoutMs = timeoutMs;
    this.logger = logger;
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = '';
  }

  async start() {
    if (this.child !== null && this.child.exitCode === null) return;
    if (!existsSync(this.scriptPath)) {
      throw new Error(`bridge script not found: ${this.scriptPath}`);
    }
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath, '-Serve'],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.#onData(chunk));
    child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) this.logger?.debug?.(`[galaxy-bridge] ${text}`);
    });
    child.on('exit', (code) => {
      this.child = null;
      for (const [, entry] of this.pending) {
        entry.reject(new Error(`galaxy bridge exited (code ${code})`));
      }
      this.pending.clear();
    });
    this.child = child;
    await this.call('ping', {});
  }

  #onData(chunk) {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.#dispatch(line);
      index = this.buffer.indexOf('\n');
    }
  }

  #dispatch(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const entry = this.pending.get(message.seq);
    if (entry === undefined) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok) entry.resolve(message.result);
    else entry.reject(new Error(message.error ?? 'bridge error'));
  }

  async call(cmd, params = {}) {
    if (this.child === null) await this.start();
    const id = this.nextId++;
    const payload = JSON.stringify({ seq: id, cmd, ...params });
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`galaxy bridge timeout after ${this.timeoutMs}ms: ${cmd}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(`${payload}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async stop() {
    const child = this.child;
    this.child = null;
    if (child === null) return;
    try {
      child.stdin.end();
    } catch {
      /* already closed */
    }
    child.kill();
  }
}
