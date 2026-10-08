import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const DEFAULT_DEBOUNCE_MS = 5 * 60 * 1000;

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function parseHookInput(raw) {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function debounceMs() {
  const parsed = Number.parseInt(process.env.GUARDIAN_HOOK_DEBOUNCE_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_DEBOUNCE_MS;
}

function projectRoot() {
  return resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
}

function statePath(root) {
  const key = createHash('sha256').update(root).digest('hex').slice(0, 24);
  const base = process.env.GUARDIAN_HOOK_STATE_DIR || join(tmpdir(), 'guardian-autopilot');
  return join(base, `${key}.json`);
}

async function isDebounced(path, now) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    return Number.isFinite(value.lastRunAt) && now - value.lastRunAt < debounceMs();
  } catch {
    return false;
  }
}

async function markRun(path, now) {
  await mkdir(resolve(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify({ lastRunAt: now }), 'utf8');
}

function commandArgs(root) {
  const configured = process.env.GUARDIAN_COMMAND_ARGS;
  if (configured) {
    try {
      const args = JSON.parse(configured);
      if (Array.isArray(args) && args.every((arg) => typeof arg === 'string')) return [...args, root];
    } catch {
      // Fall back to the built-in read-only invocation.
    }
  }
  return ['plan', root];
}

function run(command, args, cwd) {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => resolveResult({ code: null, stdout: '', stderr: error.message }));
    child.on('close', (code) => resolveResult({
      code,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });
}

function summary(report) {
  const candidates = Array.isArray(report?.candidates) ? report.candidates.length : null;
  const scanErrors = Array.isArray(report?.scanErrors) ? report.scanErrors.length : 0;
  const referenceErrors = Array.isArray(report?.referenceErrors) ? report.referenceErrors.length : 0;
  const details = candidates === null ? 'result unreadable' : `${candidates} review candidate${candidates === 1 ? '' : 's'}`;
  const errors = scanErrors + referenceErrors;
  return `Guardian read-only plan: ${details}${errors ? `, ${errors} analysis error${errors === 1 ? '' : 's'}` : ''}. No files were changed.`;
}

async function main() {
  const input = parseHookInput(await readStdin());
  if (input.stop_hook_active === true) return;

  const root = projectRoot();
  const state = statePath(root);
  const now = Date.now();
  if (await isDebounced(state, now)) return;
  await markRun(state, now);

  const command = process.env.GUARDIAN_COMMAND || 'guardian';
  const result = await run(command, commandArgs(root), root);
  if (result.code !== 0) return;

  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    return;
  }
  process.stdout.write(JSON.stringify({ systemMessage: summary(report) }));
}

try {
  await main();
} catch {
  // Hooks must never block a session because the optional audit is unavailable.
  process.exitCode = 0;
}
