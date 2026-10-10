import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../site/styles.css', import.meta.url), 'utf8');

test('landing page accurately presents Guardian as local-first and honest beta', () => {
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<title>[^<]*Guardian/i);
  assert.match(html, /without sending your source code anywhere/i);
  assert.match(html, /analysis runs on your machine/i);
  assert.match(html, /CleanCode CLI not yet published to npm/i);
  assert.match(html, /GitHub App.{0,100}(?:metadata|does not run audits)/is);
  assert.match(html, /Stripe.{0,100}(?:sandbox|test mode)/is);
});

test('landing page has semantic landmarks and working destination links', () => {
  assert.match(html, /<header[\s>]/i);
  assert.match(html, /<main[\s>]/i);
  assert.match(html, /<footer[\s>]/i);
  assert.match(html, /href="https:\/\/github\.com\/HotMb\/guardian-autopilot"/);
  assert.doesNotMatch(html, /href="#"/i);
});

test('landing page does not load third-party code or collect visitor data', () => {
  assert.doesNotMatch(html, /<script\b/i);
  assert.doesNotMatch(html, /<form\b/i);
  assert.doesNotMatch(html, /(?:google-analytics|gtag\(|googletagmanager|plausible\.io|hotjar|segment\.com)/i);
  assert.doesNotMatch(css, /@import|url\(\s*['"]?https?:/i);
});

test('landing page styles support narrow screens, keyboard focus, and reduced motion', () => {
  assert.match(css, /@media\s*\(max-width:\s*\d+px\)/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
});
