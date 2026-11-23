// main.ts is mend, the CLI SPEC.md specifies (MIT). Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/* ---------- files as lines (SPEC section 3) ---------- */

interface FileModel {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function serialize(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

/* ---------- matching lines at three tiers (SPEC section 5) ---------- */

const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];
const trailTrim = (s: string): string => s.replace(/[ \t]+$/, '');
const bothTrim = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trailTrim(a) === trailTrim(b);
  return bothTrim(a) === bothTrim(b);
}

/** Occurrences of O in fileLines at the first tier that has one (positions >= minPos; eofOnly: ends at last line). */
function findTier(
  fileLines: string[],
  O: string[],
  strict: boolean,
  minPos = 0,
  eofOnly = false,
): { tier: number; positions: number[] } | null {
  const norm = (s: string, tier: number): string => (tier === 0 ? s : tier === 1 ? trailTrim(s) : bothTrim(s));
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const fN = tier === 0 ? fileLines : fileLines.map((s) => norm(s, tier));
    const oN = tier === 0 ? O : O.map((s) => norm(s, tier));
    const positions: number[] = [];
    for (let i = minPos; i + O.length <= fileLines.length; i += 1) {
      if (eofOnly && i + O.length !== fileLines.length) continue;
      let ok = true;
      for (let k = 0; k < O.length; k += 1) {
        if (fN[i + k] !== oN[k]) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

interface NLine {
  text: string;
  ctx: number | null; // index into O for a context line, else null
}

/** The lines N writes over the match at pos: context lines keep the file's own text; tier 2 re-indents the rest. */
function buildN(N: NLine[], fileLines: string[], pos: number, tier: number, O: string[]): string[] {
  const F = O.length > 0 ? leadWs(fileLines[pos]!) : '';
  const P = O.length > 0 ? leadWs(O[0]!) : '';
  return N.map((n) => {
    if (n.ctx !== null) return fileLines[pos + n.ctx]!;
    if (tier === 2 && n.text.trim() !== '' && n.text.startsWith(P)) return F + n.text.slice(P.length);
    return n.text;
  });
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ---------- JSON edits (SPEC section 9) ---------- */

function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ---------- unified diffs (SPEC section 6) ---------- */

type BodyKind = 'ctx' | 'old' | 'new' | 'bs';
interface BodyLine {
  kind: BodyKind;
  text: string;
}
interface Hunk {
  A: number;
  body: BodyLine[];
}
interface Section {
  diffOld: string | null;
  diffNew: string | null;
  pairOld: string | null | undefined; // undefined: no ---/+++ pair; null: /dev/null
  pairNew: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(?:[ \t].*)?$/;
const DIFF_RE = /^diff --git a\/(.+?) b\/(.+)$/;

function hdrPath(line: string): string | null {
  const raw = line.slice(4);
  const tab = raw.indexOf('\t');
  const p = (tab >= 0 ? raw.slice(0, tab) : raw).trim();
  if (p === '/dev/null') return null;
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

function bsAfterLastCtxNew(hunk: Hunk): boolean {
  for (let i = hunk.body.length - 1; i >= 0; i -= 1) {
    const k = hunk.body[i]!.kind;
    if (k === 'ctx' || k === 'new') return hunk.body[i + 1]?.kind === 'bs';
  }
  return false;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let sec: Section | null = null;
  let hunk: Hunk | null = null;
  const isDiff = (l: string): boolean => l.startsWith('diff --git ') || l === 'diff --git';
  const isOld = (l: string): boolean => l.startsWith('--- ');
  const isNew = (l: string): boolean => l.startsWith('+++ ');
  const newSection = (): Section => {
    const s: Section = {
      diffOld: null,
      diffNew: null,
      pairOld: undefined,
      pairNew: undefined,
      renameFrom: undefined,
      renameTo: undefined,
      newFile: false,
      delFile: false,
      hunks: [],
    };
    sections.push(s);
    sec = s;
    hunk = null;
    return s;
  };
  const startDiff = (l: string, lineNo: number): void => {
    const m = DIFF_RE.exec(l);
    if (m === null) throw new Exit2(`error: parse ${lineNo}`);
    const s = newSection();
    s.diffOld = m[1]!;
    s.diffNew = m[2]!;
  };
  const bodyKind = (l: string): BodyKind | null => {
    if (l === '') return 'ctx';
    const c = l[0]!;
    if (c === ' ') return 'ctx';
    if (c === '-') return 'old';
    if (c === '+') return 'new';
    if (c === '\\') return 'bs';
    return null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i]!;
    const next = lines[i + 1] ?? '';
    if (hunk !== null) {
      if (isDiff(l)) {
        hunk = null;
        startDiff(l, i + 1);
        continue;
      }
      if (isOld(l) && isNew(next)) {
        hunk = null;
        const s = newSection();
        s.pairOld = hdrPath(l);
        s.pairNew = hdrPath(next);
        i += 1;
        continue;
      }
      if (l.startsWith('@@')) {
        const m = HUNK_RE.exec(l);
        if (m === null) throw new Exit2(`error: parse ${i + 1}`);
        hunk = { A: Number(m[1]), body: [] };
        sec!.hunks.push(hunk);
        continue;
      }
      const k = bodyKind(l);
      if (k !== null) {
        hunk.body.push({ kind: k, text: l === '' ? '' : l.slice(1) });
        continue;
      }
      hunk = null; // body ended; fall through and read this line outside a body
    }
    if (isDiff(l)) {
      startDiff(l, i + 1);
      continue;
    }
    if (isOld(l) && isNew(next)) {
      if (sec !== null && sec.hunks.length === 0 && sec.pairOld === undefined) {
        sec.pairOld = hdrPath(l);
        sec.pairNew = hdrPath(next);
      } else {
        const s = newSection();
        s.pairOld = hdrPath(l);
        s.pairNew = hdrPath(next);
      }
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      hunk = { A: Number(m[1]), body: [] };
      sec.hunks.push(hunk);
      continue;
    }
    if (sec !== null && sec.hunks.length === 0) {
      if (isOld(l)) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('rename from ')) sec.renameFrom = l.slice(12).trim();
      else if (l.startsWith('rename to ')) sec.renameTo = l.slice(10).trim();
      else if (l.startsWith('new file mode')) sec.newFile = true;
      else if (l.startsWith('deleted file mode')) sec.delFile = true;
      continue;
    }
    // prose outside sections and bodies is ignored
  }
  // empty lines at the end of a body are not part of it
  for (const s of sections) {
    for (const h of s.hunks) {
      while (h.body.length > 0) {
        const last = h.body[h.body.length - 1]!;
        if (last.kind === 'ctx' && last.text === '') h.body.pop();
        else break;
      }
    }
  }

  return sections.map((s) => (tree: Tree) => {
    const hasPair = s.pairOld !== undefined;
    const oldP: string | null = hasPair ? s.pairOld! : (s.renameFrom ?? s.diffOld);
    const newP: string | null = hasPair ? s.pairNew! : (s.renameTo ?? s.diffNew);
    for (const p of [oldP, newP]) {
      if (p !== null && !safe(p)) throw new Fail('unsafe', p);
    }
    if (newP === null || (s.delFile && oldP !== null && !s.newFile)) {
      // deletion
      if (oldP === null) throw new Fail('missing', '');
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP === null || s.newFile) {
      // creation
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const added: string[] = [];
      let bs = false;
      for (const h of s.hunks) {
        for (let bi = 0; bi < h.body.length; bi += 1) {
          if (h.body[bi]!.kind === 'new') {
            added.push(h.body[bi]!.text);
            bs = h.body[bi + 1]?.kind === 'bs';
          }
        }
      }
      tree.now.set(newP, serialize(added, '\n', !bs));
      return;
    }
    // change or move
    const text = tree.get(oldP);
    if (text === null) throw new Fail('missing', oldP);
    const isMove = newP !== oldP;
    if (isMove && tree.get(newP) !== null) throw new Fail('exists', newP);
    const model = parseFile(text);
    const fileLines = [...model.lines];
    let fin = model.final;
    let d = 0;
    for (const h of s.hunks) {
      const O: string[] = [];
      const N: NLine[] = [];
      for (const b of h.body) {
        if (b.kind === 'ctx') {
          N.push({ text: b.text, ctx: O.length });
          O.push(b.text);
        } else if (b.kind === 'old') O.push(b.text);
        else if (b.kind === 'new') N.push({ text: b.text, ctx: null });
      }
      if (O.length === 0) {
        const ins = Math.max(0, Math.min(h.A + d, fileLines.length));
        const atEnd = ins === fileLines.length;
        fileLines.splice(ins, 0, ...N.map((n) => n.text));
        if (atEnd) fin = !bsAfterLastCtxNew(h);
        d += N.length;
      } else {
        const found = findTier(fileLines, O, strict);
        if (found === null) throw new Fail('no-match', oldP);
        const target = h.A - 1 + d;
        let pos = found.positions[0]!;
        for (const cand of found.positions) {
          if (Math.abs(cand - target) < Math.abs(pos - target)) pos = cand;
        }
        const reachesEnd = pos + O.length === fileLines.length;
        const written = buildN(N, fileLines, pos, found.tier, O);
        fileLines.splice(pos, O.length, ...written);
        if (reachesEnd) fin = !bsAfterLastCtxNew(h);
        d += N.length - O.length;
      }
    }
    tree.now.set(newP, serialize(fileLines, model.br, fin));
    if (isMove) {
      tree.now.set(oldP, null);
      tree.moves.push([oldP, newP]);
    }
  });
}

/* ---------- SEARCH/REPLACE blocks (SPEC section 7) ---------- */

function srEdits(lines: string[], strict: boolean): Edit[] {
  interface Block {
    path: string;
    oldLines: string[];
    newLines: string[];
  }
  const blocks: Block[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1; // index of previous block's REPLACE line
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let j = i + 1;
    while (j < lines.length && lines[j]!.trimEnd() !== '=======') j += 1;
    if (j >= lines.length) throw new Exit2(`error: parse ${searchLine}`);
    let k = j + 1;
    while (k < lines.length && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') k += 1;
    if (k >= lines.length) throw new Exit2(`error: parse ${searchLine}`);
    let path: string | null = null;
    for (let b = i - 1; b > prevEnd; b -= 1) {
      const cand = lines[b]!;
      if (blank(cand)) continue;
      const t = cand.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    blocks.push({ path, oldLines: lines.slice(i + 1, j), newLines: lines.slice(j + 1, k) });
    prevPath = path;
    prevEnd = k;
    i = k + 1;
  }
  return blocks.map((blk) => (tree: Tree) => {
    const p = blk.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (blk.oldLines.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, serialize(blk.newLines, '\n', true));
      return;
    }
    const text = tree.get(p);
    if (text === null) throw new Fail('missing', p);
    const model = parseFile(text);
    const found = findTier(model.lines, blk.oldLines, strict);
    if (found === null) throw new Fail('no-match', p);
    if (found.positions.length > 1) throw new Fail('ambiguous', p);
    const pos = found.positions[0]!;
    const N: NLine[] = blk.newLines.map((t) => ({ text: t, ctx: null }));
    const written = buildN(N, model.lines, pos, found.tier, blk.oldLines);
    const out = [...model.lines];
    out.splice(pos, blk.oldLines.length, ...written);
    tree.now.set(p, serialize(out, model.br, model.final));
  });
}

/* ---------- V4A patches (SPEC section 8) ---------- */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last > first && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const HEADERS: [string, string][] = [
    ['*** Add File: ', 'add'],
    ['*** Delete File: ', 'delete'],
    ['*** Update File: ', 'update'],
  ];
  const headerOf = (l: string): { kind: string; path: string } | null => {
    for (const [prefix, kind] of HEADERS) {
      if (l.startsWith(prefix)) return { kind, path: l.slice(prefix.length).trim() };
    }
    return null;
  };

  interface RawLine {
    text: string;
    no: number;
  }
  interface VSection {
    kind: string;
    path: string;
    lineNo: number;
    addLines: string[];
    moveTo: string | null;
    chunks: VChunk[];
  }
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    const hdr = headerOf(l);
    if (hdr === null) throw new Exit2(`error: parse ${i + 1}`);
    const raw: RawLine[] = [];
    let j = i + 1;
    while (j < last && headerOf(lines[j]!) === null) {
      raw.push({ text: lines[j]!, no: j + 1 });
      j += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    const sec: VSection = { kind: hdr.kind, path: hdr.path, lineNo: i + 1, addLines: [], moveTo: null, chunks: [] };
    if (hdr.kind === 'add') {
      for (const r of raw) {
        if (r.text.startsWith('+')) sec.addLines.push(r.text.slice(1));
        else if (r.text === '') sec.addLines.push('');
        else throw new Exit2(`error: parse ${r.no}`);
      }
    } else if (hdr.kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.no}`);
    } else {
      let idx = 0;
      if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
        sec.moveTo = raw[0]!.text.slice(13).trim();
        idx = 1;
      }
      let cur: VChunk | null = null;
      let closed = false;
      for (; idx < raw.length; idx += 1) {
        const r = raw[idx]!;
        const t = r.text;
        if (t.startsWith('@@')) {
          const anchor = t.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
          sec.chunks.push(cur);
          closed = false;
        } else if (t.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${r.no}`);
          cur.eof = true;
          cur = null;
          closed = true;
        } else if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
          if (cur === null) {
            if (sec.chunks.length > 0 || closed) throw new Exit2(`error: parse ${r.no}`);
            cur = { anchor: null, eof: false, body: [] };
            sec.chunks.push(cur);
          }
          const kind: BodyKind = t === '' || t[0] === ' ' ? 'ctx' : t[0] === '-' ? 'old' : 'new';
          cur.body.push({ kind, text: t === '' ? '' : t.slice(1) });
        } else {
          throw new Exit2(`error: parse ${r.no}`);
        }
      }
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.lineNo}`);
    }
    sections.push(sec);
    i = j;
  }

  return sections.map((sec) => (tree: Tree) => {
    const p = sec.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (sec.kind === 'add') {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, serialize(sec.addLines, '\n', true));
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    // update
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const text = tree.get(p);
    if (text === null) throw new Fail('missing', p);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const model = parseFile(text);
    const fileLines = [...model.lines];
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null) {
        const tiers = strict ? [0] : [0, 1, 2];
        let at = -1;
        for (const tier of tiers) {
          for (let x = cursor; x < fileLines.length; x += 1) {
            if (tierEq(fileLines[x]!, chunk.anchor, tier)) {
              at = x;
              break;
            }
          }
          if (at >= 0) break;
        }
        if (at < 0) throw new Fail('no-match', p);
        cursor = at + 1;
      }
      const O: string[] = [];
      const N: NLine[] = [];
      for (const b of chunk.body) {
        if (b.kind === 'ctx') {
          N.push({ text: b.text, ctx: O.length });
          O.push(b.text);
        } else if (b.kind === 'old') O.push(b.text);
        else if (b.kind === 'new') N.push({ text: b.text, ctx: null });
      }
      if (O.length === 0) {
        const ins = chunk.eof ? fileLines.length : cursor;
        fileLines.splice(ins, 0, ...N.map((n) => n.text));
        cursor = ins + N.length;
      } else {
        const found = findTier(fileLines, O, strict, cursor, chunk.eof);
        if (found === null) throw new Fail('no-match', p);
        const pos = found.positions[0]!;
        const written = buildN(N, fileLines, pos, found.tier, O);
        fileLines.splice(pos, O.length, ...written);
        cursor = pos + written.length;
      }
    }
    const dest = sec.moveTo ?? p;
    tree.now.set(dest, serialize(fileLines, model.br, model.final));
    if (sec.moveTo !== null) {
      tree.now.set(p, null);
      tree.moves.push([p, sec.moveTo]);
    }
  });
}

/* ---------- invocation, output, atomicity (SPEC sections 1, 2, 10) ---------- */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // output rows, with R replacing a moved pair's D and A lines (SPEC section 2)
  const consumed = new Set<string>();
  const keyed: { key: string; row: string }[] = [];
  for (const [o, n] of tree.moves) {
    if (consumed.has(o) || consumed.has(n)) continue;
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null) {
      keyed.push({ key: n, row: `R ${o} -> ${n}` });
      consumed.add(o);
      consumed.add(n);
    }
  }
  for (const p of tree.now.keys()) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    keyed.push({ key: p, row: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  keyed.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = keyed.map((k) => k.row);
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
