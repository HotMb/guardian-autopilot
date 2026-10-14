import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('../site/studio.html', import.meta.url), 'utf8');
const app = await readFile(new URL('../site/studio.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../site/studio.css', import.meta.url), 'utf8');

function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

test('Studio presents keyboard-operable, accessible list and contact-sheet controls', () => {
  assert.match(html, /role="group" aria-label="Image presentation"/);
  assert.match(html, /id="view-list"[^>]*aria-pressed="true"[^>]*aria-controls="table-scroll"/);
  assert.match(html, /id="view-contact-sheet"[^>]*aria-pressed="false"[^>]*aria-controls="contact-sheet"/);
  assert.match(html, /id="contact-sheet"[^>]*role="region"[^>]*aria-label="Image contact sheet"[^>]*aria-describedby="contact-sheet-help"[^>]*hidden/);
  assert.match(html, /In Similar candidates, related heuristic candidates appear together/);
  assert.match(html, /no file is selected automatically/i);
});

test('contact sheet stays dense on narrow screens and wraps full paths instead of clipping them', () => {
  assert.match(css, /\.studio-contact-grid\{[^}]*repeat\(auto-fill,minmax\(138px,1fr\)\)/);
  assert.ok(css.includes('@media(max-width:560px){.studio-contact-sheet{padding:8px}.studio-contact-grid{grid-template-columns:repeat(auto-fill,minmax(125px,1fr))'));
  assert.match(css, /\.studio-contact-path\{[^}]*overflow-wrap:anywhere;word-break:break-word/);
  assert.match(css, /\.studio-contact-sheet\[hidden\][^}]*display:none/);
});

test('contact-sheet cards use local previews and show text-safe paths, names, size, type, and separate signals', () => {
  const card = sourceBetween(app, 'function makeContactCard(record)', 'function renderContactSheet');
  assert.match(card, /previewUrl\(record\)/);
  assert.match(card, /image\.alt = ''/);
  assert.ok(card.includes("setAttribute('aria-label', `Inspect ${record.path}`)"));
  assert.match(card, /name\.textContent = record\.name/);
  assert.match(card, /path\.textContent = record\.path/);
  assert.match(card, /sizeValue\.textContent = formatBytes\(record\.bytes\)/);
  assert.match(card, /typeValue\.textContent = record\.type/);
  assert.match(card, /Exact byte match/);
  assert.match(card, /Visual candidate · hint only/);
  assert.match(card, /Large image · size only/);
  assert.match(card, /No review signal/);
  assert.match(card, /checkbox\.checked = state\.selectedForPlan\.has\(record\.id\)/);
  assert.doesNotMatch(card, /selectedForPlan\.add\(record\.id\)/);
});

test('similar candidate groups are compared together without hiding paths or choosing members', () => {
  const renderer = sourceBetween(app, 'function renderContactSheet(visible, filteredRecords)', 'function renderRows()');
  assert.match(renderer, /state\.view !== 'similar'/);
  assert.match(renderer, /const groups = new Map\(\)/);
  assert.match(renderer, /groups\.get\(record\.similarGroup\)/);
  assert.match(renderer, /matchingGroupSize > members\.length/);
  assert.match(renderer, /heuristic hint only, not proof of interchangeability/);
  assert.match(renderer, /members\.map\(makeContactCard\)/);
  assert.doesNotMatch(renderer, /selectedForPlan\.add|checkbox\.checked\s*=\s*true/);
});

test('changing presentation preserves the current filtered page and manual selection state', () => {
  const renderer = sourceBetween(app, 'function renderRows()', 'function updateCounts()');
  assert.match(renderer, /const records = baseRecords\(\)/);
  assert.match(renderer, /const visible = records\.slice\(start, start \+ PAGE_SIZE\)/);
  assert.match(renderer, /renderContactSheet\(visible, records\)/);
  assert.match(renderer, /nodes\.viewList\.setAttribute\('aria-pressed'/);
  assert.match(renderer, /nodes\.viewContactSheet\.setAttribute\('aria-pressed'/);

  const handlers = sourceBetween(app, "nodes.viewList.addEventListener('click'", "for (const item of document.querySelectorAll('[data-view]'))");
  assert.match(handlers, /state\.layout = 'list'/);
  assert.match(handlers, /state\.layout = 'contact'/);
  assert.equal((handlers.match(/renderRows\(\)/g) ?? []).length, 2);
  assert.doesNotMatch(handlers, /state\.(?:view|folder|query|sort|page|selectedForPlan)\s*=/);
});
