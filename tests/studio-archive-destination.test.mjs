import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {assertArchiveDestinationOutsideSource} from '../site/studio-file-ops.js';

const html = await readFile(new URL('../site/studio.html', import.meta.url), 'utf8');
const app = await readFile(new URL('../site/studio.js', import.meta.url), 'utf8');

function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

function directory(name, children = [], {identity = true, iterationError = null} = {}) {
  const handle = {kind: 'directory', name};
  if (identity) handle.isSameEntry = async (other) => other?.identity === name;
  handle.identity = name;
  handle.values = async function* values() {
    for (const child of children) yield child;
    if (iterationError) throw iterationError;
  };
  return handle;
}

test('the engine rejects the source directory itself and any descendant as an archive destination', async () => {
  const same = directory('same');
  await assert.rejects(assertArchiveDestinationOutsideSource(same, same), /outside the selected source folder/);

  const destination = directory('nested');
  const source = directory('source', [directory('nested')]);
  await assert.rejects(assertArchiveDestinationOutsideSource(source, destination), /outside the selected source folder/);
});

test('the engine refuses archive selection when directory identity or full traversal cannot be verified', async () => {
  const destination = directory('outside');
  const sourceWithoutIdentity = directory('source', [], {identity: false});
  await assert.rejects(assertArchiveDestinationOutsideSource(sourceWithoutIdentity, destination), /cannot verify archive-folder separation/);

  const childWithoutIdentity = directory('child', [], {identity: false});
  const sourceWithUnknownChild = directory('source', [childWithoutIdentity]);
  await assert.rejects(assertArchiveDestinationOutsideSource(sourceWithUnknownChild, destination), /cannot verify archive-folder separation/);

  const unreadableSource = directory('source', [], {iterationError: new Error('permission denied')});
  await assert.rejects(assertArchiveDestinationOutsideSource(unreadableSource, destination), /complete source tree/);
});

test('the engine refuses archive selection when source traversal reaches its entry bound', async () => {
  const source = directory('source');
  source.values = async function* values() {
    for (let index = 0; index < 250_001; index += 1) yield {kind: 'file'};
  };
  await assert.rejects(assertArchiveDestinationOutsideSource(source, directory('outside')), /exceeded 250000 entries/);
});

test('archive selection fails closed unless the destination is outside the source tree', () => {
  assert.match(app, /import \{assertArchiveDestinationOutsideSource,/);
  const picker = sourceBetween(app, "nodes.chooseQuarantine.addEventListener('click'", "nodes.cleanupAction.addEventListener('click'");
  assert.match(picker, /await assertArchiveDestinationOutsideSource\(state\.sourceRoot, selected\)/);
  assert.ok(picker.indexOf('await assertArchiveDestinationOutsideSource') < picker.indexOf('state.archiveRoot = selected'));
  assert.match(picker, /state\.archiveRoot = null/);
  assert.match(picker, /Guardian could not verify that this archive folder is outside the source folder/);
});

test('Studio rechecks the destination before review and immediately before archiving', () => {
  const review = sourceBetween(app, "nodes.cleanupAction.addEventListener('click'", 'const closeDialog =');
  assert.match(review, /await assertArchiveDestinationOutsideSource\(state\.sourceRoot, state\.archiveRoot\)/);
  assert.match(review, /catch \{[\s\S]*?state\.archiveRoot = null[\s\S]*?archive is disabled/);

  const confirm = sourceBetween(app, "nodes.archiveDialogConfirm.addEventListener('click'", "nodes.archivePrevious.addEventListener('click'");
  assert.match(confirm, /await assertArchiveDestinationOutsideSource\(sourceRoot, destinationRoot\)/);
  assert.match(confirm, /state\.sourceRoot !== sourceRoot \|\| state\.archiveRoot !== destinationRoot/);
  assert.match(confirm, /void runFileOperation[\s\S]*?await assertArchiveDestinationOutsideSource\(sourceRoot, destinationRoot\)[\s\S]*?quarantineFiles\(\{sourceRoot, destinationRoot/);
});

test('archive review explains storage without claiming Guardian verified a separate volume', () => {
  const archiveDialog = sourceBetween(html, '<dialog id="archive-dialog"', '<dialog id="restore-dialog"');
  assert.match(archiveDialog, /id="archive-storage-confirm"/);
  assert.match(archiveDialog, /archive copies continue to use storage/i);
  assert.match(archiveDialog, /cannot verify whether this folder is on a different volume/i);
  assert.match(archiveDialog, /same volume, archiving does not recover device space/i);
  assert.match(archiveDialog, /permanently purged/i);
  assert.doesNotMatch(archiveDialog, /confirm[^<]*different storage volume/i);
  assert.doesNotMatch(app, /externalVolumeConfirm|separateVolume/);

  const dialogSetup = sourceBetween(app, 'function fillArchiveDialog()', 'function refreshArchiveJournal()');
  assert.match(dialogSetup, /nodes\.archiveStorageConfirm\.checked = false/);
  const confirmation = sourceBetween(app, 'const updateArchiveConfirmation =', 'nodes.archivePrevious.addEventListener');
  assert.match(confirmation, /!nodes\.archiveStorageConfirm\.checked/);
  assert.match(confirmation, /nodes\.archiveStorageConfirm\.addEventListener\('change', updateArchiveConfirmation\)/);
  assert.match(confirmation, /Guardian cannot verify the storage volume/i);
  assert.match(confirmation, /on the same volume, source space is not recovered until the archive copies are permanently purged/i);
});

test('reconciling an interrupted archive requires confirmation of the original source folder', () => {
  const resumeDialog = sourceBetween(html, '<dialog id="resume-dialog"', '<dialog id="purge-dialog"');
  assert.match(resumeDialog, /id="resume-source-confirm"/);
  assert.match(resumeDialog, /selected source folder is the original folder/i);

  const resumeFlow = sourceBetween(app, "nodes.resumeVerified.addEventListener('click'", "nodes.restoreSelected.addEventListener('click'");
  assert.match(resumeFlow, /nodes\.resumeSourceConfirm\.checked = false/);
  assert.match(resumeFlow, /nodes\.resumeDialogConfirm\.disabled = true/);
  assert.match(resumeFlow, /nodes\.resumeSourceConfirm\.addEventListener\('change'/);
  assert.match(resumeFlow, /if \(!nodes\.resumeSourceConfirm\.checked\) return/);
  assert.match(resumeFlow, /reconcileVerifiedQuarantine\(\{[\s\S]*?sourceRootConfirmed: true/);
});
