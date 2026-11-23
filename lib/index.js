import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineTool } from '@deepseek-ai/dsh-tools';

import { PowerShellBridge } from './bridge.mjs';
import { DynamicTools } from './dynamic.mjs';
import { findElement, findTrigger, lintGalaxy, parseTriggerStrings, searchTriggers, summarizeTriggers } from './galaxy.mjs';
import { MpqTool, findPython } from './mpq.mjs';
import { findEditorInstalls, findMaps, mapRoots } from './paths.mjs';

/** Plugin name registered with the Loader. */
export const name = 'galaxy';
/** Host service this plugin registers tools into. */
export const inject = ['tools'];

const LOOSE_SCHEMA = { type: 'object', additionalProperties: true };

function renderJson(_args, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return [{ type: 'text', text }];
}

function present(title, kind, rawInput) {
  return { card: 'generic', title, kind, ...(rawInput === undefined ? {} : { rawInput }) };
}

function ok(value) {
  return { ok: true, ...value };
}

function fail(error) {
  return { ok: false, error: `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}` };
}

function clip(text, max = 120000) {
  if (typeof text !== 'string') return text;
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]`;
}

/**
 * Register the Galaxy Editor tool family.
 * @param ctx - Host context owning the tool registry.
 */
export function apply(ctx) {
  const libDir = path.dirname(fileURLToPath(import.meta.url));
  const pkgDir = path.dirname(libDir);
  const scriptsDir = path.join(pkgDir, 'scripts');
  const dataDir = process.env.DSH_GALAXY_HOME || path.join(os.homedir(), '.dsh', 'galaxy');
  // Spill files (extracted Triggers, uploads) live beside the data dir so the
  // plugin keeps nothing on the system drive once DSH_GALAXY_HOME points elsewhere.
  const tmpDir = process.env.DSH_GALAXY_TMP || path.join(dataDir, 'tmp');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(tmpDir, { recursive: true });

  const state = { bridge: null, mpq: null, installs: null };

  /** Register a tool definition through the SDK normaliser. */
  const reg = (tool) => ctx.tools.register(defineTool(tool));

  const getInstalls = () => {
    if (state.installs === null) {
      state.installs = findEditorInstalls(process.env.GALAXY_EDITOR_ROOT);
    }
    return state.installs;
  };

  const bridge = () => {
    if (state.bridge === null) {
      state.bridge = new PowerShellBridge({
        scriptPath: path.join(scriptsDir, 'galaxy-bridge.ps1'),
        logger: { debug: (message) => ctx.logger?.debug?.(message) },
      });
    }
    return state.bridge;
  };

  const mpq = () => {
    if (state.mpq === null) {
      state.mpq = new MpqTool({
        pythonPath: findPython(process.env.GALAXY_PYTHON),
        scriptPath: path.join(scriptsDir, 'mpqtool.py'),
      });
    }
    return state.mpq;
  };

  const resolveArchive = (input) => {
    const candidate = path.resolve(input);
    if (!existsSync(candidate)) throw new Error(`map/mod not found: ${candidate}`);
    const stat = statSync(candidate);
    if (!stat.isFile()) throw new Error(`not a file: ${candidate}`);
    return candidate;
  };

  const dynamic = new DynamicTools({
    dir: path.join(dataDir, 'tools'),
    api: {
      bridge: (cmd, params) => bridge().call(cmd, params),
      mpq: () => mpq(),
      installs: getInstalls,
      findMaps: () => findMaps(mapRoots(getInstalls())),
      lint: lintGalaxy,
      summarizeTriggers,
      searchTriggers,
      read: (file) => readFileSync(file),
      write: (file, data) => writeFileSync(file, data),
      tmp: tmpDir,
    },
    register: (tool) => reg(tool),
    unregister: (toolName) => ctx.tools.unregister?.(toolName),
    logger: ctx.logger,
  });
  const loadedDynamic = dynamic.loadAll();

  // ---------------------------------------------------------------- status

  reg({
    name: 'galaxy_status',
    description:
      'Report the local StarCraft II Galaxy Editor setup: installed editor builds, whether the editor process is running, its windows and current document, plus Python/MPQ readiness. Call this first in a session.',
    parameters: {
      pid: { type: 'number', description: 'Inspect a specific SC2Editor process id instead of picking one automatically.' },
      probe: {
        type: 'boolean',
        description: 'Also start the automation bridge and read live window state (default true).',
      },
    },
    output: { schema: LOOSE_SCHEMA, render: renderJson },
    async execute(args) {
      try {
        const installs = getInstalls();
        const result = {
          ok: true,
          platform: process.platform,
          python: findPython(process.env.GALAXY_PYTHON),
          mpqTool: existsSync(path.join(scriptsDir, 'mpqtool.py')),
          bridgeScript: existsSync(path.join(scriptsDir, 'galaxy-bridge.ps1')),
          dataDir,
          installs,
          dynamicTools: { loaded: loadedDynamic.loaded, failed: loadedDynamic.failed },
        };
        if (args.probe !== false) {
          try {
            const status = await bridge().call('status', args.pid ? { pid: args.pid } : {});
            result.editor = status;
            if (status?.main?.title) {
              const match = /^(.*?)\s*-\s*(.*?)\s*-\s*《/.exec(status.main.title);
              if (match) result.editor.document = match[2];
            }
          } catch (error) {
            result.editor = { running: false, error: fail(error).error };
          }
        }
        return result;
      } catch (error) {
        return fail(error);
      }
    },
    presentCall: () => present('Galaxy Editor status', 'read'),
  });

  // ---------------------------------------------------------------- editor

  reg({
    name: 'galaxy_editor',
    description:
      'Drive the running Galaxy Editor through Win32 automation: focus the window, invoke a menu command by name or id, send keystrokes, capture the window as a PNG, list windows/dialogs, or close dialogs. Menu commands: new, open, save, saveAs, close, testDocument, undo, redo, copy, copyAsText, paste, selectAll, delete, rename, find, replace, publish, dependencies.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: [
          'status', 'focus', 'command', 'keys', 'screenshot', 'menu',
          'windows', 'dialogs', 'close_dialog', 'wait_window', 'close',
        ],
        description: 'Operation to perform.',
      },
      command: { type: 'string', description: 'Menu command name for action=command (for example "copyAsText" or "testDocument").' },
      command_id: { type: 'number', description: 'Raw WM_COMMAND id for action=command when the name is unknown.' },
      keys: {
        type: 'string',
        description: 'SendKeys string for action=keys, for example "^+c" (Ctrl+Shift+C) or "%{F4}".',
      },
      out: { type: 'string', description: 'Absolute PNG path for action=screenshot.' },
      title: { type: 'string', description: 'Window title substring for action=wait_window.' },
      timeout_ms: { type: 'number', description: 'Timeout for action=wait_window (default 15000).' },
      force: { type: 'boolean', description: 'For action=close: kill the process if it does not exit.' },
      pid: { type: 'number', description: 'Target SC2Editor process id.' },
    },
    output: { schema: LOOSE_SCHEMA, render: renderJson },
    async execute(args) {
      try {
        const pid = args.pid ? { pid: args.pid } : {};
        switch (args.action) {
          case 'status':
            return ok({ editor: await bridge().call('status', pid) });
          case 'focus':
            return ok({ focus: await bridge().call('focus', pid) });
          case 'command': {
            const params = { ...pid };
            if (args.command) params.name = args.command;
            if (args.command_id !== undefined) params.id = args.command_id;
            return ok({ command: await bridge().call('command', params) });
          }
          case 'keys':
            return ok({ keys: await bridge().call('keys', { ...pid, sendKeys: args.keys }) });
          case 'screenshot': {
            const out = args.out ?? path.join(tmpDir, `editor-${Date.now()}.png`);
            return ok({ screenshot: await bridge().call('screenshot', { ...pid, out }) });
          }
          case 'menu':
            return ok({ menu: await bridge().call('menu', pid) });
          case 'windows':
            return ok({ windows: await bridge().call('windows', pid) });
          case 'dialogs':
            return ok({ dialogs: await bridge().call('dialogs', pid) });
          case 'close_dialog':
            return ok({ dialogs: await bridge().call('closeDialog', pid) });
          case 'wait_window':
            return ok({ wait: await bridge().call('waitWindow', { ...pid, title: args.title ?? '', timeoutMs: args.timeout_ms ?? 15000 }) });
          case 'close':
            return ok({ close: await bridge().call('close', { ...pid, force: args.force === true }) });
          default:
            return fail(new Error(`unknown action: ${args.action}`));
        }
      } catch (error) {
        return fail(error);
      }
    },
    presentCall: (args) => present(`Galaxy editor: ${args.action}`, 'other', args.command ?? args.keys ?? args.out),
  });

  // ------------------------------------------------------------- clipboard

  reg({
    name: 'galaxy_clipboard',
    description:
      'Read or write the Windows clipboard text. Combined with galaxy_editor keys this moves text in and out of the editor: select triggers and copy as text (Ctrl+Shift+C), or set text and paste (Ctrl+V).',
    parameters: {
      action: { type: 'string', required: true, enum: ['get', 'set'], description: 'get or set.' },
      text: { type: 'string', description: 'Text to place on the clipboard when action=set.' },
    },
    output: { schema: LOOSE_SCHEMA, render: renderJson },
    async execute(args) {
      try {
        if (args.action === 'set') {
          if (typeof args.text !== 'string') throw new Error('text is required for action=set');
          return ok({ clipboard: await bridge().call('clipboard.set', { text: args.text }) });
        }
        const clipData = await bridge().call('clipboard.get');
        return ok({ clipboard: clipData, text: clip(clipData?.text ?? '') });
      } catch (error) {
        return fail(error);
      }
    },
    presentCall: (args) => present(`Clipboard ${args.action}`, args.action === 'get' ? 'read' : 'other'),
  });

  // ------------------------------------------------------------- map open

  reg({
    name: 'galaxy_map_open',
    description:
      'Open a .SC2Map or .SC2Mod in the Galaxy Editor. Starts the editor with the map on its command line when it is not running (reliable); when the editor is already running it tries the same hand-off, then the File > Open dialog, and reports what happened instead of pretending success.',
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute path to the .SC2Map or .SC2Mod file.' },
      launch: { type: 'boolean', description: 'Start the editor when it is not running (default true).' },
      confirm_ms: { type: 'number', description: 'How long to wait for the document to open (default 8000, or 90000 when launching).' },
    },
    output: { schema: LOOSE_SCHEMA, render: renderJson },
    async execute(args) {
      try {
        const archive = resolveArchive(args.path);
        const baseName = path.basename(archive, path.extname(archive));
        const documentTitle = (status) =>
          status?.windows?.find((win) => win.title.includes(baseName))?.title ?? null;
        let status = await bridge().call('status').catch(() => ({ running: false }));

        if (!status.running) {
          if (args.launch === false) throw new Error('editor is not running');
          const install = getInstalls()[0];
          if (!install) throw new Error('no Galaxy Editor installation found');
          await bridge().call('launch', {
            exe: install.editor,
            workdir: install.root,
            arguments: `"${archive}"`,
          });
          const deadline = Date.now() + (args.confirm_ms ?? 90000);
          let title = null;
          while (Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
            status = await bridge().call('status').catch(() => ({ running: false }));
            title = documentTitle(status);
            if (title) break;
          }
          return ok({
            opened: title !== null,
            mode: 'command-line',
            path: archive,
            title,
            document: title ? /^(.*?)\s*-\s*(.*?)\s*-\s*《/.exec(title)?.[2] ?? null : null,
            windows: status?.windows?.map((win) => win.title) ?? [],
            ...(title === null ? { hint: '编辑器已启动但未加载该地图；请手动用 文件 → 打开' } : {}),
          });
        }

        // Already running: try the documented command-line hand-off first.
        const install = getInstalls()[0];
        if (install) {
          await bridge().call('launch', {
            exe: install.editor,
            workdir: install.root,
            arguments: `"${archive}"`,
          });
          const deadline = Date.now() + 20000;
          let title = null;
          while (Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
            status = await bridge().call('status').catch(() => ({ running: true }));
            title = documentTitle(status);
            if (title) break;
          }
          if (title) {
            return ok({ opened: true, mode: 'hand-off', path: archive, title, windows: status?.windows?.map((win) => win.title) ?? [] });
          }
        }

        // Fall back to the File > Open dialog, which is a custom Blizzard dialog.
        await bridge().call('closeDialog').catch(() => {});
        await bridge().call('focus');
        await bridge().call('command', { name: 'open', id: 158 });
        const dialog = await bridge().call('waitWindow', { title: '打开', timeoutMs: 8000 });
        if (!dialog.found) {
          const other = await bridge().call('waitWindow', { title: 'Open', timeoutMs: 2000 });
          if (!other.found) {
            return ok({
              opened: false,
              mode: 'none',
              path: archive,
              hint: '编辑器已在运行且无法自动打开：请先关闭编辑器再重试，或手动用 文件 → 打开',
            });
          }
        }
        await bridge().call('fillDialog', { title: dialog.found ? '打开' : 'Open', path: archive });
        await new Promise((resolve) => setTimeout(resolve, args.confirm_ms ?? 8000));
        const after = await bridge().call('status');
        const title = documentTitle(after);
        await bridge().call('closeDialog').catch(() => {});
        return ok({
          opened: title !== null,
          mode: 'open-dialog',
          path: archive,
          title,
          document: title ? /^(.*?)\s*-\s*(.*?)\s*-\s*《/.exec(title)?.[2] ?? null : null,
          windows: after?.windows?.map((win) => win.title) ?? [],
          ...(title === null ? { hint: 'Blizzard 自绘的打开对话框无法可靠填充；请手动打开或重启编辑器' } : {}),
        });
      } catch (error) {
        return fail(error);
      }
    },
    presentCall: (args) => present('Open map in Galaxy Editor', 'other', args.path),
  });

  // ------------------------------------------------------------ map files

  reg({
    name: 'galaxy_map_files',
    description:
      'List the files inside a .SC2Map/.SC2Mod MPQ archive (Triggers, MapScript.galaxy, GameData, assets), optionally filtered by substring.',
    parameters: {
      path: { type: 'string', required: true, description: 'Archive path.' },
      filter: { type: 'string', description: 'Case-insensitive substring filter on file names.' },
      limit: { type: 'number', description: 'Maximum files to return (default 200).' },
    },
    output: { schema: LOOSE_SCHEMA, render: renderJson },
    async execute(args) {
      try {
        const archive = resolveArchive(args.path);
        const listing = await mpq().list(archive);
        const filter = args.filter?.toLowerCase();
        const files = filter
          ? listing.files.filter((file) => file.toLowerCase().includes(filter))
          : listing.files;
        const limit = args.limit ?? 200;
        return ok({
          archive,
          formatVersion: listing.version,
          sectorSize: listing.sectorSize,
          total: listing.count,
          matched: files.length,
          files: files.slice(0, limit),
          truncated: files.length > limit,
        });
      } catch (error) {
        return fail(error);
      }
    },
    presentCall: (args) => present('List map files', 'read', args.filter),
  });

  reg({
    name: 'galaxy_map_read',
    description:
      'Read one embedded file from a map archive as text, or extract it to disk. Long files (Triggers can be tens of megabytes) are written to a file and only a head preview is returned — use out or the returned path with galaxy_triggers.',
    parameters: {
      path: { type: 'string', required: true, description: 'Archive path.' },
      name: { type: 'string', required: true, description: 'Embedded file name, for example "Triggers" or "MapScript.galaxy".' },
      out: { type: 'string', description: 'Write the decoded file to this absolute path instead of returning text.' },
      max_chars: { type: 'number', description: 'Inline text budget before spilling to disk (default 200000).' },
    },
    output: { schema: LOOSE_SCHEMA, render: renderJson },
    async execute(args) {
      try {
        const archive = resolveArchive(args.path);
        const budget = args.max_chars ?? 200000;
        if (args.out) {
          const written = await mpq().readText(archive, args.name, args.out);
          return ok({ name: args.name, bytes: written.bytes, out: written.out });
        }
        const payload = await mpq().readText(archive, args.name);
        if (payload.encoding === 'binary') {
          const spill = path.join(tmpDir, `${args.name.replace(/[\\/:*?"<>|]/g, '_')}-${Date.now()}.bin`);
          await mpq().readText(archive, args.name, spill);
          return ok({ name: args.name, bytes: payload.bytes, binary: true, out: spill });
        }
        if (payload.text.length > budget) {
          const spill = path.join(tmpDir, `${args.name.replace(/[\\/:*?"<>|]/g, '_')}-${Date.now()}.txt`);
          writeFileSync(spill, payload.text, 'utf8');
          return ok({
            name: args.name,
            bytes: payload.bytes,
            out: spill,
            head: payload.text.slice(0, 2000),
            note: 'text spilled to disk; pass out or use galaxy_triggers with this path',
          });
        }
        return ok({ name: args.name, bytes: payload.bytes, text: payload.text });
      } catch (error) {
        return fail(error);
      }
    },
    presentCall: (args) => present(`Read ${args.name}`, 'read', args.path),
  });

  reg({
    name: 'galaxy_map_write',
    description:
      'Replace one embedded file inside a map archive (for example a patched "Triggers" or "MapScript.galaxy") by overwriting its own block in place, so every other byte of the archive stays identical and the editor still loads it. The new payload must compress to no more than the space the old block occupied; otherwise this fails with an explicit capacity error instead of writing a map the editor would reject. Creates a timestamped .bak next to the map unless backup=false.',
    parameters: {
      path: { type: 'string', required: true, description: 'Archive path to modify in place.' },
      name: { type: 'string', required: true, description: 'Embedded file name to replace or add.' },
      text: { type: 'string', description: 'New file content as text (UTF-8).' },
      text_file: { type: 'string', description: 'Read new content from this local file instead of text.' },
      backup: { type: 'boolean', description: 'Write a .bak copy first (default true).' },
    },
    output: { schema: LOOSE_SCHEMA, render: renderJson },
    async execute(args) {
      try {
        const archive = resolveArchive(args.path);
        if (args.text === undefined && args.text_file === undefined) {
          throw new Error('provide text or text_file');
        }
        const content = args.text_file !== undefined
          ? { name: args.name, file: path.resolve(args.text_file) }
          : { name: args.name, text: args.text };
        const info = await mpq().replace(archive, [content], { backup: args.backup !== false });
        return ok({ ...info, archive, name: args.name });
      } catch (error) {
        return fail(error);
      }
    },
    presentCall: (args) => present(`Write ${args.name}`, 'other', args.path),
  });

  // -------------------------------------------------------------- triggers

  reg({
    name: 'galaxy_triggers',
    description:
      'Work with a Triggers document: "summary" counts libraries/triggers/variables and lists trigger names, "search" regex-searches with line numbers, "trigger" returns one trigger block by name or id. Accepts a map path (extracts Triggers itself) or a dumped Triggers text file.',
    parameters: {
      path: { type: 'string', required: true, description: 'Map archive path or a text file containing Triggers XML.' },
      action: { type: 'string', required: true, enum: ['summary', 'search', 'trigger'], description: 'Operation to perform.' },
      pattern: { type: 'string', description: 'Regex for action=search.' },
      trigger: { type: 'string', description: 'Trigger name or id for action=trigger.' },
      max_hits: { type: 'number', description: 'Maximum hits for action=search (default 40).' },
      name: { type: 'string', description: 'Embedded file name (default "Triggers").' },
    },
    output: { schema: LOOSE_SCHEMA, render: renderJson },
    async execute(args) {
      let spill = null;
      try {
        const target = resolveArchive(args.path);
        let xml;
        if (/\.(sc2map|sc2mod)$/i.test(target)) {
          spill = path.join(tmpDir, `Triggers-${Date.now()}.xml`);
          await mpq().readText(target, args.name ?? 'Triggers', spill);
          xml = readFileSync(spill, 'utf8');
        } else {
          xml = readFileSync(target, 'utf8');
        }
        // Names live in the localized TriggerStrings table, not in Triggers.
        let strings = [];
        if (/\.(sc2map|sc2mod)$/i.test(target)) {
          try {
            const listing = await mpq().list(target);
            const candidates = listing.files.filter((file) => /LocalizedData\\TriggerStrings\.txt$/i.test(file));
            const preferred = candidates.find((file) => /zhCN/i.test(file))
              ?? candidates.find((file) => /enUS/i.test(file))
              ?? candidates[0];
            if (preferred) {
              const spillStrings = path.join(tmpDir, `TriggerStrings-${Date.now()}.txt`);
              await mpq().readText(target, preferred, spillStrings);
              strings = parseTriggerStrings(readFileSync(spillStrings, 'utf8')).filter((row) => row.field === 'Name');
              strings.truncated = strings.length > 5000;
            }
          } catch {
            strings = [];
          }
        }

        if (args.action === 'summary') {
          const summary = summarizeTriggers(xml);
          // Backfill display names from TriggerStrings: the Triggers document
          // itself carries only hex ids.
          const names = new Map(
            strings.filter((row) => row.kind === 'Trigger').map((row) => [row.id, row.name]),
          );
          const triggerList = summary.triggerList.map((entry) => ({
            ...entry,
            name: entry.name || names.get(entry.id) || '',
          }));
          const limit = args.limit ?? 50;
          const largest = [...triggerList].sort((a, b) => b.bytes - a.bytes).slice(0, 10);
          return ok({
            source: target,
            ...summary,
            triggersNamed: triggerList.filter((entry) => entry.name).length,
            triggerList: triggerList.slice(0, limit),
            largest,
            triggerListTruncated: triggerList.length > limit,
          });
        }
        if (args.action === 'search') {
          if (!args.pattern) throw new Error('pattern is required for action=search');
          const maxHits = args.max_hits ?? 40;
          const result = searchTriggers(xml, args.pattern, { maxHits });
          let re;
          try {
            re = new RegExp(args.pattern, 'i');
          } catch {
            re = null;
          }
          const named = re
            ? strings
                .filter((row) => re.test(row.name))
                .slice(0, Math.max(0, maxHits - result.hits.length))
                .map((row) => ({ kind: row.kind, id: row.id, name: row.name }))
            : [];
          return ok({ source: target, ...result, namedMatches: named });
        }
        if (args.action === 'trigger') {
          if (!args.trigger) throw new Error('trigger is required for action=trigger');
          const hit = findTrigger(xml, args.trigger);
          if (hit.found === null) {
            // Fall back to the localized name table, which is where the
            // editor's trigger/function names actually live.
            const wanted = args.trigger.toLowerCase();
            const row = strings.find((entry) => entry.name === args.trigger)
              ?? strings.find((entry) => entry.name.toLowerCase().includes(wanted));
            if (row) {
              const block = findElement(xml, row.kind, row.id);
              if (block) {
                return ok({
                  found: true,
                  resolvedFrom: 'TriggerStrings',
                  kind: row.kind,
                  name: row.name,
                  id: row.id,
                  bytes: block.length,
                  xml: clip(block, 60000),
                });
              }
            }
            return ok({ found: false, candidates: hit.candidates, namedCandidates: row ? [row] : [], note: 'no trigger name/id matched' });
          }
          return ok({
            found: true,
            trigger: { id: hit.found.id, name: hit.found.name, bytes: hit.found.bytes },
            xml: clip(hit.found.xml, 60000),
          });
        }
        return fail(new Error(`unknown action: ${args.action}`));
      } catch (error) {
        return fail(error);
      }
    },
    presentCall: (args) => present(`Triggers ${args.action}`, args.action === 'summary' ? 'read' : 'search', args.trigger ?? args.pattern),
  });

  // ------------------------------------------------------------------ lint

  reg({
    name: 'galaxy_lint',
    description:
      'Static-check Galaxy script text (or a .galaxy/.txt file): unbalanced braces, missing "then", assignment-in-condition, calls with no local definition, and function inventory. Fast feedback that does not need the editor.',
    parameters: {
      text: { type: 'string', description: 'Galaxy source to check.' },
      file: { type: 'string', description: 'Read the source from this file instead.' },
      name: { type: 'string', description: 'Label used in the report.' },
    },
    output: { schema: LOOSE_SCHEMA, render: renderJson },
    async execute(args) {
      try {
        let source = args.text;
        if (source === undefined && args.file) source = readFileSync(path.resolve(args.file), 'utf8');
        if (source === undefined) throw new Error('provide text or file');
        return ok({ ...lintGalaxy(source, { fileName: args.name ?? args.file ?? 'inline' }) });
      } catch (error) {
        return fail(error);
      }
    },
    presentCall: (args) => present('Lint Galaxy script', 'read', args.name ?? args.file),
  });

  // --------------------------------------------------------- dynamic tools

  reg({
    name: 'galaxy_tool',
    description:
      'Extend yourself: list, define or delete agent-authored tools for this plugin. A defined tool is compiled immediately and becomes callable in the next turn, and persists across restarts. The code body receives api (bridge, mpq(), lint, summarizeTriggers, searchTriggers, installs, findMaps, read, write, tmp) and args, and must return a JSON-serialisable value.',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'define', 'delete', 'examples'], description: 'Operation.' },
      name: { type: 'string', description: 'Tool name (lowercase snake_case) for define/delete.' },
      description: { type: 'string', description: 'One-line description shown to the model.' },
      parameters: { type: 'object', additionalProperties: true, description: 'JSON schema properties object for the new tool.' },
      code: { type: 'string', description: 'Async JavaScript body. Use api.* and args.*, return a value.' },
    },
    output: { schema: LOOSE_SCHEMA, render: renderJson },
    async execute(args) {
      try {
        if (args.action === 'list') return ok({ tools: dynamic.list(), dir: path.join(dataDir, 'tools') });
        if (args.action === 'examples') {
          return ok({
            example: {
              name: 'galaxy_recent_maps',
              description: 'List recently modified maps under the editor install',
              parameters: { limit: { type: 'number', description: 'How many maps' } },
              code: "const { statSync } = await import('node:fs');\nconst files = api.findMaps();\nreturn files.slice(0, args.limit ?? 10).map((f) => ({ file: f, mtime: statSync(f).mtimeMs }));",
            },
          });
        }
        if (args.action === 'define') {
          return ok({ tool: dynamic.define(args) });
        }
        if (args.action === 'delete') {
          return ok({ tool: dynamic.remove(args.name) });
        }
        return fail(new Error(`unknown action: ${args.action}`));
      } catch (error) {
        return fail(error);
      }
    },
    presentCall: (args) => present(`Galaxy tool ${args.action}`, 'other', args.name),
  });
}



