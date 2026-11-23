import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";

const FORMATS = ["auto", "unified", "search-replace", "v4a", "json"];
class ParseError extends Error {}
class EditError extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) { super(code); this.code = code; this.path = path; }
}
const blank = (s: string) => s.trim() === "";
const patchLines = (s: string) => {
  if (s === "") return [] as string[];
  const a = s.split("\n");
  if (s.endsWith("\n")) a.pop();
  return a.map((x) => x.endsWith("\r") ? x.slice(0, -1) : x);
};
const safe = (p: string) => p !== "" && !p.startsWith("/") && !p.includes("\\") && p.split("/").every((x) => x && x !== "." && x !== "..");

function fileParts(text: string) {
  if (text === "") return { lines: [] as string[], br: "\n", final: false };
  const n = text.indexOf("\n");
  const br = n > 0 && text[n - 1] === "\r" ? "\r\n" : "\n";
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}
function render(lines: string[], br: string, final: boolean) { return lines.join(br) + (final ? br : ""); }
function trimTabs(s: string) { return s.replace(/[ \t]+$/g, ""); }
function trimBoth(s: string) { return s.replace(/^[ \t]+|[ \t]+$/g, ""); }
function matchLine(a: string, b: string, tier: number) { return tier === 0 ? a === b : tier === 1 ? trimTabs(a) === trimTabs(b) : trimBoth(a) === trimBoth(b); }

function findMatches(file: string, old: string[], strict = false) {
  const { lines } = fileParts(file);
  if (old.length === 0) return { tier: 0, positions: [0] };
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions: number[] = [];
    for (let i = 0; i + old.length <= lines.length; i++) {
      if (old.every((x, j) => matchLine(lines[i + j]!, x, tier))) positions.push(i);
    }
    if (positions.length) return { tier, positions };
  }
  return { tier: -1, positions: [] };
}
function leading(s: string) { return (s.match(/^[ \t]*/) ?? [""])[0]; }
function newLinesFor(old: string[], next: string[], fileLines: string[], at: number, tier: number) {
  if (tier !== 2 || old.length === 0) return next;
  const from = leading(fileLines[at] ?? ""), prefix = leading(old[0] ?? "");
  return next.map((line, i) => {
    if (i < old.length && line === old[i]) return fileLines[at + i] ?? line;
    if (line.trim() && line.startsWith(prefix)) return from + line.slice(prefix.length);
    return line;
  });
}

class Tree {
  private originalFiles = new Map<string, string | null>();
  readonly files = new Map<string, string | null>();
  readonly renames: [string, string][] = [];
  private read(path: string) {
    if (!this.originalFiles.has(path)) {
      let value: string | null = null;
      try { if (statSync(path).isFile()) value = readFileSync(path, "utf8"); } catch {}
      this.originalFiles.set(path, value);
    }
    return this.originalFiles.get(path)!;
  }
  get(path: string) { return this.files.has(path) ? this.files.get(path)! : this.read(path); }
  original(path: string) { return this.read(path); }
  snapshot() { return new Map(this.files); }
  restore(snapshot: Map<string, string | null>) { this.files.clear(); for (const [k, v] of snapshot) this.files.set(k, v); }
}
type Edit = (tree: Tree) => void;
function ensurePath(path: string) { if (!safe(path)) throw new EditError("unsafe", path); }
function existing(tree: Tree, path: string) { ensurePath(path); const text = tree.get(path); if (text === null) throw new EditError("missing", path); return text; }
function replaceLines(tree: Tree, path: string, old: string[], next: string[], strict: boolean, choose?: (positions: number[], tier: number) => number) {
  const before = existing(tree, path), parts = fileParts(before), found = findMatches(before, old, strict);
  if (found.positions.length === 0) throw new EditError("no-match", path);
  const at = choose ? choose(found.positions, found.tier) : found.positions.length === 1 ? found.positions[0]! : (() => { throw new EditError("ambiguous", path); })();
  const written = newLinesFor(old, next, parts.lines, at, found.tier);
  parts.lines.splice(at, old.length, ...written);
  tree.files.set(path, render(parts.lines, parts.br, parts.final));
}

