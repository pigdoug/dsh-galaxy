/**
 * Galaxy script and trigger-tree analysis.
 *
 * The editor compiles Galaxy when a map loads, but that feedback loop is slow
 * and needs the GUI. These checks catch the mistakes that actually happen
 * while editing by hand: unbalanced blocks, missing `then`, undeclared calls,
 * and trigger XML that will not parse.
 */

const KEYWORDS = new Set([
  'if', 'then', 'else', 'while', 'for', 'do', 'return', 'break', 'continue',
  'true', 'false', 'null', 'int', 'bool', 'string', 'point', 'unit', 'unitgroup',
  'fixed', 'region', 'trigger', 'timer', 'dialog', 'bank', 'void', 'const',
  'static', 'native', 'include', 'struct', 'array', 'ref', 'handle', 'text',
  'playergroup', 'soundlink', 'striker', 'wave', 'color', 'game', 'object',
]);

const NATIVE_PREFIXES = [
  'lib', 'String', 'Bool', 'Int', 'Fixed', 'Number', 'Math', 'Random', 'Convert',
  'Wait', 'Environment', 'Debug', 'Unit', 'UnitGroup', 'Trigger', 'Player', 'Point', 'Region', 'Timer',
  'Dialog', 'Bank', 'Camera', 'Text', 'Sound', 'AI', 'Objective', 'Conversation',
  'UI', 'TechTree', 'Upgrade', 'Abil', 'Behavior', 'Catalog', 'Actor', 'Game',
  'PlayerGroup', 'Wave', 'Striker', 'Cinematic', 'Ping', 'Order', 'Ability',
  'Effect', 'Item', 'Kill', 'Map', 'Movie', 'Music', 'Narrative', 'Portrait',
  'Revealer', 'Soundtrack', 'Team', 'Unit', 'User', 'Version', 'Weapon',
];

/** Strip comments and string literals so structural checks see only code. */
function stripNoise(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '"') {
      i += 1;
      while (i < n && source[i] !== '"') {
        if (source[i] === '\\') i += 1;
        i += 1;
      }
      i += 1;
      out += '""';
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === '\n') line += 1;
  }
  return line;
}

