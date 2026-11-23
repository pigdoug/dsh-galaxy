import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Resolve the interpreter used to run mpqtool.py. */
export function findPython(configured) {
  const candidates = [
    configured,
    process.env.DSH_PYTHON,
    path.join(os.homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'),
    'python',
    'python3',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate.includes(path.sep) || candidate.includes('/')) {
      if (existsSync(candidate)) return candidate;
    } else {
      return candidate;
    }
  }
  return 'python';
}

function runProcess(executable, args, { timeoutMs = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`mpqtool timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      const trimmed = stdout.trim();
      const start = trimmed.lastIndexOf('{"ok"');
      const jsonText = start >= 0 ? trimmed.slice(start) : trimmed;
      try {
        const parsed = JSON.parse(jsonText);
        if (parsed.ok) resolve(parsed.result);
        else reject(new Error(parsed.error ?? 'mpqtool failed'));
      } catch {
        reject(new Error(`mpqtool exit ${code}: ${stderr.trim() || trimmed.slice(0, 400)}`));
      }
    });
  });
}

export class MpqTool {
  constructor({ pythonPath, scriptPath, timeoutMs = 300000 }) {
    this.pythonPath = pythonPath;
    this.scriptPath = scriptPath;
    this.timeoutMs = timeoutMs;
  }

  async run(...args) {
    if (!existsSync(this.scriptPath)) {
      throw new Error(`mpqtool.py not found: ${this.scriptPath}`);
    }
    return await runProcess(this.pythonPath, [this.scriptPath, ...args], { timeoutMs: this.timeoutMs });
  }

  list(archive) {
    return this.run('list', archive);
  }

  info(archive) {
    return this.run('info', archive);
  }

  readText(archive, name, outFile) {
    const args = ['read', archive, name];
    if (outFile) args.push('--out', outFile);
    return this.run(...args);
  }

  /**
   * Replace embedded files in place.
   *
   * Full repacks shift block offsets, which the SC2 editor rejects (its v3
   * BET/HET tables pin file positions). Writing a replacement over its own
   * block keeps the archive layout intact and is accepted by the editor, so
   * each payload must fit the space its predecessor occupied.
   */
  async replace(archive, replacements, { backup = true } = {}) {
    const dir = path.join(os.tmpdir(), 'dsh-galaxy-mpq');
    mkdirSync(dir, { recursive: true });
    const results = [];
    for (const [index, item] of replacements.entries()) {
      const file = item.file ?? path.join(dir, `upload-${Date.now()}-${index}.bin`);
      if (item.file === undefined) {
        writeFileSync(file, item.text ?? item.data ?? '', 'utf8');
      }
      if (backup) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = `${archive}.${stamp}.bak`;
        writeFileSync(backupPath, readFileSync(archive));
        results.push({ backup: backupPath });
      }
      const info = await this.run('replace', archive, item.name, file);
      results.push(info);
    }
    const last = results[results.length - 1] ?? {};
    return {
      archive,
      size: statSync(archive).size,
      replaced: replacements.map((r) => r.name),
      mode: last.mode,
      backups: results.filter((r) => r.backup).map((r) => r.backup),
    };
  }
}