function detect(lines: string[]) {
  const i = lines.findIndex((x) => !blank(x));
  if (i < 0) return null;
  if (lines[i]!.trim() === "*** Begin Patch") return "v4a";
  const c = lines[i]!.trimStart()[0];
  if (c === "[" || c === "{") return "json";
  if (lines.some((x) => trimTabs(x) === "<<<<<<< SEARCH")) return "search-replace";
  if (lines.some((x, n) => x.startsWith("diff --git ") || (x.startsWith("--- ") && (lines[n + 1] ?? "").startsWith("+++ ")))) return "unified";
  return null;
}

function jsonEdit(value: unknown): Edit | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>, path = o.path;
  if (typeof path !== "string") return null;
  if (o.command === "create" && typeof o.file_text === "string") return (tree) => {
    ensurePath(path); if (tree.get(path) !== null) throw new EditError("exists", path); tree.files.set(path, o.file_text as string);
  };
  if (o.command === "str_replace" && typeof o.old_str === "string" && o.old_str !== "" && (o.new_str === undefined || typeof o.new_str === "string")) return (tree) => {
    const before = existing(tree, path), parts = fileParts(before), normalize = (x: string) => parts.br === "\r\n" ? x.replaceAll("\r\n", "\n") : x;
    const text = normalize(before), old = normalize(o.old_str as string), next = normalize((o.new_str as string | undefined) ?? "");
    let count = 0; for (let k = text.indexOf(old); k >= 0; k = text.indexOf(old, k + 1)) count++;
    if (count === 0) throw new EditError("no-match", path); if (count > 1) throw new EditError("ambiguous", path);
    const at = text.indexOf(old), out = text.slice(0, at) + next + text.slice(at + old.length); tree.files.set(path, parts.br === "\r\n" ? out.replaceAll("\n", "\r\n") : out);
  };
  if (o.command === "insert" && Number.isInteger(o.insert_line) && typeof o.new_str === "string") return (tree) => {
    const before = existing(tree, path), parts = fileParts(before), line = o.insert_line as number;
    if (line < 0 || line > parts.lines.length) throw new EditError("no-match", path);
    parts.lines.splice(line, 0, ...patchLines(o.new_str as string)); tree.files.set(path, render(parts.lines, parts.br, parts.final));
  };
  return null;
}
function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((x) => !blank(x)); if (first < 0) throw new ParseError("error: parse 1");
  const out: Edit[] = [], raw = lines[first]!.trimStart().startsWith("[") ? (() => { try { return JSON.parse(text); } catch { throw new ParseError(`error: parse ${first + 1}`); } })() : null;
  if (raw !== null) { if (!Array.isArray(raw)) throw new ParseError(`error: parse ${first + 1}`); for (const x of raw) { const e = jsonEdit(x); if (!e) throw new ParseError(`error: parse ${first + 1}`); out.push(e); } }
  else lines.forEach((line, i) => { if (blank(line)) return; let e: Edit | null = null; try { e = jsonEdit(JSON.parse(line)); } catch {} if (!e) throw new ParseError(`error: parse ${i + 1}`); out.push(e); });
  if (!out.length) throw new ParseError(`error: parse ${first + 1}`); return out;
}

function parseSearch(lines: string[], strict = false): Edit[] {
  const out: Edit[] = []; let i = 0, previous: string | null = null;
  while (i < lines.length) {
    if (trimTabs(lines[i]!) !== "<<<<<<< SEARCH") { i++; continue; }
    const marker = i + 1; let path: string | null = null;
    for (let j = i - 1; j >= 0; j--) { const s = lines[j]!.trim(); if (s && !s.startsWith("```")) { path = s; break; } }
    if (!path) path = previous; if (!path) throw new ParseError(`error: parse ${marker}`); previous = path;
    const old: string[] = [], next: string[] = []; i++;
    while (i < lines.length && trimTabs(lines[i]!) !== "=======") old.push(lines[i++]!);
    if (i >= lines.length) throw new ParseError(`error: parse ${marker}`); i++;
    while (i < lines.length && trimTabs(lines[i]!) !== ">>>>>>> REPLACE") next.push(lines[i++]!);
    if (i >= lines.length) throw new ParseError(`error: parse ${marker}`); i++;
    const p = path.trim(); out.push((tree) => {
      ensurePath(p);
      if (!old.length) { if (tree.get(p) !== null) throw new EditError("exists", p); tree.files.set(p, render(next, "\n", true)); }
      else replaceLines(tree, p, old, next, strict);
    });
  }
  if (!out.length) throw new ParseError("error: parse 1"); return out;
}

