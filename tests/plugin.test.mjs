import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const pluginRoot = new URL('../integrations/claude-plugin/', import.meta.url);

async function json(relativePath) {
  const text = await readFile(new URL(relativePath, pluginRoot), 'utf8');
  return JSON.parse(text);
}

test('Claude Code plugin has the documented manifest and hook layout', async () => {
  const manifest = await json('.claude-plugin/plugin.json');
  const hooks = await json('hooks/hooks.json');

  assert.equal(manifest.name, 'guardian-autopilot');
  assert.equal(typeof manifest.description, 'string');
  assert.equal(manifest.version, '0.1.0');
  assert.ok(Array.isArray(hooks.hooks.Stop));
  assert.equal(hooks.hooks.Stop[0].hooks[0].type, 'command');
  assert.equal(hooks.hooks.Stop[0].hooks[0].command, 'node');
  assert.deepEqual(hooks.hooks.Stop[0].hooks[0].args, ['${CLAUDE_PLUGIN_ROOT}/scripts/post-task.mjs']);
  assert.equal(hooks.hooks.Stop[0].hooks[0].timeout, 30);
});

test('Claude Code plugin exposes an explicit read-only audit skill', async () => {
  const skill = await readFile(new URL('skills/audit/SKILL.md', pluginRoot), 'utf8');
  assert.match(skill, /disable-model-invocation: true/);
  assert.match(skill, /read-only/i);
  assert.match(skill, /Do not delete, rename, rewrite, or stage files/);
});

test('Claude Code plugin declares the read-only Guardian MCP server', async () => {
  const mcp = await json('.mcp.json');
  assert.equal(mcp.mcpServers.guardian.command, 'guardian');
  assert.deepEqual(mcp.mcpServers.guardian.args, ['mcp']);
  assert.equal(mcp.mcpServers.guardian.env.GUARDIAN_MCP_ROOT, '${CLAUDE_PROJECT_DIR}');
});
