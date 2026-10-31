import assert from 'node:assert/strict';
import test from 'node:test';
import {findArchitectureViolations} from '../scripts/verify-architecture.mjs';

function validArchitecture() {
  return {
    rootPackage: {
      workspaces: ['packages/*'],
      bin: {guardian: './dist/cli.js'},
      scripts: {
        'verify:architecture': 'node scripts/verify-architecture.mjs',
        test: 'npm test --prefix packages/cli && npm run verify:architecture',
      },
    },
    workspacePackages: [
      {name: '@cleancode/shared', dependencies: {}},
      {name: '@cleancode/license', dependencies: {}},
      {name: '@cleancode/core', dependencies: {'@cleancode/shared': '^0.1.0'}},
      {name: '@cleancode/cli', bin: {cleancode: './dist/index.js'}, dependencies: {
        '@cleancode/core': '^0.1.0',
        '@cleancode/license': '^0.1.0',
        '@cleancode/shared': '^0.1.0',
      }},
    ],
  };
}

test('accepts the documented Guardian workspace boundaries', () => {
  const {rootPackage, workspacePackages} = validArchitecture();
  assert.deepEqual(findArchitectureViolations(rootPackage, workspacePackages), []);
});

test('rejects dependency edges that invert the CleanCode layers', () => {
  const {rootPackage, workspacePackages} = validArchitecture();
  workspacePackages.find((item) => item.name === '@cleancode/core').dependencies['@cleancode/cli'] = '^0.1.0';

  const violations = findArchitectureViolations(rootPackage, workspacePackages).join('\n');
  assert.ok(violations.includes('@cleancode/core internal dependencies'));
});

test('requires the architecture check to remain wired into npm test', () => {
  const {rootPackage, workspacePackages} = validArchitecture();
  rootPackage.scripts.test = 'npm test --prefix packages/cli';

  const violations = findArchitectureViolations(rootPackage, workspacePackages).join('\n');
  assert.ok(violations.includes('root test command must run verify:architecture'));
});

test('rejects missing or unregistered workspace packages', () => {
  const {rootPackage, workspacePackages} = validArchitecture();
  workspacePackages.pop();
  workspacePackages.push({name: '@cleancode/backend', dependencies: {}});

  const violations = findArchitectureViolations(rootPackage, workspacePackages).join('\n');
  assert.ok(violations.includes('Required workspace package is missing: @cleancode/cli'));
  assert.ok(violations.includes('not registered in the architecture contract: @cleancode/backend'));
});
