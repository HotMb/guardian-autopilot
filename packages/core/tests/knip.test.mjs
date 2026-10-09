import test from 'node:test';

test('normalizes Knip JSON issues without enabling fix mode', async () => {
  const {parseKnipReport} = await import('../dist/knip.js');
  const issues = parseKnipReport({issues: [
    {file: 'src/a.ts', dependencies: [{name: 'unused-lib', line: 2, col: 3}], unlisted: ['missing-lib']},
    {file: 'src/b.ts', unresolved: [{name: './missing'}]},
  ]});

  if (JSON.stringify(issues) !== JSON.stringify([
    {file: 'src/a.ts', type: 'dependencies', name: 'unused-lib', line: 2, col: 3},
    {file: 'src/a.ts', type: 'unlisted', name: 'missing-lib'},
    {file: 'src/b.ts', type: 'unresolved', name: './missing'},
  ])) throw new Error(`Unexpected issues: ${JSON.stringify(issues)}`);
});

test('reports missing Knip as unavailable instead of failing the analysis', async () => {
  const {runKnip} = await import('../dist/knip.js');
  const result = await runKnip('.', {executable: 'definitely-not-a-real-knip'});
  if (result.status !== 'unavailable' || result.issues.length !== 0) throw new Error(`Unexpected result: ${JSON.stringify(result)}`);
});

