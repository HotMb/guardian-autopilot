import {existsSync, readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readJson(path) {
  return JSON.parse(readFileSync(resolve(projectRoot, path), 'utf8'));
}

function requireFile(path) {
  if (!existsSync(resolve(projectRoot, path))) {
    throw new Error(`Required package file is missing: ${path}`);
  }
}

const packageJson = readJson('package.json');
const pluginManifest = readJson('integrations/claude-plugin/.claude-plugin/plugin.json');
const mcpConfig = readJson('integrations/claude-plugin/.mcp.json');

if (packageJson.bin?.guardian !== './dist/cli.js') {
  throw new Error('package.json must expose dist/cli.js as the guardian binary');
}
if (packageJson.scripts?.prepack !== 'npm run build') {
  throw new Error('package.json must build before packing');
}
if (!Array.isArray(packageJson.files) || !packageJson.files.includes('dist') || !packageJson.files.includes('integrations/claude-plugin')) {
  throw new Error('package.json files must include dist and integrations/claude-plugin');
}
if (pluginManifest.name !== packageJson.name || pluginManifest.version !== packageJson.version) {
  throw new Error('Claude plugin metadata must match package metadata');
}
if (mcpConfig.mcpServers?.guardian?.command !== 'guardian' || JSON.stringify(mcpConfig.mcpServers.guardian.args) !== JSON.stringify(['mcp'])) {
  throw new Error('Claude plugin must expose guardian mcp as its read-only MCP server');
}

for (const path of [
  'dist/cli.js',
  'integrations/claude-plugin/.claude-plugin/plugin.json',
  'integrations/claude-plugin/.mcp.json',
  'integrations/claude-plugin/hooks/hooks.json',
  'integrations/claude-plugin/scripts/post-task.mjs',
  'integrations/claude-plugin/skills/audit/SKILL.md',
]) {
  requireFile(path);
}

const help = spawnSync(process.execPath, [resolve(projectRoot, 'dist/cli.js'), '--help'], {
  cwd: projectRoot,
  encoding: 'utf8',
  windowsHide: true,
});
if (help.status !== 0 || !help.stdout.includes('guardian mcp')) {
  throw new Error('Built Guardian CLI did not pass its read-only help smoke test');
}

console.log('Package verification passed: CLI, metadata, plugin, and MCP entry point are present.');
