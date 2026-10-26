// Build the GitHub Pages site: every browser example (and baseline) as static
// files, so that each can be opened and used as it was measured.
//
//   node tools/build-site.ts [outDir]     (default .cache/site)
//
// GitHub Pages cannot serve .ts as JavaScript, so each module reachable from
// a page is written as .js with its types stripped (the same transform the
// harness server uses) and its import specifiers rewritten. Data comes from
// each spec.yaml's datasets.outputs; files over GitHub's 100 MB limit stop
// the build.
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { loadSpec } from '../harness/lib/spec.ts';
import { expandFiles } from '../harness/lib/footprint.ts';
import type { Spec } from '../harness/lib/types.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, process.argv[2] ?? '.cache/site');
const MAX_FILE = 100 * 1024 * 1024;
const REPO_URL = 'https://github.com/yuiseki/map-from-scratch';

// Module specifiers in a source file: static imports, re-exports, dynamic
// imports with a string literal, and <script src> in HTML.
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"]+)\1/g;
const SCRIPT_SRC = /<script\b[^>]*\bsrc=(['"])([^'"]+)\1/g;
const LINK_HREF = /<link\b[^>]*\bhref=(['"])([^'"]+)\1/g;

const toJs = (p: string) => p.replace(/\.ts$/, '.js');
const isLocal = (s: string) => s.startsWith('./') || s.startsWith('../');

function writeOut(srcAbs: string, body: Buffer | string): void {
  const dst = join(out, toJs(relative(root, srcAbs)));
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, body);
}

const copied = new Set<string>();
function copyModule(abs: string): void {
  if (copied.has(abs)) return;
  copied.add(abs);
  if (!existsSync(abs)) throw new Error(`missing module ${relative(root, abs)}`);
  let src = readFileSync(abs, 'utf8');
  const deps: string[] = [];
  src = src.replace(SPECIFIER, (m, q: string, spec: string) => {
    if (!isLocal(spec)) return m;
    deps.push(resolve(dirname(abs), spec));
    return m.replace(`${q}${spec}${q}`, `${q}${toJs(spec)}${q}`);
  });
  if (abs.endsWith('.ts')) src = stripTypeScriptTypes(src, { mode: 'transform' });
  writeOut(abs, src);
  for (const d of deps) copyModule(d);
}

function copyPage(htmlAbs: string): void {
  let html = readFileSync(htmlAbs, 'utf8');
  const scripts: string[] = [];
  html = html.replace(SCRIPT_SRC, (m, q: string, src: string) => {
    if (!isLocal(src)) return m;
    scripts.push(resolve(dirname(htmlAbs), src));
    return m.replace(`${q}${src}${q}`, `${q}${toJs(src)}${q}`);
  });
  html = html.replace(LINK_HREF, (m, q: string, href: string) => {
    if (!isLocal(href)) return m;
    const abs = resolve(dirname(htmlAbs), href);
    if (!href.endsWith('.ts')) { copyFile(abs); return m; }
    scripts.push(abs);   // modulepreload of a module
    return m.replace(`${q}${href}${q}`, `${q}${toJs(href)}${q}`);
  });
  writeOut(htmlAbs, html);
  for (const s of scripts) (s.endsWith('.ts') || s.endsWith('.js') ? copyModule : copyFile)(s);
}

function copyFile(abs: string): void {
  if (copied.has(abs)) return;
  copied.add(abs);
  const size = statSync(abs).size;
  if (size > MAX_FILE) throw new Error(`${relative(root, abs)} is ${(size / 2 ** 20).toFixed(0)} MB, over GitHub Pages' 100 MB per file`);
  const dst = join(out, relative(root, abs));
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(abs, dst);
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

// The examples, from spec.yaml, with their latest measurements when present.
function indexPage(rows: { id: string; dir: string; spec: Spec }[]): string {
  const items = rows.map(({ id, dir, spec }) => {
    const d = spec.definition!;
    const chosen = d.architecture_selection.chosen;
    const latest = join(root, 'results', id, 'latest.json');
    let numbers = '';
    if (existsSync(latest)) {
      const r = JSON.parse(readFileSync(latest, 'utf8'));
      const s = (k: string, st = 'p50') => r.summaries?.[k]?.[st];
      const parts: string[] = [];
      if (s('code_gzip_bytes') != null) parts.push(`コード ${(s('code_gzip_bytes') / 1024).toFixed(1)} KB gzip`);
      if (s('data_gzip_bytes')) parts.push(`データ ${(s('data_gzip_bytes') / 1024).toFixed(0)} KB gzip`);
      if (s('first_frame_ms') != null) parts.push(`初回描画 ${Math.round(s('first_frame_ms'))} ms`);
      if (s('frame_ms', 'p95') != null) parts.push(`フレーム p95 ${s('frame_ms', 'p95').toFixed(2)} ms`);
      numbers = `<p class="num">${esc(parts.join(' ・ '))}</p>`;
    }
    const tag = spec.baseline ? '<span class="tag">比較用</span>' : '';
    return `<li><a class="open" href="${esc(dir)}/">${esc(id)}</a> ${tag}
  <p class="req">${esc(d.request)}</p>
  <p class="how">${esc([chosen.api, chosen.language].filter(Boolean).join(' / '))}</p>${numbers}
  <p class="links"><a href="${REPO_URL}/tree/main/${esc(dir)}">ソース</a> ・ <a href="${REPO_URL}/blob/main/${esc(dir)}/spec.yaml">spec.yaml</a> ・ <a href="${REPO_URL}/blob/main/${esc(dir)}/REQUEST.md">設計と計測</a></p></li>`;
  }).join('\n');
  return `<!doctype html>
<html lang="ja">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>map-from-scratch</title>
<style>
  :root { --bg: #fafaf7; --fg: #1f2328; --muted: #59636e; --line: #d8dee4; --accent: #0b6e4f; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0d1117; --fg: #e6edf3; --muted: #9198a1; --line: #30363d; --accent: #3fb950; } }
  body { margin: 0 auto; max-width: 860px; padding: 24px 16px 64px; background: var(--bg); color: var(--fg); font: 16px/1.7 system-ui, sans-serif; }
  h1 { font-size: 1.6rem; margin: 0 0 4px; }
  .lead { color: var(--muted); margin: 0 0 24px; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { border-top: 1px solid var(--line); padding: 16px 0; }
  .open { font-weight: 600; font-size: 1.05rem; color: var(--accent); }
  .req { margin: 6px 0; }
  .how, .num, .links { margin: 2px 0; color: var(--muted); font-size: 0.9rem; }
  .tag { font-size: 0.75rem; border: 1px solid var(--line); border-radius: 4px; padding: 0 6px; color: var(--muted); }
  a { color: var(--accent); }
</style>
<h1>map-from-scratch</h1>
<p class="lead">「X をしたいから地図を作って」という依頼ごとに、その目的だけの地図描画器をほぼゼロから作り、計測で確かめた例です。各例は実際に操作できます。数値はリポジトリのハーネスで測ったものです。 <a href="${REPO_URL}">GitHub</a></p>
<ul>
${items}
</ul>
`;
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const rows: { id: string; dir: string; spec: Spec }[] = [];
for (const base of ['examples', 'baselines']) {
  for (const id of readdirSync(join(root, base)).sort()) {
    const dir = join(root, base, id);
    if (!existsSync(join(dir, 'spec.yaml'))) continue;
    const spec = loadSpec(dir);
    if (spec.runtime !== 'browser') continue;
    copyPage(join(dir, 'index.html'));
    for (const f of expandFiles(root, spec.footprint.code)) if (!f.endsWith('.ts') && !f.endsWith('.html')) copyFile(join(root, f));
    for (const f of expandFiles(root, spec.footprint.data)) copyFile(join(root, f));
    rows.push({ id, dir: `${base}/${id}`, spec });
  }
}
writeFileSync(join(out, 'index.html'), indexPage(rows));
writeFileSync(join(out, '.nojekyll'), '');   // serve dot directories (.cache) as they are
let total = 0;
const walk = (d: string): void => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else total += statSync(p).size; } };
walk(out);
console.log(`site: ${rows.length} pages, ${copied.size} files, ${(total / 2 ** 20).toFixed(1)} MB in ${relative(root, out)}`);
