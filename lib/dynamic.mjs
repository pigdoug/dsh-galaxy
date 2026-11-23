import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const NAME_RE = /^[a-z][a-z0-9_]{2,40}$/;

/**
 * Tools the agent writes for itself.
 *
 * A dynamic tool is a JSON descriptor holding a name, a description, a
 * parameter schema and a JavaScript body. The body runs in this host process
 * with a small `api` object, so it can drive the editor, read maps and analyse
 * Galaxy without any rebuild or restart.
 */
export class DynamicTools {
  constructor({ dir, api, register, unregister, logger }) {
    this.dir = dir;
    this.api = api;
    this.register = register;
    this.unregister = unregister;
    this.logger = logger;
    this.active = new Map();
    this.disposers = new Map();
    mkdirSync(dir, { recursive: true });
  }

  #descriptorPath(name) {
    return path.join(this.dir, `${name}.json`);
  }

  #compile(descriptor) {
    const body = descriptor.code;
    const factory = new Function(
      'api',
      'args',
      `"use strict"; return (async () => {${body}\n})();`,
    );
    return async (args) => await factory(this.api, args ?? {});
  }

  #activate(descriptor, { explicit = false } = {}) {
    if (this.active.has(descriptor.name)) this.disposeOne(descriptor.name);
    const execute = this.#compile(descriptor);
    const parameters = descriptor.parameters ?? {};
    const tool = {
      name: descriptor.name,
      description: `[galaxy dynamic] ${descriptor.description ?? 'agent-defined galaxy tool'}`,
      parameters,
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [
          { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
        ],
      },
      async execute(args) {
        try {
          const value = await execute(args);
          // Tool outputs must be JSON objects; arrays and scalars get wrapped.
          if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value;
          return { ok: true, result: value ?? null };
        } catch (error) {
          return { ok: false, error: `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}` };
        }
      },
      presentCall: (args) => ({ card: 'generic', title: descriptor.name, kind: 'other', rawInput: args }),
    };
    // Cordis registrations are effect-scoped: keep whatever the registry
    // returned so a later redefinition can tear the old one down first.
    const disposer = this.register(tool);
    if (typeof disposer === 'function') this.disposers.set(descriptor.name, disposer);
    this.active.set(descriptor.name, descriptor);
    if (explicit) writeFileSync(this.#descriptorPath(descriptor.name), JSON.stringify(descriptor, null, 2), 'utf8');
    return tool;
  }

  /** Tear down one registration, preferring the disposer the registry gave us. */
  disposeOne(name) {
    const disposer = this.disposers.get(name);
    this.disposers.delete(name);
    this.active.delete(name);
    if (typeof disposer === 'function') {
      try {
        disposer();
        return true;
      } catch {
        /* fall through to the legacy hook below */
      }
    }
    try {
      this.unregister?.(name);
    } catch {
      /* the registry may refuse; the caller reports it */
    }
    return false;
  }

  /** Load every descriptor from disk; a broken one never blocks the rest. */
  loadAll() {
    const loaded = [];
    const failed = [];
    let entries = [];
    try {
      entries = readdirSync(this.dir).filter((name) => name.endsWith('.json'));
    } catch {
      return { loaded, failed };
    }
    for (const file of entries) {
      try {
        const descriptor = JSON.parse(readFileSync(path.join(this.dir, file), 'utf8'));
        if (!NAME_RE.test(descriptor.name ?? '')) throw new Error('invalid tool name');
        this.#activate(descriptor);
        loaded.push(descriptor.name);
      } catch (error) {
        failed.push({ file, error: String(error?.message ?? error) });
      }
    }
    return { loaded, failed };
  }

  list() {
    return [...this.active.values()].map((d) => ({
      name: d.name,
      description: d.description,
      updated: d.updated ?? null,
      parameters: Object.keys(d.parameters ?? {}),
    }));
  }

  define({ name, description, parameters, code }) {
    if (!NAME_RE.test(name ?? '')) {
      throw new Error('tool name must match ^[a-z][a-z0-9_]{2,40}$');
    }
    if (typeof code !== 'string' || code.trim() === '') throw new Error('code is required');
    const descriptor = {
      name,
      description: description ?? '',
      parameters: parameters ?? {},
      code,
      updated: new Date().toISOString(),
    };
    // Compile before persisting so a broken snippet never becomes permanent.
    new Function('api', 'args', `"use strict"; return (async () => {${code}\n})();`);
    try {
      this.#activate(descriptor, { explicit: true });
    } catch (error) {
      if (!/already registered/.test(String(error?.message ?? error))) throw error;
      // Re-registration refused: report it instead of leaving a half state.
      throw new Error(
        `${name} is already registered and the registry refused to replace it; ` +
          'restart DSH, or define the tool under a new name.',
      );
    }
    return { name, registered: true, parameters: Object.keys(descriptor.parameters) };
  }

  remove(name) {
    if (!NAME_RE.test(name ?? '')) throw new Error('invalid tool name');
    const existed = this.active.has(name);
    if (existed) this.disposeOne(name);
    const file = this.#descriptorPath(name);
    if (existsSync(file)) rmSync(file);
    return { name, removed: existed };
  }
}

/** Minimal delete-safe file write used by generated tools. */
export function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}