function parseV4A(lines: string[], strict = false): Edit[] {
  const first = lines.findIndex((x) => !blank(x)); if (first < 0 || lines[first]!.trim() !== "*** Begin Patch") throw new ParseError(`error: parse ${first < 0 ? 1 : first + 1}`);
  let last = lines.length - 1; while (last >= 0 && blank(lines[last]!)) last--; if (last < 0 || lines[last]!.trim() !== "*** End Patch") throw new ParseError(`error: parse ${lines.length + 1}`);
  const out: Edit[] = []; let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) { i++; continue; }
    const head = lines[i]!; let kind: string, path: string;
    if (head.startsWith("*** Add File: ")) kind = "add", path = head.slice(14).trim();
    else if (head.startsWith("*** Delete File: ")) kind = "delete", path = head.slice(17).trim();
    else if (head.startsWith("*** Update File: ")) kind = "update", path = head.slice(17).trim();
    else throw new ParseError(`error: parse ${i + 1}`);
    i++; const body: string[] = []; while (i < last && !lines[i]!.startsWith("*** Add File: ") && !lines[i]!.startsWith("*** Delete File: ") && !lines[i]!.startsWith("*** Update File: ")) body.push(lines[i++]!);
    if (kind === "add") { const add = body.map((x, n) => { if (x === "") return ""; if (!x.startsWith("+")) throw new ParseError(`error: parse ${first + n + 2}`); return x.slice(1); }); out.push((tree) => { ensurePath(path); if (tree.get(path) !== null) throw new EditError("exists", path); tree.files.set(path, render(add, "\n", true)); }); continue; }
    if (kind === "delete") { if (body.some((x) => x !== "")) throw new ParseError(`error: parse ${i}`); out.push((tree) => { existing(tree, path); tree.files.set(path, null); }); continue; }
    let move: string | null = null; if (body[0]?.startsWith("*** Move to: ")) { move = body.shift()!.slice(13).trim(); }
    const chunks: { anchor: string; body: string[]; eof: boolean }[] = []; let current: { anchor: string; body: string[]; eof: boolean } | null = null;
    for (const line of body) {
      if (line.startsWith("@@")) { current = { anchor: line.slice(2).trim(), body: [], eof: false }; chunks.push(current); continue; }
      if (line === "*** End of File") { if (!current) throw new ParseError(`error: parse ${i}`); current.eof = true; continue; }
      if (line === "" || line.startsWith(" ") || line.startsWith("-") || line.startsWith("+")) { if (!current) { current = { anchor: "", body: [], eof: false }; chunks.push(current); } current.body.push(line); continue; }
      throw new ParseError(`error: parse ${i}`);
    }
    for (const chunk of chunks) while (chunk.body.at(-1)?.trim() === "") chunk.body.pop();
    if (!chunks.length && !move) throw new ParseError(`error: parse ${i}`);
    out.push((tree) => {
      const oldPath = path; const before = existing(tree, oldPath); const parts = fileParts(before); let linesNow = parts.lines.slice(), cursor = 0;
      for (const chunk of chunks) {
        if (chunk.anchor) {
          const tiers = strict ? [0] : [0, 1, 2]; let at = -1;
          for (const tier of tiers) { at = linesNow.findIndex((x, n) => n >= cursor && matchLine(x, chunk.anchor, tier)); if (at >= 0) break; }
          if (at < 0) throw new EditError("no-match", oldPath); cursor = at + 1;
        }
        const old: string[] = [], next: string[] = [], context: (number | null)[] = [];
        let oldIndex = 0;
        for (const line of chunk.body) {
          if (line === "") { old.push(""); next.push(""); context.push(oldIndex++); }
          else if (line.startsWith(" ")) { const value = line.slice(1); old.push(value); next.push(value); context.push(oldIndex++); }
          else if (line.startsWith("-")) { old.push(line.slice(1)); oldIndex++; }
          else if (line.startsWith("+")) { next.push(line.slice(1)); context.push(null); }
        }
        if (!old.length) { const at = chunk.eof ? linesNow.length : cursor; linesNow.splice(at, 0, ...next); cursor = at + next.length; continue; }
        const candidate = findMatches(render(linesNow, parts.br, parts.final), old, strict); const positions = candidate.positions.filter((x) => x >= cursor && (!chunk.eof || x + old.length === linesNow.length)); if (!positions.length) throw new EditError("no-match", oldPath);
        const at = positions[0]!;
        const written = next.map((line, n) => {
          if (context[n] !== null) return linesNow[at + context[n]!] ?? line;
          const prefix = leading(old[0] ?? ""), filePrefix = leading(linesNow[at] ?? "");
          return candidate.tier === 2 && line.trim() && line.startsWith(prefix) ? filePrefix + line.slice(prefix.length) : line;
        });
        linesNow.splice(at, old.length, ...written); cursor = at + written.length;
      }
      const dest = move ?? oldPath; ensurePath(dest); if (move && tree.get(dest) !== null) throw new EditError("exists", dest); tree.files.set(dest, render(linesNow, parts.br, parts.final)); if (move) { tree.files.set(oldPath, null); tree.renames.push([oldPath, dest]); }
    });
  }
  return out;
}