/** Structural lint for Galaxy source. Returns diagnostics, never throws. */
export function lintGalaxy(source, { fileName = 'script.galaxy' } = {}) {
  const diagnostics = [];
  const code = stripNoise(source);
  const push = (line, severity, message) => diagnostics.push({ line, severity, message });

  const pairs = [
    ['{', '}', 'block'],
    ['(', ')', 'parenthesis'],
    ['[', ']', 'bracket'],
  ];
  for (const [open, close, label] of pairs) {
    const stack = [];
    for (let i = 0; i < code.length; i += 1) {
      if (code[i] === open) stack.push(i);
      else if (code[i] === close) {
        if (stack.length === 0) {
          push(lineOf(code, i), 'error', `unmatched closing ${close}`);
        } else stack.pop();
      }
    }
    for (const index of stack) {
      push(lineOf(code, index), 'error', `unclosed ${label} opened with ${open}`);
    }
  }

  // `if (cond)` without `then`, a classic Galaxy-only syntax trap.
  const ifPattern = /\bif\s*\(([^;{}]*?)\)\s*(?!then\b)([^\s{;])/g;
  let match;
  while ((match = ifPattern.exec(code)) !== null) {
    push(lineOf(code, match.index), 'error', 'if condition must be followed by "then"');
  }

  // Assignment used where a comparison is almost certainly intended.
  const assignInCondition = /\b(if|while)\s*\(([^)]*?)=([^=)][^)]*?)\)/g;
  while ((match = assignInCondition.exec(code)) !== null) {
    if (/[=!<>]=/.test(match[0])) continue;
    push(lineOf(code, match.index), 'warning', 'condition assigns with "=" instead of "=="');
  }

  // Calls that look like undefined user functions (very rough, low severity).
  const defined = new Set();
  for (const m of code.matchAll(/\b(?:static\s+|native\s+)?(?:void|int|bool|string|point|unit|fixed|text|region|unitgroup|timer|dialog|playergroup)\s+([A-Za-z_]\w*)\s*\(/g)) {
    defined.add(m[1]);
  }
  for (const m of code.matchAll(/^\s*(?:static\s+)?(?:void|int|bool|string|point|unit|fixed|text)\s+([A-Za-z_]\w*)\s*\(/gm)) {
    defined.add(m[1]);
  }
  const reported = new Set();
  for (const m of code.matchAll(/\b([A-Z]\w+)\s*\(/g)) {
    const name = m[1];
    if (defined.has(name) || reported.has(name)) continue;
    if (KEYWORDS.has(name)) continue;
    if (NATIVE_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    reported.add(name);
    push(lineOf(code, m.index), 'warning', `call to ${name}() has no definition in this file`);
  }

  const lines = code.split('\n').length;
  const functions = [...code.matchAll(/^\s*(?:static\s+)?(?:void|int|bool|string|point|unit|fixed|text|region|unitgroup)\s+([A-Za-z_]\w*)\s*\(/gm)]
    .map((m) => m[1]);
  return {
    file: fileName,
    lines,
    functions: [...new Set(functions)],
    errorCount: diagnostics.filter((d) => d.severity === 'error').length,
    warningCount: diagnostics.filter((d) => d.severity === 'warning').length,
    diagnostics: diagnostics.slice(0, 200),
  };
}

function countOccurrences(haystack, needle) {
  let total = 0;
  let index = 0;
  while ((index = haystack.indexOf(needle, index)) !== -1) {
    total += 1;
    index += needle.length;
  }
  return total;
}

/** Text content of the first `<tag ...>text</tag>` inside a fragment. */
function tagText(fragment, tag) {
  const open = fragment.indexOf(`<${tag}`);
  if (open === -1) return '';
  const start = fragment.indexOf('>', open);
  if (start === -1) return '';
  const close = fragment.indexOf(`</${tag}>`, start);
  if (close === -1) return '';
  return fragment.slice(start + 1, close).trim();
}

/**
 * Walk one element type in a SC2 Triggers document.
 *
 * The format is an element table, not nested trigger blocks:
 *   <Element Type="Trigger" Id="18486CBB"> <Event .../> <Action .../> </Element>
 * Scanning text linearly keeps a 33 MB document under a second; a lazy regex
 * over the same input is quadratic and effectively hangs.
 */
function scanElements(xml, type, onElement, { maxElements = Infinity } = {}) {
  const openTag = `<Element Type="${type}" Id="`;
  let cursor = 0;
  let seen = 0;
  while (seen < maxElements) {
    const start = xml.indexOf(openTag, cursor);
    if (start === -1) break;
    const idStart = start + openTag.length;
    const idEnd = xml.indexOf('"', idStart);
    if (idEnd === -1) break;
    const close = xml.indexOf('</Element>', idEnd);
    if (close === -1) break;
    const end = close + '</Element>'.length;
    seen += 1;
    onElement({ id: xml.slice(idStart, idEnd), block: xml.slice(start, end), start, end });
    cursor = end;
  }
  return seen;
}

/** Compact structural summary of a Triggers document. */
export function summarizeTriggers(xml, { maxTriggers = 500 } = {}) {
  const triggers = [];
  const total = scanElements(xml, 'Trigger', ({ id, block }) => {
    if (triggers.length >= maxTriggers) return;
    triggers.push({
      id,
      name: tagText(block, 'Name'),
      events: countOccurrences(block, '<Event '),
      actions: countOccurrences(block, '<Action '),
      variables: countOccurrences(block, '<Variable '),
      bytes: block.length,
    });
  });
  return {
    bytes: xml.length,
    libraries: countOccurrences(xml, '<Library'),
    triggers: total,
    triggersNamed: triggers.filter((t) => t.name).length,
    variables: countOccurrences(xml, '<Element Type="Variable"'),
    functions: countOccurrences(xml, '<Element Type="FunctionDef"'),
    customScripts: countOccurrences(xml, '<Element Type="CustomScript"'),
    comments: countOccurrences(xml, '<Element Type="Comment"'),
    categories: countOccurrences(xml, '<Element Type="Category"'),
    elements: countOccurrences(xml, '<Element '),
    triggerList: triggers,
    largest: [...triggers].sort((a, b) => b.bytes - a.bytes).slice(0, 10),
  };
}

/** Locate one trigger by name or id in the element table. */
export function findTrigger(xml, needle) {
  let found = null;
  const candidates = [];
  scanElements(xml, 'Trigger', ({ id, block }) => {
    const name = tagText(block, 'Name');
    if (found === null && (id === needle || (name && name === needle))) {
      found = { id, name, bytes: block.length, xml: block };
      return;
    }
    if (candidates.length < 20) {
      if ((name && name.includes(needle)) || id.includes(needle) || block.includes(needle)) {
        candidates.push({ id, name });
      }
    }
  });
  return { found, candidates };
}

/** Parse TriggerStrings.txt lines ("FunctionDef/Name/<hex id>=label"). */
export function parseTriggerStrings(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z]+)\/([A-Za-z]+)\/([0-9A-Fa-f]+)=(.*)$/.exec(line.trim());
    if (match) rows.push({ kind: match[1], field: match[2], id: match[3].toUpperCase(), name: match[4] });
  }
  return rows;
}

/** One element block of a given type and id. */
export function findElement(xml, type, id) {
  let found = null;
  scanElements(xml, type, ({ id: elementId, block }) => {
    if (found === null && elementId.toUpperCase() === id.toUpperCase()) found = block;
  });
  return found;
}

/** Regex search across the trigger XML with line numbers and context. */
export function searchTriggers(xml, pattern, { maxHits = 40, context = 160 } = {}) {
  let re;
  try {
    re = new RegExp(pattern, 'gi');
  } catch (error) {
    throw new Error(`invalid pattern: ${error.message}`);
  }
  const hits = [];
  let match;
  let lineCursor = 0;
  let lineNumber = 1;
  while ((match = re.exec(xml)) !== null && hits.length < maxHits) {
    const index = match.index;
    // Hits ascend, so count newlines incrementally instead of rescanning.
    for (let i = lineCursor; i < index; i += 1) {
      if (xml.charCodeAt(i) === 10) lineNumber += 1;
    }
    lineCursor = Math.max(lineCursor, index);
    const start = Math.max(0, index - context);
    const end = Math.min(xml.length, index + match[0].length + context);
    hits.push({
      offset: index,
      line: lineNumber,
      excerpt: xml.slice(start, end).replace(/\s+/g, ' '),
    });
    if (match[0].length === 0) re.lastIndex += 1;
  }
  return { pattern, hits, truncated: hits.length >= maxHits };
}
