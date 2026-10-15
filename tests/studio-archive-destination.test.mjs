import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('../site/studio.html', import.meta.url), 'utf8');
const app = await readFile(new URL('../site/studio.js', import.meta.url), 'utf8');
const fileOps = await readFile(new URL('../site/studio-file-ops.js', import.meta.url), 'utf8');
const watcher = await readFile(new URL('../src/studio-watcher.ts', import.meta.url), 'utf8');

function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

test('Guardian creates a marked Corbeille only in the selected source folder', () => {
  assert.match(fileOps, /TRASH_DIRECTORY = 'Corbeille'/);
  assert.match(fileOps, /ensureGuardianTrashDirectory\(sourceRoot\)/);
  assert.match(fileOps, /if \(occupied\) fail\('archive-scope'/);
  assert.match(fileOps, /destinationRoot\.name\?\.toLowerCase\(\) !== TRASH_DIRECTORY\.toLowerCase\(\)/);
  assert.match(fileOps, /expected\.isSameEntry\(destinationRoot\)/);
  assert.match(fileOps, /isGuardianTrashDirectory\(expected\)/);
});

test('archive UI lists the exact selected paths and starts the verified Corbeille flow inline', () => {
  assert.match(html, /id="archive-selection-files"/);
  assert.match(html, /id="archive-selection-count"/);
  assert.match(html, /id="archive-selection-bytes"/);
  assert.match(html, /id="cleanup-action"[^>]*>Archive selection/);
  assert.match(html, /creates a Corbeille folder in the selected folder/i);
  assert.doesNotMatch(html, /id="archive-dialog"|id="choose-quarantine"|id="enable-source-write"/);

  const archiveFlow = sourceBetween(app, "nodes.cleanupAction.addEventListener('click'", 'const closeDialog =');
  assert.match(archiveFlow, /prepareWritableTrash\(\{createIfMissing: true\}\)/);
  assert.match(archiveFlow, /JSON\.stringify\(currentIds\) !== JSON\.stringify\(selectedIds\)/);
  assert.match(archiveFlow, /await assertGuardianTrashDestination/);
  assert.match(archiveFlow, /quarantineFiles\(\{sourceRoot, destinationRoot: prepared\.destinationRoot, records, confirmed: true/);
  assert.match(archiveFlow, /runFileOperation\(null/);
});

test('permanent deletion is an inline exact-path review with one explicit checkbox', () => {
  assert.match(html, /id="purge-files"/);
  assert.match(html, /id="purge-count"/);
  assert.match(html, /id="purge-bytes"/);
  assert.match(html, /id="purge-understood" type="checkbox"/);
  assert.match(html, /id="purge-selected"[^>]*>Delete permanently/);
  assert.doesNotMatch(html, /id="purge-dialog"|Type <code>PURGE<\/code>/);
  assert.doesNotMatch(app, /typedConfirmation|purgePhrase|purgeDialog/);
  assert.match(app, /startGuardianTrashOperation\(ids, null/);
  assert.match(app, /purgeQuarantined\(\{destinationRoot, ids, confirmed: true/);
  assert.match(fileOps, /if \(!confirmed\) fail\('confirmation'/);
  assert.match(fileOps, /isGuardianTrashDirectory\(destinationRoot\)/);
});

test('browser scans and the optional watcher exclude Corbeille', () => {
  assert.match(app, /handle\.name\.toLowerCase\(\) === TRASH_DIRECTORY\.toLowerCase\(\) && await isGuardianTrashDirectory\(handle\)/);
  assert.match(app, /root\.name\.toLowerCase\(\) === TRASH_DIRECTORY\.toLowerCase\(\)/);
  assert.match(watcher, /'corbeille'/);
});

test('the retained local archive is still restorable and separate recovery dialogs remain explicit', () => {
  assert.match(html, /id="restore-dialog"/);
  assert.match(html, /id="resume-dialog"/);
  assert.match(app, /startGuardianTrashOperation\(ids, nodes\.restoreDialog/);
  assert.match(app, /startGuardianTrashOperation\(ids, nodes\.resumeDialog/);
  assert.match(fileOps, /Restore only into the selected source folder|export async function restoreQuarantined/);
});