function parseUnified(lines: string[], strict = false): Edit[] {
  const starts: number[] = []; let inDiff = false, sawHunk = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.startsWith("diff --git ")) { starts.push(i); inDiff = true; sawHunk = false; continue; }
    if (lines[i]!.startsWith("@@")) sawHunk = true;
    if (lines[i]!.startsWith("--- ") && (lines[i + 1] ?? "").startsWith("+++ ") && (!inDiff || sawHunk)) { starts.push(i); inDiff = false; sawHunk = false; }
  }
  if (!starts.length) throw new ParseError("error: parse 1"); const out: Edit[] = [];
  for (let si = 0; si < starts.length; si++) {
    const begin = starts[si]!, end = starts[si + 1] ?? lines.length, section = lines.slice(begin, end); let oldPath: string | null = null, newPath: string | null = null;
    const hunks: { a: number; body: string[]; noFinal: boolean }[] = [];
    for (let i = 0; i < section.length; i++) {
      const line = section[i]!;
      if (line.startsWith("--- ") && (section[i + 1] ?? "").startsWith("+++ ")) {
        oldPath = line.slice(4).split("\t")[0]!.trim();
        newPath = section[i + 1]!.slice(4).split("\t")[0]!.trim();
        oldPath = oldPath === "/dev/null" ? null : oldPath.replace(/^a\//, "");
        newPath = newPath === "/dev/null" ? null : newPath.replace(/^b\//, "");
        continue;
      }
      if (line.startsWith("@@")) {
        const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/); if (!m) throw new ParseError(`error: parse ${begin + i + 1}`);
        const body: string[] = []; let noFinal = false; i++;
        while (i < section.length && !section[i]!.startsWith("@@") && !section[i]!.startsWith("diff --git ") && !(section[i]!.startsWith("--- ") && (section[i + 1] ?? "").startsWith("+++ "))) { const x = section[i]!; if (x.startsWith("\\ No newline")) noFinal = true; else if (x === "" || " +-".includes(x[0] ?? "")) body.push(x); else break; i++; }
        while (body.at(-1)?.trim() === "") body.pop();
        i--; hunks.push({ a: Number(m[1]), body, noFinal });
      }
    }
    if (!oldPath && !newPath) throw new ParseError(`error: parse ${begin + 1}`);
    const op = oldPath, np = newPath; out.push((tree) => {
      const path = op ?? np!; ensurePath(path); const before = op ? existing(tree, op) : ""; let parts = fileParts(before), linesNow = parts.lines.slice(), delta = 0;
      if (op && !np) { if (tree.get(op) === null) throw new EditError("missing", op); tree.files.set(op, null); return; }
      if (!op && np) { if (tree.get(np) !== null) throw new EditError("exists", np); const added: string[] = []; for (const h of hunks) for (const x of h.body) if (x.startsWith("+")) added.push(x.slice(1)); tree.files.set(np, render(added, "\n", !hunks.some((h) => h.noFinal))); return; }
      for (const h of hunks) {
        const old = h.body.filter((x) => x === "" || x.startsWith(" ") || x.startsWith("-")).map((x) => x.slice(1));
        const next = h.body.filter((x) => x === "" || x.startsWith(" ") || x.startsWith("+")).map((x) => x.slice(1));
        if (!old.length) { const at = Math.min(linesNow.length, Math.max(0, h.a + delta)); linesNow.splice(at, 0, ...next); delta += next.length; continue; }
        const found = findMatches(render(linesNow, parts.br, parts.final), old, strict); if (!found.positions.length) throw new EditError("no-match", path);
        const target = h.a - 1 + delta; const at = found.positions.reduce((best, x) => Math.abs(x - target) < Math.abs(best - target) ? x : best, found.positions[0]!);
        let oldIndex = 0; const context: (number | null)[] = [];
        for (const line of h.body) {
          if (line === "") { context.push(oldIndex++); }
          else if (line.startsWith(" ")) { context.push(oldIndex++); }
          else if (line.startsWith("-")) { oldIndex++; }
          else if (line.startsWith("+")) { context.push(null); }
        }
        const prefix = leading(old[0] ?? ""), filePrefix = leading(linesNow[at] ?? "");
        const written = next.map((line, n) => context[n] !== null ? linesNow[at + context[n]!] ?? line : found.tier === 2 && line.trim() && line.startsWith(prefix) ? filePrefix + line.slice(prefix.length) : line);
        linesNow.splice(at, old.length, ...written); delta += next.length - old.length;
        if (h.noFinal && at + next.length >= linesNow.length) parts.final = false; else if (at + next.length >= linesNow.length) parts.final = true;
      }
      const dest = np!; ensurePath(dest); if (dest !== op && tree.get(dest) !== null) throw new EditError("exists", dest); tree.files.set(dest, render(linesNow, parts.br, parts.final)); if (dest !== op) { tree.files.set(op!, null); tree.renames.push([op!, dest]); }
    });
  }
  return out;
}

