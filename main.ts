// mend — one command-line tool that applies the edits AI models write to a
// tree of text files. Models write edits in four formats: unified diffs (often
// with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and
// text-editor tool calls as JSON. This file reads all four to the contract in
// SPEC.md (version 1), finds the lines each edit names at the first of three
// matching tiers, and changes every file or none. Node 22, standard library
// alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A patch the reader cannot read: carries the exact output line. */
class ParseFail extends Error {
  readonly line: string;
  constructor(line: string) {
    super(line);
    this.line = line;
  }
}

/** One edit that failed: its code and the path the failure concerns. */
class EditFail extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    super(`${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece
 *  after a final \n. */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function isSafePath(p: string): boolean {
  return (
    p !== '' &&
    !p.startsWith('/') &&
    !p.includes('\\') &&
    p.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
  );
}

/** A file's lines, its line break, and whether it ends with one. A file's
 *  line break is CRLF when its first line feed follows a carriage return,
 *  and LF otherwise; an empty file has no lines and no final break. */
interface FileState {
  lines: string[];
  br: string;
  ends: boolean;
}

function readState(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', ends: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const ends = text.endsWith(br);
  if (ends) parts.pop();
  return { lines: parts, br, ends };
}

function writeState(s: FileState): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.br) + (s.ends ? s.br : '');
}

const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const stripEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const onlyWs = (s: string): boolean => s === '' || /^[ \t]+$/.test(s);

/** The tree as the edits leave it: paths staged in `staged` (null: deleted),
 *  the rest read from disk on demand. Moves that succeeded are remembered so
 *  the output can print an R line for them. */
class Tree {
  private disk = new Map<string, string | null>();
  staged = new Map<string, string | null>();
  moves: Array<{ from: string; to: string }> = [];

  read(p: string): string | null {
    if (!this.disk.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.disk.set(p, v);
    }
    return this.disk.get(p)!;
  }

  current(p: string): string | null {
    return this.staged.has(p) ? this.staged.get(p)! : this.read(p);
  }
}

/** An edit: a function that changes the tree, or throws EditFail. */
type Edit = (tree: Tree) => void;

/** How a line looks at a matching tier. */
function tierLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return stripEndWs(line);
  return stripBothWs(line);
}

/** Positions where old occurs in lines at one tier, at or after `from`. */
function occurrencesAt(lines: string[], old: string[], tier: number, from: number): number[] {
  const at: number[] = [];
  for (let i = from; i + old.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < old.length; j += 1) {
      if (tierLine(lines[i + j]!, tier) !== tierLine(old[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) at.push(i);
  }
  return at;
}

/** The first tier at which old occurs at least once, with its positions.
 *  With --strict only tier 0 is tried. */
function locate(lines: string[], old: string[], strict: boolean, from = 0): { tier: number; at: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const at = occurrencesAt(lines, old, t, from);
    if (at.length > 0) return { tier: t, at };
  }
  return null;
}

/** One line of a replacement: either text of its own, or the file's own
 *  matched line (a context line), named by its index in the old lines. */
interface Piece {
  text: string;
  copyFrom: number | null;
}

/** Build the lines a replacement writes. A context line is written as the
 *  file's own matched line. At tier 2 every other line is re-indented: the
 *  leading spaces and tabs of the old lines' first line are replaced by
 *  those of the file's first matched line. */
function buildReplacement(fileLines: string[], pos: number, old: string[], pieces: Piece[], tier: number): string[] {
  const f = old.length > 0 && fileLines[pos] !== undefined ? leadWs(fileLines[pos]!) : '';
  const p = old.length > 0 ? leadWs(old[0]!) : '';
  return pieces.map((piece) => {
    if (piece.copyFrom !== null) return fileLines[pos + piece.copyFrom]!;
    let t = piece.text;
    if (tier === 2 && !onlyWs(t) && t.startsWith(p)) t = f + t.slice(p.length);
    return t;
  });
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                   */
/* ------------------------------------------------------------------ */

interface BodyItem {
  kind: 'ctx' | 'del' | 'add' | 'slash';
  text: string;
  /** True when this item came from a literally empty patch line. */
  fromEmpty: boolean;
}

interface Hunk {
  /** Old start line (1-based) from the @@ header. */
  a: number;
  items: BodyItem[];
  /** A \ line follows the hunk's last context or + line. */
  noEol: boolean;
}

interface Section {
  oldPath: string | null; // null: /dev/null, no file
  newPath: string | null;
  create: boolean;
  remove: boolean;
  hunks: Hunk[];
}

/** The path after a --- or +++ line: the text after the four characters, up
 *  to the first tab, with surrounding spaces removed, and a leading a/ or
 *  b/ removed. */
function headerPath(line: string): string {
  const rest = line.slice(4).split('\t')[0]!.replace(/^ +/, '').replace(/ +$/, '');
  if (rest.startsWith('a/') || rest.startsWith('b/')) return rest.slice(2);
  return rest;
}

function parseHunkHeader(line: string, ln: number): number {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (m === null) throw new ParseFail(`error: parse ${ln}`);
  return Number(m[1]);
}

/** A hunk's old lines: its context and - lines, in body order. */
function hunkOld(items: BodyItem[]): string[] {
  return items.filter((it) => it.kind === 'ctx' || it.kind === 'del').map((it) => it.text);
}

/** A hunk's new lines: its context and + lines, in body order. A context
 *  line remembers its index in the old lines, so it is written as the
 *  file's own matched line. */
function hunkNew(items: BodyItem[]): Piece[] {
  const pieces: Piece[] = [];
  let o = 0;
  for (const it of items) {
    if (it.kind === 'ctx') {
      pieces.push({ text: it.text, copyFrom: o });
      o += 1;
    } else if (it.kind === 'del') {
      o += 1;
    } else if (it.kind === 'add') {
      pieces.push({ text: it.text, copyFrom: null });
    }
  }
  return pieces;
}

/** Whether a \ line follows the last context or + item of a hunk body. */
function hunkNoEol(items: BodyItem[]): boolean {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const it = items[i]!;
    if (it.kind === 'ctx' || it.kind === 'add') {
      return items[i + 1] !== undefined && items[i + 1]!.kind === 'slash';
    }
  }
  return false;
}

function parseDiffGit(line: string, ln: number): [string, string] {
  const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
  if (m === null) throw new ParseFail(`error: parse ${ln}`);
  return [m[1]!, m[2]!];
}

/** Read a unified diff into its sections. */
function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: {
    oldPath: string | null;
    newPath: string | null;
    pair: boolean;
    renameOld: string | null;
    renameNew: string | null;
    gitOld: string | null;
    gitNew: string | null;
    create: boolean;
    remove: boolean;
    hunks: Hunk[];
  } | null = null;
  let hunk: { a: number; items: BodyItem[] } | null = null;

  const closeHunk = (): void => {
    if (hunk === null) return;
    const items = [...hunk.items];
    while (items.length > 0 && items[items.length - 1]!.kind === 'ctx' && items[items.length - 1]!.fromEmpty) items.pop();
    cur!.hunks.push({ a: hunk.a, items, noEol: hunkNoEol(items) });
    hunk = null;
  };
  const closeSection = (): void => {
    if (cur === null) return;
    closeHunk();
    const oldPath = cur.pair ? cur.oldPath : cur.renameOld !== null ? cur.renameOld : cur.gitOld;
    const newPath = cur.pair ? cur.newPath : cur.renameNew !== null ? cur.renameNew : cur.gitNew;
    sections.push({
      oldPath,
      newPath,
      create: cur.create || oldPath === '/dev/null',
      remove: cur.remove || newPath === '/dev/null',
      hunks: cur.hunks,
    });
    cur = null;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const ln = i + 1;
    if (hunk !== null) {
      // A hunk body ends at a diff --git line, at a --- line followed by a
      // +++ line, or at the first line that is not a body line.
      if (
        line.startsWith('diff --git ') ||
        (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) ||
        !(line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\'))
      ) {
        closeHunk();
        continue; // reprocess this line outside the body
      }
      if (line === '') hunk.items.push({ kind: 'ctx', text: '', fromEmpty: true });
      else if (line.startsWith(' ')) hunk.items.push({ kind: 'ctx', text: line.slice(1), fromEmpty: false });
      else if (line.startsWith('-')) hunk.items.push({ kind: 'del', text: line.slice(1), fromEmpty: false });
      else if (line.startsWith('+')) hunk.items.push({ kind: 'add', text: line.slice(1), fromEmpty: false });
      else hunk.items.push({ kind: 'slash', text: line.slice(1), fromEmpty: false });
      i += 1;
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const [x, y] = parseDiffGit(line, ln);
      closeSection();
      cur = {
        oldPath: null,
        newPath: null,
        pair: false,
        renameOld: null,
        renameNew: null,
        gitOld: x,
        gitNew: y,
        create: false,
        remove: false,
        hunks: [],
      };
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = headerPath(line);
      const newP = headerPath(lines[i + 1]!);
      if (cur !== null && cur.hunks.length === 0 && !cur.pair) {
        // The section's own header pair.
        cur.oldPath = oldP;
        cur.newPath = newP;
        cur.pair = true;
      } else {
        closeSection();
        cur = {
          oldPath: oldP,
          newPath: newP,
          pair: true,
          renameOld: null,
          renameNew: null,
          gitOld: null,
          gitNew: null,
          create: false,
          remove: false,
          hunks: [],
        };
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new ParseFail(`error: parse ${ln}`);
      hunk = { a: parseHunkHeader(line, ln), items: [] };
      i += 1;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      // Inside a section's header, before its first hunk.
      if (line.startsWith('--- ')) {
        // Not followed by a +++ line (that case is handled above).
        throw new ParseFail(`error: parse ${ln + 1}`);
      }
      if (line.startsWith('+++ ')) cur.newPath = headerPath(line);
      else if (line.startsWith('rename from ')) cur.renameOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameNew = line.slice('rename to '.length).trim();
      else if (line === 'new file mode' || line.startsWith('new file mode ')) cur.create = true;
      else if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) cur.remove = true;
      // index, old mode, new mode, similarity index, dissimilarity index,
      // Index: and any other line are ignored.
      i += 1;
      continue;
    }
    // Outside bodies, lines that are not part of a section header are
    // ignored (prose, code fences).
    i += 1;
  }
  closeSection();
  return sections;
}

/** Apply one section's hunks in order, each to the result of the ones
 *  before it. Throws EditFail('no-match') for a hunk that finds no match. */
function applyHunks(state: FileState, hunks: Hunk[], path: string, strict: boolean): FileState {
  let d = 0;
  for (const h of hunks) {
    const old = hunkOld(h.items);
    const pieces = hunkNew(h.items);
    if (old.length === 0) {
      const at = Math.min(h.a + d, state.lines.length);
      const atEnd = at === state.lines.length;
      state.lines.splice(at, 0, ...pieces.map((p) => p.text));
      if (atEnd) state.ends = !h.noEol;
      d += pieces.length;
      continue;
    }
    const found = locate(state.lines, old, strict);
    if (found === null) throw new EditFail('no-match', path);
    const target = h.a - 1 + d;
    let pos = found.at[0]!;
    let best = Math.abs(pos - target);
    for (const p of found.at) {
      const dist = Math.abs(p - target);
      if (dist < best) {
        best = dist;
        pos = p;
      }
    }
    const toEnd = pos + old.length === state.lines.length;
    const replacement = buildReplacement(state.lines, pos, old, pieces, found.tier);
    state.lines.splice(pos, old.length, ...replacement);
    if (toEnd) state.ends = !h.noEol;
    d += pieces.length - old.length;
  }
  return state;
}

/** One unified section as an edit. */
function unifiedEdit(s: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = s.oldPath;
    const newP = s.newPath;
    if (oldP !== null && oldP !== '/dev/null' && !isSafePath(oldP)) throw new EditFail('unsafe', oldP);
    if (newP !== null && newP !== '/dev/null' && !isSafePath(newP)) throw new EditFail('unsafe', newP);
    if (s.remove) {
      const p = oldP!;
      if (tree.current(p) === null) throw new EditFail('missing', p);
      tree.staged.set(p, null);
      return;
    }
    if (s.create) {
      const p = newP!;
      if (tree.current(p) !== null) throw new EditFail('exists', p);
      const plus: string[] = [];
      // A created file ends with a line break unless a \ line follows its
      // last + line.
      let lastNoEol = false;
      for (const h of s.hunks) {
        for (let k = 0; k < h.items.length; k += 1) {
          const it = h.items[k]!;
          if (it.kind === 'add') {
            plus.push(it.text);
            lastNoEol = h.items[k + 1] !== undefined && h.items[k + 1]!.kind === 'slash';
          }
        }
      }
      tree.staged.set(p, plus.length === 0 ? '' : plus.join('\n') + (lastNoEol ? '' : '\n'));
      return;
    }
    if (oldP !== null && newP !== null && oldP !== newP) {
      if (tree.current(oldP) === null) throw new EditFail('missing', oldP);
      if (tree.current(newP) !== null) throw new EditFail('exists', newP);
      const state = applyHunks(readState(tree.current(oldP)!), s.hunks, oldP, strict);
      tree.staged.set(oldP, null);
      tree.staged.set(newP, writeState(state));
      tree.moves.push({ from: oldP, to: newP });
      return;
    }
    const p = oldP ?? newP!;
    if (tree.current(p) === null) throw new EditFail('missing', p);
    const state = applyHunks(readState(tree.current(p)!), s.hunks, p, strict);
    tree.staged.set(p, writeState(state));
  };
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                           */
/* ------------------------------------------------------------------ */

/** One SEARCH/REPLACE block as an edit. */
function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!isSafePath(path)) throw new EditFail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.current(path) !== null) throw new EditFail('exists', path);
      tree.staged.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.current(path);
    if (cur === null) throw new EditFail('missing', path);
    const state = readState(cur);
    const found = locate(state.lines, oldLines, strict);
    if (found === null) throw new EditFail('no-match', path);
    if (found.at.length > 1) throw new EditFail('ambiguous', path);
    const pos = found.at[0]!;
    const pieces: Piece[] = newLines.map((t) => ({ text: t, copyFrom: null }));
    const replacement = buildReplacement(state.lines, pos, oldLines, pieces, found.tier);
    state.lines.splice(pos, oldLines.length, ...replacement);
    tree.staged.set(path, writeState(state));
  };
}

/** Read SEARCH/REPLACE blocks into edits. Lines outside blocks are ignored. */
function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let prevEnd = -1;
  let prevPath: string | null = null;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLn = i + 1;
    // The path is the nearest line before the SEARCH line, after the
    // previous block's REPLACE line, that is not blank and does not start
    // with three backticks.
    let path: string | null = null;
    for (let j = i - 1; j > prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new ParseFail(`error: parse ${searchLn}`);
      path = prevPath;
    }
    let sep = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      const t = lines[j]!.trimEnd();
      // The separator must come before this block's terminator and before
      // the next block starts; otherwise the block is malformed.
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') throw new ParseFail(`error: parse ${searchLn}`);
      if (t === '=======') {
        sep = j;
        break;
      }
    }
    if (sep === -1) throw new ParseFail(`error: parse ${searchLn}`);
    let end = -1;
    for (let j = sep + 1; j < lines.length; j += 1) {
      const t = lines[j]!.trimEnd();
      // The terminator must come before the next block starts.
      if (t === '<<<<<<< SEARCH') throw new ParseFail(`error: parse ${searchLn}`);
      if (t === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end === -1) throw new ParseFail(`error: parse ${searchLn}`);
    const oldLines = lines.slice(i + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                     */
/* ------------------------------------------------------------------ */

interface V4aChunk {
  /** The anchor text after @@, or null when there is none. */
  anchor: string | null;
  /** True when a *** End of File line ended this chunk. */
  eof: boolean;
  items: BodyItem[];
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  /** Lines of an Add File section, or null for other kinds. */
  addLines: string[] | null;
  moveTo: string | null;
  chunks: V4aChunk[];
  /** Line number of the section's header line. */
  headerLn: number;
}

const V4A_STARTS: Array<[string, 'add' | 'delete' | 'update']> = [
  ['*** Add File: ', 'add'],
  ['*** Delete File: ', 'delete'],
  ['*** Update File: ', 'update'],
];

/** Read a V4A patch into its sections. */
function parseV4a(lines: string[]): V4aSection[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFail('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseFail(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!isBlank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new ParseFail(`error: parse ${lines.length + 1}`);

  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    const ln = i + 1;
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    let started: { kind: 'add' | 'delete' | 'update'; path: string } | null = null;
    for (const [prefix, kind] of V4A_STARTS) {
      if (line.startsWith(prefix) || line === prefix.trimEnd()) {
        started = { kind, path: line.slice(prefix.length).trim() };
        break;
      }
    }
    if (started === null) throw new ParseFail(`error: parse ${ln}`);
    // Gather this section's body lines, up to the next section or End Patch.
    const body: Array<{ text: string; ln: number }> = [];
    let j = i + 1;
    while (j < last) {
      const l = lines[j]!;
      if (!isBlank(l) && V4A_STARTS.some(([prefix]) => l.startsWith(prefix) || l === prefix.trimEnd())) break;
      body.push({ text: l, ln: j + 1 });
      j += 1;
    }
    // Blank lines at the end of a section are not part of it.
    while (body.length > 0 && isBlank(body[body.length - 1]!.text)) body.pop();
    sections.push(buildV4aSection(started.kind, started.path, ln, body));
    i = j;
  }
  return sections;
}

/** Validate one V4A section's body and shape it into edits' data. */
function buildV4aSection(
  kind: 'add' | 'delete' | 'update',
  path: string,
  headerLn: number,
  body: Array<{ text: string; ln: number }>,
): V4aSection {
  if (kind === 'add') {
    const addLines: string[] = [];
    for (const b of body) {
      if (b.text.startsWith('+')) addLines.push(b.text.slice(1));
      else if (b.text === '') addLines.push('');
      else throw new ParseFail(`error: parse ${b.ln}`);
    }
    return { kind, path, addLines, moveTo: null, chunks: [], headerLn };
  }
  if (kind === 'delete') {
    if (body.length > 0) throw new ParseFail(`error: parse ${body[0]!.ln}`);
    return { kind, path, addLines: null, moveTo: null, chunks: [], headerLn };
  }
  // Update File: an optional *** Move to: first line, then chunks.
  let moveTo: string | null = null;
  const chunks: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  const closeChunk = (): void => {
    if (cur !== null) {
      chunks.push(cur);
      cur = null;
    }
  };
  for (const b of body) {
    const l = b.text;
    if (l.startsWith('*** Move to: ') || l === '*** Move to:') {
      if (moveTo !== null || cur !== null || chunks.length > 0) throw new ParseFail(`error: parse ${b.ln}`);
      moveTo = l.slice('*** Move to:'.length).trim();
      continue;
    }
    if (l.startsWith('@@')) {
      closeChunk();
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, items: [] };
      continue;
    }
    if (l === '*** End of File') {
      if (cur === null) throw new ParseFail(`error: parse ${b.ln}`);
      cur.eof = true;
      closeChunk();
      continue;
    }
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      if (cur === null) {
        if (chunks.length > 0) throw new ParseFail(`error: parse ${b.ln}`);
        // The first chunk may start at a body line.
        cur = { anchor: null, eof: false, items: [] };
      }
      if (l === '') cur.items.push({ kind: 'ctx', text: '', fromEmpty: true });
      else if (l.startsWith(' ')) cur.items.push({ kind: 'ctx', text: l.slice(1), fromEmpty: false });
      else if (l.startsWith('-')) cur.items.push({ kind: 'del', text: l.slice(1), fromEmpty: false });
      else cur.items.push({ kind: 'add', text: l.slice(1), fromEmpty: false });
      continue;
    }
    throw new ParseFail(`error: parse ${b.ln}`);
  }
  closeChunk();
  if (chunks.length === 0 && moveTo === null) throw new ParseFail(`error: parse ${headerLn}`);
  return { kind, path, addLines: null, moveTo, chunks, headerLn };
}

/** One V4A section as an edit. */
function v4aEdit(s: V4aSection, strict: boolean): Edit {
  return (tree) => {
    if (!isSafePath(s.path)) throw new EditFail('unsafe', s.path);
    if (s.moveTo !== null && !isSafePath(s.moveTo)) throw new EditFail('unsafe', s.moveTo);
    if (s.kind === 'add') {
      if (tree.current(s.path) !== null) throw new EditFail('exists', s.path);
      const ls = s.addLines!;
      tree.staged.set(s.path, ls.length === 0 ? '' : ls.join('\n') + '\n');
      return;
    }
    if (s.kind === 'delete') {
      if (tree.current(s.path) === null) throw new EditFail('missing', s.path);
      tree.staged.set(s.path, null);
      return;
    }
    const cur = tree.current(s.path);
    if (cur === null) throw new EditFail('missing', s.path);
    if (s.moveTo !== null && tree.current(s.moveTo) !== null) throw new EditFail('exists', s.moveTo);
    const state = readState(cur);
    let cursor = 0;
    const tiers = strict ? [0] : [0, 1, 2];
    for (const ch of s.chunks) {
      if (ch.anchor !== null) {
        let foundAt = -1;
        for (const t of tiers) {
          for (let k = cursor; k < state.lines.length; k += 1) {
            if (tierLine(state.lines[k]!, t) === tierLine(ch.anchor!, t)) {
              foundAt = k;
              break;
            }
          }
          if (foundAt >= 0) break;
        }
        if (foundAt < 0) throw new EditFail('no-match', s.path);
        cursor = foundAt + 1;
      }
      const old = hunkOld(ch.items);
      const pieces = hunkNew(ch.items);
      if (old.length === 0) {
        const at = ch.eof ? state.lines.length : cursor;
        state.lines.splice(at, 0, ...pieces.map((p) => p.text));
        cursor = at + pieces.length;
        continue;
      }
      const found = locate(state.lines, old, strict, cursor);
      if (found === null) throw new EditFail('no-match', s.path);
      let pos = found.at[0]!;
      if (ch.eof) {
        const ending = found.at.filter((p) => p + old.length === state.lines.length);
        if (ending.length === 0) throw new EditFail('no-match', s.path);
        pos = ending[0]!;
      }
      const replacement = buildReplacement(state.lines, pos, old, pieces, found.tier);
      state.lines.splice(pos, old.length, ...replacement);
      cursor = pos + replacement.length;
    }
    const out = writeState(state);
    if (s.moveTo !== null) {
      tree.staged.set(s.path, null);
      tree.staged.set(s.moveTo, out);
      tree.moves.push({ from: s.path, to: s.moveTo });
    } else {
      tree.staged.set(s.path, out);
    }
  };
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC.md section 9)                                      */
/* ------------------------------------------------------------------ */

/** One JSON edit object, or null when the value is not a valid edit. */
function oneJsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  const p = o.path;
  const existing = (tree: Tree): string => {
    if (!isSafePath(p)) throw new EditFail('unsafe', p);
    const t = tree.current(p);
    if (t === null) throw new EditFail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!isSafePath(p)) throw new EditFail('unsafe', p);
      if (tree.current(p) !== null) throw new EditFail('exists', p);
      // A JSON create writes its file_text byte for byte.
      tree.staged.set(p, text);
    };
  }
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = existing(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const text = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = text.indexOf(old); k >= 0; k = text.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditFail('no-match', p);
      if (count > 1) throw new EditFail('ambiguous', p);
      const at = text.indexOf(old);
      const out = text.slice(0, at) + toLf(newStr) + text.slice(at + old.length);
      tree.staged.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const atLine = o.insert_line;
    const add = splitPatch(o.new_str);
    return (tree) => {
      const before = existing(tree);
      const state = readState(before);
      if (atLine < 0 || atLine > state.lines.length) throw new EditFail('no-match', p);
      state.lines.splice(atLine, 0, ...add);
      tree.staged.set(p, writeState(state));
    };
  }
  return null;
}

/** Read a JSON patch: one array of edit objects, or JSON Lines. */
function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFail('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseFail(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new ParseFail(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = oneJsonEdit(x);
      if (e === null) throw new ParseFail(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = oneJsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new ParseFail(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Format detection, the run, and the trial hand-over                  */
/* ------------------------------------------------------------------ */

/** With --format=auto the format is the first of these that holds. */
function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

function readPatch(kind: string, text: string, lines: string[], strict: boolean): Edit[] {
  if (kind === 'unified') return parseUnified(lines).map((s) => unifiedEdit(s, strict));
  if (kind === 'search-replace') return parseSearchReplace(lines, strict);
  if (kind === 'v4a') return parseV4a(lines).map((s) => v4aEdit(s, strict));
  return parseJson(text, lines);
}

function usage(): { code: number; out: string[] } {
  return { code: 2, out: ['error: usage'] };
}

function run(argv: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of argv) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        const v = a.slice('--format='.length);
        if (format !== null || !FORMATS.includes(v)) return usage();
        format = v;
      } else if (a === '--check') {
        if (check) return usage();
        check = true;
      } else if (a === '--strict') {
        if (strict) return usage();
        strict = true;
      } else {
        return usage();
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return usage();
  const patchFile = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(patchFile ?? 0, 'utf8');
  } catch {
    if (patchFile !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatch(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = readPatch(kind, text, lines, strict);
    if (edits.length === 0) throw new ParseFail('error: parse 1');
  } catch (e) {
    if (e instanceof ParseFail) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: EditFail[] = [];
  for (const edit of edits) {
    const stagedBefore = new Map(tree.staged);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof EditFail)) throw e;
      // A failed edit changes nothing.
      tree.staged = stagedBefore;
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  // Work out what changed, in byte order of the paths (UTF-8). A move that
  // succeeded prints one R line, sorted by its new path, instead of the
  // pair's D and A lines.
  const rows: Array<{ key: string; line: string }> = [];
  const movedFrom = new Set<string>();
  const movedTo = new Set<string>();
  for (const m of tree.moves) {
    const wasOld = tree.read(m.from);
    const nowOld = tree.staged.get(m.from);
    const wasNew = tree.read(m.to);
    const nowNew = tree.staged.get(m.to);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: m.to, line: `R ${m.from} -> ${m.to}` });
      movedFrom.add(m.from);
      movedTo.add(m.to);
    }
  }
  for (const p of [...tree.staged.keys()]) {
    if (movedFrom.has(p) || movedTo.has(p)) continue;
    const was = tree.read(p);
    const now = tree.staged.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.staged.keys()]) {
      const was = tree.read(p);
      const now = tree.staged.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
