import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

test('Studio explains the local review flow and keeps optional monitoring out of the main task', async () => {
  const html = await readFile(new URL('../site/studio.html', import.meta.url), 'utf8');

  assert.match(html, /<a class="studio-skip" href="#studio-main">Skip to files<\/a>/);
  assert.match(html, /<main class="studio-main" id="studio-main" tabindex="-1">/);
  assert.match(html, /<h1>See what is filling your image library\.<\/h1>/);
  assert.match(html, /Scan a folder on your computer\. Review exact duplicates, visual suggestions, and large images\. You decide what to archive\./);
  assert.match(html, /SOURCE BYTES REMOVED/);
  assert.match(html, /No archive operation yet; device space is not measured/);
  assert.match(html, /<div><dt>Selected file size<\/dt><dd id="plan-estimate">/);
  assert.match(html, /<details class="studio-scan-disclosure">\s*<summary>What the scan checks<\/summary>/);
  assert.match(html, /<details class="studio-watch-panel">\s*<summary class="studio-watch-heading">/);
  assert.match(html, /id="watch-state"/);
  assert.match(html, /id="watch-summary" role="status" aria-live="polite"/);
  assert.match(html, /No files are chosen automatically/);
  assert.match(html, /Allow source write access/);
  assert.match(html, /Review archive selection/);
});

test('Studio keeps keyboard focus, touch targets, narrow layouts, and reduced motion in its visual contract', async () => {
  const css = await readFile(new URL('../site/studio.css', import.meta.url), 'utf8');

  assert.match(css, /\.studio-body :focus-visible\s*\{\s*outline:\s*3px solid/s);
  assert.match(css, /\.studio-folder-button,\s*\.studio-button\s*\{\s*min-height:\s*46px/s);
  assert.match(css, /\.studio-nav-item\s*\{\s*min-height:\s*46px/s);
  assert.match(css, /\.studio-review-check\s*\{\s*width:\s*24px/s);
  assert.match(css, /\.studio-preview-frame img\s*\{\s*object-fit:\s*contain/s);
  assert.match(css, /@media \(min-width: 1181px\) and \(max-width: 1450px\)/);
  assert.match(css, /@media \(max-width: 960px\)/);
  assert.match(css, /@media \(max-width: 560px\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /@media \(forced-colors: active\)/);
});