function parseArgs(args: string[]) {
  let format = "auto", check = false, strict = false, ended = false; const pos: string[] = [];
  for (const a of args) {
    if (!ended && a === "--") ended = true;
    else if (!ended && a.startsWith("-") && a !== "-") {
      if (a.startsWith("--format=") && format === "auto" && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === "--check" && !check) check = true;
      else if (a === "--strict" && !strict) strict = true;
      else throw new ParseError("error: usage");
    } else pos.push(a);
  }
  if (pos.length > 1) throw new ParseError("error: usage"); return { format, check, strict, file: pos[0] === "-" ? null : (pos[0] ?? null) };
}

function main(args: string[]) {
  let opts; try { opts = parseArgs(args); } catch (e) { return { code: 2, out: [(e as Error).message] }; }
  let text = ""; try { text = readFileSync(opts.file ?? 0, "utf8"); } catch { return { code: 2, out: ["error: no-patch"] }; }
  const lines = patchLines(text), kind = opts.format === "auto" ? detect(lines) : opts.format; if (!kind) return { code: 2, out: ["error: format"] };
  let edits: Edit[]; try { edits = kind === "json" ? parseJson(text, lines) : kind === "search-replace" ? parseSearch(lines, opts.strict) : kind === "v4a" ? parseV4A(lines, opts.strict) : parseUnified(lines, opts.strict); } catch (e) { return { code: 2, out: [(e as Error).message] }; }
  if (!edits.length) return { code: 2, out: ["error: parse 1"] };
  const tree = new Tree(), failed: EditError[] = [];
  for (const edit of edits) { const save = tree.snapshot(); try { edit(tree); } catch (e) { if (!(e instanceof EditError)) throw e; tree.restore(save); failed.push(e); } }
  if (failed.length) return { code: 1, out: [...failed.map((x) => `error: ${x.code} ${x.path}`), `failed: ${failed.length} of ${edits.length} edits`] };
  const changed: string[] = [...tree.files.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).filter((p) => tree.original(p) !== tree.files.get(p));
  if (!opts.check) for (const p of changed) { const value = tree.files.get(p)!; if (value === null) rmSync(p, { force: true }); else { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, value); } }
  const renamedOld = new Set(tree.renames.map(([oldPath]) => oldPath));
  const renamedNew = new Set(tree.renames.map(([, newPath]) => newPath));
  const outputRows: { key: string; line: string }[] = changed.filter((p) => !renamedNew.has(p) && !renamedOld.has(p)).map((p) => ({ key: p, line: `${tree.original(p) === null ? "A" : tree.files.get(p) === null ? "D" : "M"} ${p}` }));
  for (const [oldPath, newPath] of tree.renames) outputRows.push({ key: newPath, line: `R ${oldPath} -> ${newPath}` });
  outputRows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  return { code: 0, out: [...outputRows.map((x) => x.line), `ok: ${changed.length - tree.renames.length} ${changed.length - tree.renames.length === 1 ? "file" : "files"}`] };
}

const env = process.env.MAKEFUN_ENV_URL;
if (env) { const { runTrial } = await import("./runner.ts"); await runTrial(env); }
else { const result = main(process.argv.slice(2)); writeSync(1, result.out.map((x) => `${x}\n`).join("")); process.exitCode = result.code; }
