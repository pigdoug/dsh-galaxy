import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDITOR_RELATIVE = path.join('Support', 'SC2Editor.exe');

/** Candidate SC2 install roots, most specific first. */
export function editorCandidates(configured) {
  const roots = [];
  if (configured) roots.push(configured);
  const drives = ['C:', 'D:', 'E:', 'F:'];
  const names = ['StarCraft II', '亚服星际2\\StarCraft II', 'Games\\StarCraft II', 'SC2'];
  for (const drive of drives) {
    for (const name of names) {
      roots.push(path.join(`${drive}\\`, name));
    }
  }
  const programFiles = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles].filter(Boolean);
  for (const base of programFiles) roots.push(path.join(base, 'StarCraft II'));
  return roots;
}

/** Installed editors that actually exist, each with its launcher path. */
export function findEditorInstalls(configured) {
  const found = [];
  const seen = new Set();
  for (const root of editorCandidates(configured)) {
    const exe = path.join(root, EDITOR_RELATIVE);
    if (!existsSync(exe)) continue;
    const key = root.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({
      root,
      editor: exe,
      launcher: existsSync(path.join(root, 'StarCraft II Editor.exe'))
        ? path.join(root, 'StarCraft II Editor.exe')
        : exe,
      maps: existsSync(path.join(root, 'Maps')) ? path.join(root, 'Maps') : null,
      mods: existsSync(path.join(root, 'Mods')) ? path.join(root, 'Mods') : null,
    });
  }
  return found;
}

/** Default places a map author keeps .SC2Map files. */
export function mapRoots(installs) {
  const roots = [];
  for (const install of installs) {
    if (install.maps) roots.push(install.maps);
    if (install.mods) roots.push(install.mods);
  }
  const documents = path.join(os.homedir(), 'Documents', 'StarCraft II');
  if (existsSync(documents)) roots.push(documents);
  return [...new Set(roots)];
}

/** Shallow recursive walk for map/mod archives. */
export function findMaps(roots, { limit = 200, maxDepth = 3 } = {}) {
  const results = [];
  const walk = (dir, depth) => {
    if (results.length >= limit || depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= limit) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (/\.(sc2map|sc2mod)$/i.test(entry.name)) {
        results.push(full);
      }
    }
  };
  for (const root of roots) {
    if (existsSync(root)) walk(root, 0);
  }
  return results;
}
