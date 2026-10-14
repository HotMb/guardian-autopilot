import {parsePngGenerationMetadata} from './studio-metadata.js';
import {buildReviewPlan, collectImageInventory, findExactDuplicateGroups} from './studio-scan.js';
import {findVisualSimilarityGroups} from './studio-similarity.js';
import {assertArchiveDestinationOutsideSource, loadQuarantine, purgeQuarantined, quarantineErrorMessage, quarantineFiles, reconcileVerifiedQuarantine, restoreQuarantined, isProtectedQuarantineDirectory, QUARANTINE_DIRECTORY} from './studio-file-ops.js';

(() => {
  const LARGE_IMAGE_BYTES = 10 * 1024 * 1024;
  const MAX_HASH_BYTES = 64 * 1024 * 1024;
  const MAX_METADATA_BYTES = 1024 * 1024;
  const MAX_SCAN_FILES = 10_000;
  const PAGE_SIZE = 40;
  const demoFiles = [
    {id: 'demo-cabin-a', name: 'cabin-final.png', path: 'exports/cabin-final.png', folder: 'exports', bytes: 12_840_112, type: 'PNG', src: '/studio-demo/demo-cabin.png', duplicateGroup: 'demo-cabin-match', similarGroup: 'demo-cabin-visual', metadataFields: [{key: 'parameters', producer: 'Stable Diffusion WebUI', encoding: 'Synthetic', value: 'A small cedar cabin in a quiet forest clearing, warm late-afternoon light\nNegative prompt: blurry, low detail\nSteps: 28, Sampler: DPM++ 2M, Seed: 428173'}]},
    {id: 'demo-cabin-b', name: 'cabin-final-copy.png', path: 'archive/old/cabin-final-copy.png', folder: 'archive/old', bytes: 12_840_112, type: 'PNG', src: '/studio-demo/demo-cabin.png', duplicateGroup: 'demo-cabin-match', metadataFields: [{key: 'parameters', producer: 'Stable Diffusion WebUI', encoding: 'Synthetic', value: 'A small cedar cabin in a quiet forest clearing, warm late-afternoon light\nNegative prompt: blurry, low detail\nSteps: 28, Sampler: DPM++ 2M, Seed: 428173'}]},
    {id: 'demo-observatory', name: 'observatory-study.png', path: 'concepts/observatory-study.png', folder: 'concepts', bytes: 9_624_680, type: 'PNG', src: '/studio-demo/demo-observatory.png', metadataFields: []},
    {id: 'demo-explorer', name: 'field-notes-04.png', path: 'concepts/field-notes-04.png', folder: 'concepts', bytes: 8_902_401, type: 'PNG', src: '/studio-demo/demo-explorer.png', metadata: 'not-checked'},
    {id: 'demo-cabin-webp', name: 'cabin-social.webp', path: 'exports/social/cabin-social.webp', folder: 'exports/social', bytes: 7_412_208, type: 'WEBP', src: '/studio-demo/demo-cabin.png', similarGroup: 'demo-cabin-visual'},
    {id: 'demo-observatory-copy', name: 'observatory-v1.png', path: 'archive/old/observatory-v1.png', folder: 'archive/old', bytes: 6_320_410, type: 'PNG', src: '/studio-demo/demo-observatory.png', duplicateGroup: 'demo-observatory-match', metadataFields: [{key: 'prompt', producer: 'ComfyUI', encoding: 'Synthetic', value: '{\n  "4": { "class_type": "CLIPTextEncode", "inputs": { "text": "A fictional observatory beneath a clear night sky" } }\n}'}, {key: 'workflow', producer: 'ComfyUI', encoding: 'Synthetic', value: '{\n  "nodes": [\n    { "id": 1, "type": "CheckpointLoaderSimple" },\n    { "id": 2, "type": "CLIPTextEncode" },\n    { "id": 3, "type": "KSampler" },\n    { "id": 4, "type": "SaveImage" }\n  ]\n}'}]},
    {id: 'demo-observatory-copy-2', name: 'observatory-v1-backup.png', path: 'archive/backup/observatory-v1-backup.png', folder: 'archive/backup', bytes: 6_320_410, type: 'PNG', src: '/studio-demo/demo-observatory.png', duplicateGroup: 'demo-observatory-match', metadataFields: [{key: 'prompt', producer: 'ComfyUI', encoding: 'Synthetic', value: '{\n  "4": { "class_type": "CLIPTextEncode", "inputs": { "text": "A fictional observatory beneath a clear night sky" } }\n}'}, {key: 'workflow', producer: 'ComfyUI', encoding: 'Synthetic', value: '{\n  "nodes": [\n    { "id": 1, "type": "CheckpointLoaderSimple" },\n    { "id": 2, "type": "CLIPTextEncode" },\n    { "id": 3, "type": "KSampler" },\n    { "id": 4, "type": "SaveImage" }\n  ]\n}'}]},
    {id: 'demo-explorer-jpg', name: 'explorer-contact.jpg', path: 'exports/contacts/explorer-contact.jpg', folder: 'exports/contacts', bytes: 3_804_774, type: 'JPEG', src: '/studio-demo/demo-explorer.png', metadata: 'not-checked'},
    {id: 'demo-cabin-thumb', name: 'cabin-reference.png', path: 'references/cabin-reference.png', folder: 'references', bytes: 1_240_000, type: 'PNG', src: '/studio-demo/demo-cabin.png', metadata: 'not-found'},
    {id: 'demo-study', name: 'composition-study.webp', path: 'concepts/composition-study.webp', folder: 'concepts', bytes: 840_218, type: 'WEBP', src: '/studio-demo/demo-observatory.png'},
  ];

  const state = {
    records: demoFiles.map((record) => ({...record, isDemo: true})),
    totalImageCount: demoFiles.length,
    totalImageBytes: demoFiles.reduce((sum, record) => sum + record.bytes, 0),
    indexedImageCount: demoFiles.length,
    inventoryComplete: true,
    unreadableFiles: 0,
    view: 'all',
    layout: 'list',
    folder: null,
    query: '',
    sort: 'name',
    direction: 'ascending',
    selectedFile: 'demo-cabin-a',
    selectedForPlan: new Set(),
    page: 0,
    plan: null,
    scanning: false,
    partial: false,
    visualPartial: false,
    scanToken: 0,
    scanStats: null,
    visualStats: null,
    objectUrls: new Map(),
    metadataCache: new Map(),
    worker: null,
    cancelRequested: false,
    sourceRoot: null,
    sourceWriteGranted: false,
    archiveRoot: null,
    archiveWriteGranted: false,
    archiveEntries: [],
    selectedArchiveIds: new Set(),
    archivePage: 0,
    operationController: null,
    operationBusy: false,
    sourceBytesRemoved: null,
  };

  const $ = (id) => document.getElementById(id);
  const nodes = {
    folderInput: $('folder-input'), chooseFolder: $('choose-folder'), folderFallback: $('folder-fallback'), folderCapability: $('folder-capability'), folderStatus: $('folder-status'),
    scopeCopy: $('scope-copy'), scanState: $('scan-state'), demoLabel: $('demo-label'),
    rows: $('file-rows'), tableScroll: $('table-scroll'), contactSheet: $('contact-sheet'), viewList: $('view-list'), viewContactSheet: $('view-contact-sheet'), folders: $('folder-list'), folderTotal: $('folder-total'),
    totalAssets: $('total-assets'), assetCaption: $('asset-caption'), imageBytes: $('images-size'), storageCaption: $('storage-caption'), duplicateCount: $('duplicate-count'), spaceFreedTotal: $('space-freed-total'), sourceBytesCaption: $('source-bytes-caption'),
    duplicateMethod: $('duplicate-method'),
    allCount: $('count-all'), duplicateViewCount: $('count-duplicates'), similarViewCount: $('count-similar'), largeCount: $('count-large'), planCount: $('count-plan'),
    search: $('file-search'), clearSearch: $('clear-search'), range: $('range-copy'), subtitle: $('list-subtitle'),
    empty: $('empty-state'), resetView: $('reset-view'), previousPage: $('previous-page'), nextPage: $('next-page'), pageCopy: $('page-copy'),
    progress: $('scan-progress'), progressTrack: $('progress-track'), progressFill: $('progress-fill'), progressCopy: $('progress-copy'), cancel: $('cancel-scan'),
    preview: $('preview-image'), previewFrame: $('preview-frame'), previewUnavailable: $('preview-unavailable'), index: $('inspector-index'), badges: $('detail-badges'),
    name: $('inspector-heading'), path: $('detail-path'), size: $('detail-size'), type: $('detail-type'), folder: $('detail-folder'), metadata: $('detail-metadata'), metadataContent: $('metadata-content'),
    planEstimate: $('plan-estimate'), spaceFreed: $('space-freed'), planExplainer: $('plan-explainer'), createPlan: $('create-plan'), cleanupAction: $('cleanup-action'), cleanupLimitation: $('cleanup-limitation'), planResult: $('review-plan'),
    enableSourceWrite: $('enable-source-write'), chooseQuarantine: $('choose-quarantine'), archiveStatus: $('archive-operation-status'), archiveProgress: $('archive-operation-progress'), fileOpTrack: $('file-op-progress'), fileOpProgressFill: $('file-op-progress-fill'), fileOpProgressCopy: $('file-op-progress-copy'), cancelFileOperation: $('cancel-file-operation'),
    archiveJournalCopy: $('archive-journal-copy'), archiveEntryList: $('archive-entry-list'), archivePagination: $('archive-pagination'), archivePrevious: $('archive-previous'), archiveNext: $('archive-next'), archivePageCopy: $('archive-page-copy'), resumeVerified: $('resume-verified'), restoreSelected: $('restore-selected'), purgeSelected: $('purge-selected'),
    archiveDialog: $('archive-dialog'), archiveDialogClose: $('archive-dialog-close'), archiveDialogCancel: $('archive-dialog-cancel'), archiveDialogConfirm: $('archive-dialog-confirm'), archiveDialogCount: $('archive-dialog-count'), archiveDialogBytes: $('archive-dialog-bytes'), archiveDialogFiles: $('archive-dialog-files'), archiveReason: $('archive-reason'), archiveStorageConfirm: $('archive-storage-confirm'),
    restoreDialog: $('restore-dialog'), restoreDialogClose: $('restore-dialog-close'), restoreDialogCancel: $('restore-dialog-cancel'), restoreDialogConfirm: $('restore-dialog-confirm'), restoreDialogFiles: $('restore-dialog-files'), restoreSourceConfirm: $('restore-source-confirm'),
    resumeDialog: $('resume-dialog'), resumeDialogClose: $('resume-dialog-close'), resumeDialogCancel: $('resume-dialog-cancel'), resumeDialogConfirm: $('resume-dialog-confirm'), resumeDialogFiles: $('resume-dialog-files'), resumeSourceConfirm: $('resume-source-confirm'),
    purgeDialog: $('purge-dialog'), purgeDialogClose: $('purge-dialog-close'), purgeDialogCancel: $('purge-dialog-cancel'), purgeDialogConfirm: $('purge-dialog-confirm'), purgeDialogCount: $('purge-dialog-count'), purgeDialogBytes: $('purge-dialog-bytes'), purgeDialogFiles: $('purge-dialog-files'), purgeUnderstood: $('purge-understood'), purgePhrase: $('purge-phrase'),
    notice: $('studio-notice'),
    watchState: $('watch-state'), watchSummary: $('watch-summary'), watchCounts: $('watch-counts'), watchNewCount: $('watch-new-count'), watchLargeCount: $('watch-large-count'), watchPendingCount: $('watch-pending-count'), watchCandidates: $('watch-candidates'), watchEmpty: $('watch-empty'), watchChecked: $('watch-checked'), watchRefresh: $('watch-refresh'),
  };

  function formatBytes(value) {
    if (!Number.isFinite(value) || value <= 0) return '0 B';
    if (value < 1000) return `${Math.round(value)} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let amount = value / 1000;
    let unit = 0;
    while (amount >= 1000 && unit < units.length - 1) { amount /= 1000; unit += 1; }
    return `${new Intl.NumberFormat('en', {maximumFractionDigits: amount >= 100 ? 0 : 1}).format(amount)} ${units[unit]}`;
  }

  function setNotice(message, tone = 'info') {
    nodes.notice.textContent = message;
    nodes.notice.classList.toggle('is-error', tone === 'error');
    nodes.notice.hidden = message === '';
  }

  let watchTimer = null;
  let watchFailures = 0;
  let watchRequest = false;
  let watchQueued = false;
  let watchController = null;
  let lastWatchSummary = '';

  function setWatchSummary(message) {
    if (lastWatchSummary === message) return;
    lastWatchSummary = message;
    nodes.watchSummary.textContent = message;
  }

  function renderWatchStatus(data) {
    nodes.watchCandidates.replaceChildren();
    nodes.watchState.classList.remove('is-active', 'is-error');
    nodes.watchCounts.hidden = data.enabled !== true;

    if (data.enabled !== true) {
      nodes.watchState.textContent = 'Off';
      setWatchSummary('No folder is being watched by the local Guardian process.');
      nodes.watchChecked.textContent = 'Status checked just now';
      nodes.watchEmpty.hidden = false;
      const command = document.createElement('code');
      command.textContent = 'guardian studio --watch <image-folder>';
      nodes.watchEmpty.replaceChildren(
        document.createTextNode('Start Guardian Studio with '),
        command,
        document.createTextNode(' to monitor one local folder. The folder is scanned locally and nothing is changed.'),
      );
      return;
    }

    const candidates = Array.isArray(data.candidates) ? data.candidates.slice(0, 100) : [];
    const modeLabel = data.mode === 'watching' ? 'Watching locally' : 'Polling folder';
    nodes.watchState.textContent = modeLabel;
    nodes.watchState.classList.add('is-active');
    nodes.watchCounts.hidden = false;
    nodes.watchNewCount.textContent = Number.isSafeInteger(data.newCount) ? data.newCount.toLocaleString('en') : '—';
    nodes.watchLargeCount.textContent = Number.isSafeInteger(data.largeCount) ? data.largeCount.toLocaleString('en') : '—';
    nodes.watchPendingCount.textContent = Number.isSafeInteger(data.pendingCount) ? data.pendingCount.toLocaleString('en') : '—';

    const folder = typeof data.folder === 'string' && data.folder !== '' ? data.folder : 'selected folder';
    if (state.sourceRoot === null && state.records.some((record) => record.isDemo === true)) {
      nodes.folderStatus.textContent = 'Image table is synthetic · watcher reads names, sizes, and times from ' + folder + ' locally.';
    }
    const imageCount = Number.isSafeInteger(data.imageCount) ? data.imageCount.toLocaleString('en') : '—';
    let summary = 'Monitoring ' + folder + ' locally · ' + imageCount + ' image files indexed.';
    if (data.truncated === true) summary += ' The review list is capped at 100 files.';
    if (typeof data.notice === 'string' && data.notice !== '') summary += ' ' + data.notice;
    else if (data.partial === true) summary += ' Coverage is partial.';
    setWatchSummary(summary);

    if (typeof data.scannedAt === 'string' && Number.isFinite(Date.parse(data.scannedAt))) {
      nodes.watchChecked.textContent = 'Last checked ' + new Date(data.scannedAt).toLocaleTimeString();
    } else {
      nodes.watchChecked.textContent = 'Initial scan in progress';
    }

    for (const candidate of candidates) {
      if (!candidate || typeof candidate.path !== 'string' || !Number.isSafeInteger(candidate.bytes) || candidate.bytes < 0) continue;
      const row = document.createElement('li');
      row.className = 'studio-watch-row';
      const copy = document.createElement('div');
      copy.className = 'studio-watch-file';
      const path = document.createElement('span');
      path.className = 'studio-watch-path';
      path.textContent = candidate.path;
      const tags = document.createElement('span');
      tags.className = 'studio-watch-tags';
      if (candidate.isNew === true) {
        const tag = document.createElement('span');
        tag.className = 'studio-watch-tag is-new';
        tag.textContent = 'New this session';
        tags.append(tag);
      }
      if (candidate.isLarge === true) {
        const tag = document.createElement('span');
        tag.className = 'studio-watch-tag';
        tag.textContent = 'Large image';
        tags.append(tag);
      }
      if (candidate.isNew === true && candidate.stable !== true) {
        const tag = document.createElement('span');
        tag.className = 'studio-watch-tag is-pending';
        tag.textContent = 'Waiting for a stable size';
        tags.append(tag);
      }
      copy.append(path, tags);
      const size = document.createElement('span');
      size.className = 'studio-watch-size';
      size.textContent = formatBytes(candidate.bytes);
      row.append(copy, size);
      nodes.watchCandidates.append(row);
    }

    nodes.watchEmpty.hidden = candidates.length > 0;
    if (candidates.length === 0) {
      nodes.watchEmpty.textContent = data.candidateCount > 0
        ? 'Candidates are outside the displayed review limit. Narrow the watched folder or check again after the next refresh.'
        : 'No new or large images are waiting for review.';
    }
  }

  function scheduleWatchRefresh(delay = 5000) {
    if (watchTimer !== null) window.clearTimeout(watchTimer);
    if (document.hidden) delay = Math.max(delay, 15000);
    watchTimer = window.setTimeout(() => {
      watchTimer = null;
      void refreshWatchStatus();
    }, delay);
  }

  async function refreshWatchStatus() {
    if (watchRequest) {
      watchQueued = true;
      return;
    }
    watchRequest = true;
    watchController = new AbortController();
    const timeout = window.setTimeout(() => watchController?.abort(), 7000);
    try {
      const response = await fetch('/api/watch/status', {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        signal: watchController.signal,
      });
      if (!response.ok) throw new Error('Watcher status request failed');
      const data = await response.json();
      if (!data || typeof data !== 'object' || (data.enabled !== true && data.enabled !== false)) throw new Error('Watcher status response was invalid');
      if (data.enabled === true && !Array.isArray(data.candidates)) throw new Error('Watcher candidate list was invalid');
      renderWatchStatus(data);
      watchFailures = 0;
      scheduleWatchRefresh(data.enabled === true ? 5000 : 15000);
    } catch {
      watchFailures += 1;
      nodes.watchState.textContent = 'Status unavailable';
      nodes.watchState.classList.remove('is-active');
      nodes.watchState.classList.add('is-error');
      setWatchSummary('Studio could not refresh local watch status. The watcher may still be running; retry when the local server is available.');
      nodes.watchChecked.textContent = 'Refresh failed';
      scheduleWatchRefresh(Math.min(30000, 5000 * Math.pow(2, Math.min(watchFailures - 1, 3))));
    } finally {
      window.clearTimeout(timeout);
      watchController = null;
      watchRequest = false;
      if (watchQueued) {
        watchQueued = false;
        scheduleWatchRefresh(0);
      }
    }
  }

  function folderName(path) {
    const parts = path.split('/').filter(Boolean);
    return parts.length > 1 ? parts.slice(0, -1).join('/') : 'Root';
  }

  function previewUrl(record) {
    if (record.src) return record.src;
    if (!record.file || record.type === 'SVG') return '';
    let url = state.objectUrls.get(record.id);
    if (!url) {
      url = URL.createObjectURL(record.file);
      state.objectUrls.set(record.id, url);
    }
    return url;
  }

  function clearObjectUrls() {
    for (const url of state.objectUrls.values()) URL.revokeObjectURL(url);
    state.objectUrls.clear();
  }

  function retainVisibleObjectUrls(visibleRecords) {
    const needed = new Set(visibleRecords.map((record) => record.id));
    if (state.selectedFile) needed.add(state.selectedFile);
    for (const [id, url] of state.objectUrls) {
      if (!needed.has(id)) {
        URL.revokeObjectURL(url);
        state.objectUrls.delete(id);
      }
    }
  }

  function baseRecords() {
    let records = state.records;
    if (state.view === 'duplicates') records = records.filter((record) => record.duplicateGroup);
    if (state.view === 'similar') records = records.filter((record) => record.similarGroup);
    if (state.view === 'large') records = records.filter((record) => record.bytes >= LARGE_IMAGE_BYTES);
    if (state.view === 'plan') records = records.filter((record) => state.selectedForPlan.has(record.id));
    if (state.folder) records = records.filter((record) => record.folder === state.folder);
    if (state.query) {
      const query = state.query.toLocaleLowerCase();
      records = records.filter((record) => `${record.name} ${record.path}`.toLocaleLowerCase().includes(query));
    }
    return [...records].sort((a, b) => {
      let comparison = 0;
      if (state.sort === 'bytes') comparison = a.bytes - b.bytes;
      else if (state.sort === 'folder') comparison = a.folder.localeCompare(b.folder) || a.name.localeCompare(b.name);
      else comparison = a.name.localeCompare(b.name);
      return state.direction === 'ascending' ? comparison : -comparison;
    });
  }

  function button(label, className, callback) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = className;
    item.textContent = label;
    item.addEventListener('click', callback);
    return item;
  }

  function makeThumb(record) {
    const image = document.createElement('img');
    image.className = 'studio-thumb';
    const url = previewUrl(record);
    if (url) image.src = url;
    image.alt = '';
    image.width = 47;
    image.height = 44;
    image.loading = 'lazy';
    image.decoding = 'async';
    return image;
  }

  function fileButton(record) {
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'studio-file-open';
    open.dataset.fileId = record.id;
    open.setAttribute('aria-pressed', String(state.selectedFile === record.id));
    open.setAttribute('aria-label', `Inspect ${record.path}`);
    open.append(makeThumb(record));
    const copy = document.createElement('span');
    copy.className = 'studio-file-copy';
    const filename = document.createElement('span');
    filename.className = 'studio-file-name';
    filename.textContent = record.name;
    const subpath = document.createElement('span');
    subpath.className = 'studio-file-subpath';
    subpath.textContent = record.path;
    copy.append(filename, subpath);
    open.append(copy);
    open.addEventListener('click', () => selectFile(record.id));
    return open;
  }

  function makeRow(record) {
    const row = document.createElement('tr');
    row.classList.toggle('is-selected', state.selectedForPlan.has(record.id));

    const fileCell = document.createElement('td');
    const fileContent = document.createElement('div');
    fileContent.className = 'studio-file-cell';
    fileContent.append(fileButton(record));
    fileCell.append(fileContent);

    const folderCell = document.createElement('td');
    folderCell.className = 'studio-folder-cell';
    folderCell.textContent = record.folder;

    const sizeCell = document.createElement('td');
    sizeCell.className = 'studio-bytes';
    sizeCell.textContent = formatBytes(record.bytes);

    const signalCell = document.createElement('td');
    const signalList = document.createElement('span');
    signalList.className = 'studio-signal-list';
    if (record.duplicateGroup) {
      const exact = document.createElement('span');
      exact.className = 'studio-signal is-match';
      exact.textContent = 'Exact byte match';
      signalList.append(exact);
    }
    if (record.similarGroup) {
      const similar = document.createElement('span');
      similar.className = 'studio-signal is-similar';
      similar.textContent = 'Visual candidate';
      signalList.append(similar);
    }
    if (record.bytes >= LARGE_IMAGE_BYTES) {
      const large = document.createElement('span');
      large.className = 'studio-signal';
      large.textContent = 'Large image';
      signalList.append(large);
    }
    if (!signalList.childElementCount) signalList.textContent = '—';
    signalCell.append(signalList);

    const reviewCell = document.createElement('td');
    const checkbox = document.createElement('input');
    checkbox.className = 'studio-review-check';
    checkbox.type = 'checkbox';
    checkbox.checked = state.selectedForPlan.has(record.id);
    checkbox.disabled = state.scanning;
    checkbox.setAttribute('aria-label', `Add ${record.path} to review candidates`);
    checkbox.addEventListener('change', () => {
      setReviewSelection(record, checkbox.checked, row);
    });
    reviewCell.append(checkbox);
    row.append(fileCell, folderCell, sizeCell, signalCell, reviewCell);
    return row;
  }

  function setReviewSelection(record, checked, item) {
    if (checked) state.selectedForPlan.add(record.id);
    else state.selectedForPlan.delete(record.id);
    state.plan = null;
    nodes.planResult.hidden = true;
    item.classList.toggle('is-selected', checked);
    item.classList.toggle('is-checked', checked);
    updateCounts();
    renderInspector();
  }

  function makeContactCard(record) {
    const card = document.createElement('article');
    card.className = 'studio-contact-card';
    card.setAttribute('role', 'listitem');
    card.classList.toggle('is-checked', state.selectedForPlan.has(record.id));
    card.classList.toggle('is-inspected', state.selectedFile === record.id);

    const imageButton = document.createElement('button');
    imageButton.type = 'button';
    imageButton.className = 'studio-contact-image-button';
    imageButton.dataset.fileId = record.id;
    imageButton.setAttribute('aria-pressed', String(state.selectedFile === record.id));
    imageButton.setAttribute('aria-label', `Inspect ${record.path}`);
    const image = document.createElement('img');
    image.className = 'studio-contact-image';
    const url = previewUrl(record);
    if (url) image.src = url;
    image.alt = '';
    image.loading = 'lazy';
    image.decoding = 'async';
    imageButton.append(image);
    imageButton.addEventListener('click', () => selectFile(record.id));
    card.append(imageButton);

    const signals = document.createElement('div');
    signals.className = 'studio-contact-signals';
    if (record.duplicateGroup) {
      const exact = document.createElement('span');
      exact.className = 'studio-contact-signal is-exact';
      exact.textContent = 'Exact byte match';
      signals.append(exact);
    }
    if (record.similarGroup) {
      const similar = document.createElement('span');
      similar.className = 'studio-contact-signal is-visual';
      similar.textContent = 'Visual candidate · hint only';
      signals.append(similar);
    }
    if (record.bytes >= LARGE_IMAGE_BYTES) {
      const large = document.createElement('span');
      large.className = 'studio-contact-signal';
      large.textContent = 'Large image · size only';
      signals.append(large);
    }
    if (!signals.childElementCount) {
      const none = document.createElement('span');
      none.className = 'studio-contact-signal';
      none.textContent = 'No review signal';
      signals.append(none);
    }
    card.append(signals);

    const copy = document.createElement('div');
    copy.className = 'studio-contact-copy';
    const name = document.createElement('h3');
    name.className = 'studio-contact-name';
    name.textContent = record.name;
    const path = document.createElement('p');
    path.className = 'studio-contact-path';
    path.textContent = record.path;
    copy.append(name, path);

    const details = document.createElement('dl');
    details.className = 'studio-contact-details';
    const sizeTerm = document.createElement('dt');
    sizeTerm.textContent = 'Size';
    const sizeValue = document.createElement('dd');
    sizeValue.textContent = formatBytes(record.bytes);
    const typeTerm = document.createElement('dt');
    typeTerm.textContent = 'Type';
    const typeValue = document.createElement('dd');
    typeValue.textContent = record.type || '—';
    details.append(sizeTerm, sizeValue, typeTerm, typeValue);
    copy.append(details);
    card.append(copy);

    const reviewLabel = document.createElement('label');
    reviewLabel.className = 'studio-contact-review';
    const checkbox = document.createElement('input');
    checkbox.className = 'studio-review-check';
    checkbox.type = 'checkbox';
    checkbox.checked = state.selectedForPlan.has(record.id);
    checkbox.disabled = state.scanning;
    checkbox.setAttribute('aria-label', `Add ${record.path} to review candidates`);
    checkbox.addEventListener('change', () => setReviewSelection(record, checkbox.checked, card));
    const labelText = document.createElement('span');
    labelText.textContent = 'Add to review';
    reviewLabel.append(checkbox, labelText);
    card.append(reviewLabel);
    return card;
  }

  function renderContactSheet(visible, filteredRecords) {
    nodes.contactSheet.replaceChildren();
    if (state.view !== 'similar') {
      const grid = document.createElement('div');
      grid.className = 'studio-contact-grid';
      grid.setAttribute('role', 'list');
      grid.setAttribute('aria-label', 'Images on this page');
      grid.append(...visible.map(makeContactCard));
      nodes.contactSheet.append(grid);
      return;
    }

    const groups = new Map();
    for (const record of visible) {
      const members = groups.get(record.similarGroup) ?? [];
      members.push(record);
      groups.set(record.similarGroup, members);
    }
    let groupNumber = 0;
    for (const [groupId, members] of groups) {
      groupNumber += 1;
      const matchingGroupSize = filteredRecords.filter((record) => record.similarGroup === groupId).length;
      const section = document.createElement('section');
      section.className = 'studio-contact-group';
      const heading = document.createElement('div');
      heading.className = 'studio-contact-group-heading';
      const title = document.createElement('h3');
      title.id = `studio-contact-group-${groupNumber}`;
      title.textContent = `Candidate group ${groupNumber}`;
      const note = document.createElement('p');
      note.textContent = matchingGroupSize > members.length
        ? `${members.length} shown on this page · ${matchingGroupSize} match current filters · heuristic hint only. More may be on another page.`
        : `${members.length} image${members.length === 1 ? '' : 's'} · heuristic hint only, not proof of interchangeability.`;
      heading.append(title, note);
      const grid = document.createElement('div');
      grid.className = 'studio-contact-grid';
      grid.setAttribute('role', 'list');
      grid.setAttribute('aria-labelledby', title.id);
      grid.append(...members.map(makeContactCard));
      section.append(heading, grid);
      nodes.contactSheet.append(section);
    }
  }

  function renderRows() {
    const records = baseRecords();
    const selectionWasVisible = records.some((record) => record.id === state.selectedFile);
    if (!selectionWasVisible) {
      state.selectedFile = records[0]?.id ?? null;
      state.metadataCache.clear();
    }
    const pageCount = Math.max(1, Math.ceil(records.length / PAGE_SIZE));
    state.page = Math.min(state.page, pageCount - 1);
    const start = state.page * PAGE_SIZE;
    const visible = records.slice(start, start + PAGE_SIZE);
    retainVisibleObjectUrls(visible);
    if (state.layout === 'list') {
      nodes.rows.replaceChildren(...visible.map(makeRow));
      nodes.contactSheet.replaceChildren();
    } else {
      nodes.rows.replaceChildren();
      renderContactSheet(visible, records);
    }
    nodes.tableScroll.hidden = state.layout !== 'list' || records.length === 0;
    nodes.contactSheet.hidden = state.layout !== 'contact' || records.length === 0;
    nodes.viewList.setAttribute('aria-pressed', String(state.layout === 'list'));
    nodes.viewContactSheet.setAttribute('aria-pressed', String(state.layout === 'contact'));
    nodes.viewList.classList.toggle('is-active', state.layout === 'list');
    nodes.viewContactSheet.classList.toggle('is-active', state.layout === 'contact');
    nodes.empty.hidden = records.length !== 0;
    nodes.range.textContent = records.length === 0 ? 'Showing 0 images' : `Showing ${start + 1}–${start + visible.length} of ${records.length} image${records.length === 1 ? '' : 's'}`;
    nodes.previousPage.disabled = state.scanning || state.page === 0;
    nodes.nextPage.disabled = state.scanning || state.page + 1 >= pageCount;
    nodes.pageCopy.textContent = `Page ${state.page + 1} of ${pageCount}`;
    nodes.pageCopy.setAttribute('aria-label', `Page ${state.page + 1} of ${pageCount}`);
    nodes.resetView.onclick = () => {
      state.view = 'all'; state.folder = null; state.query = ''; state.page = 0; nodes.search.value = '';
      updateNavigation(); updateFolderButtons(); renderRows();
    };
    const selected = state.records.find((record) => record.id === state.selectedFile);
    if (selected) nodes.index.textContent = `${String(state.records.indexOf(selected) + 1).padStart(2, '0')} / ${String(state.records.length).padStart(2, '0')}`;
    else nodes.index.textContent = '— / —';
    if (!selectionWasVisible) void renderInspector();
  }

  function updateCounts() {
    const duplicates = state.records.filter((record) => record.duplicateGroup);
    const similar = state.records.filter((record) => record.similarGroup);
    const large = state.records.filter((record) => record.bytes >= LARGE_IMAGE_BYTES);
    nodes.totalAssets.textContent = new Intl.NumberFormat('en').format(state.totalImageCount);
    nodes.assetCaption.textContent = state.inventoryComplete
      ? `${state.indexedImageCount.toLocaleString('en')} largest images available for review`
      : `partial scan · ${state.indexedImageCount.toLocaleString('en')} images retained for review`;
    nodes.imageBytes.textContent = formatBytes(state.totalImageBytes);
    nodes.storageCaption.textContent = state.inventoryComplete ? 'supported image bytes counted' : 'partial image-byte total';
    nodes.duplicateCount.textContent = new Intl.NumberFormat('en').format(duplicates.length);
    nodes.spaceFreedTotal.textContent = state.sourceBytesRemoved === null ? 'Not measured' : formatBytes(state.sourceBytesRemoved);
    nodes.sourceBytesCaption.textContent = state.sourceBytesRemoved === null
      ? 'OS free space is not measured'
      : 'verified bytes removed from selected source; OS free space not measured';
    if (state.records.length > 0 && state.records.every((record) => record.isDemo)) nodes.duplicateMethod.textContent = 'Synthetic example matches';
    else if (state.scanning) nodes.duplicateMethod.textContent = `${state.scanStats?.hashedFiles ?? 0} of ${state.scanStats?.candidateFiles ?? 0} candidate files hashed`;
    else if (!state.scanStats) nodes.duplicateMethod.textContent = 'No local scan yet';
    else nodes.duplicateMethod.textContent = `${state.scanStats.hashedFiles} hashed · ${state.scanStats.skippedLargeFiles} over 64 MB skipped · ${state.scanStats.readFailures} read errors`;
    nodes.allCount.textContent = new Intl.NumberFormat('en').format(state.indexedImageCount);
    nodes.duplicateViewCount.textContent = new Intl.NumberFormat('en').format(duplicates.length);
    nodes.similarViewCount.textContent = new Intl.NumberFormat('en').format(similar.length);
    nodes.largeCount.textContent = new Intl.NumberFormat('en').format(large.length);
    nodes.planCount.textContent = new Intl.NumberFormat('en').format(state.selectedForPlan.size);
    nodes.folderTotal.textContent = String(new Set(state.records.map((record) => record.folder)).size);
    nodes.createPlan.disabled = state.selectedForPlan.size === 0 || state.scanning;
    const estimate = state.records.reduce((sum, record) => sum + (state.selectedForPlan.has(record.id) ? record.bytes : 0), 0);
    nodes.planEstimate.textContent = formatBytes(estimate);
    nodes.spaceFreed.textContent = 'Not measured';
    nodes.planExplainer.textContent = state.selectedForPlan.size === 0
      ? 'Review exact matches, visual candidates, or large images by hand. Nothing is chosen automatically.'
      : `${state.selectedForPlan.size} selected file${state.selectedForPlan.size === 1 ? '' : 's'} · candidate size only. OS free space is not measured.`;
    const archiveReady = state.sourceRoot && state.archiveRoot && state.sourceWriteGranted && state.archiveWriteGranted
      && state.inventoryComplete && !state.partial && !state.scanning && !state.operationBusy
      && state.selectedForPlan.size > 0 && state.selectedForPlan.size <= 20
      && state.records.filter((record) => state.selectedForPlan.has(record.id)).every((record) => !record.isDemo);
    nodes.cleanupAction.disabled = !archiveReady;
    nodes.cleanupAction.textContent = state.selectedForPlan.size > 20 ? 'Select up to 20 files per operation' : 'Review archive selection';
    nodes.enableSourceWrite.disabled = !state.sourceRoot || !directoryPickerAvailable() || state.scanning || state.operationBusy || state.sourceWriteGranted;
    nodes.enableSourceWrite.textContent = state.sourceWriteGranted ? 'Source write permission granted' : 'Allow source write access';
    nodes.chooseQuarantine.disabled = !state.sourceRoot || !directoryPickerAvailable() || state.scanning || state.operationBusy;
    nodes.chooseQuarantine.textContent = state.archiveRoot ? 'Change archive folder' : 'Choose archive folder';
    updateArchiveActionButtons();
  }

  function updateArchiveActionButtons() {
    const chosen = state.archiveEntries.filter((entry) => state.selectedArchiveIds.has(entry.id));
    const resumeReady = chosen.length > 0 && chosen.every((entry) => entry.status === 'verified') && state.sourceRoot && state.sourceWriteGranted && state.archiveWriteGranted;
    const restoreReady = chosen.length > 0 && chosen.every((entry) => entry.status === 'quarantined') && state.sourceRoot && state.sourceWriteGranted && state.archiveWriteGranted;
    const purgeReady = chosen.length > 0 && chosen.every((entry) => ['quarantined', 'restored', 'purging'].includes(entry.status)) && state.archiveRoot && state.archiveWriteGranted;
    nodes.resumeVerified.disabled = !resumeReady || state.operationBusy;
    nodes.restoreSelected.disabled = !restoreReady || state.operationBusy;
    nodes.purgeSelected.disabled = !purgeReady || state.operationBusy;
  }

  function renderArchiveJournal() {
    const pageSize = 20;
    const entries = state.archiveEntries;
    const pages = Math.max(1, Math.ceil(entries.length / pageSize));
    state.archivePage = Math.min(state.archivePage, pages - 1);
    const start = state.archivePage * pageSize;
    const shown = entries.slice(start, start + pageSize);
    const fragment = document.createDocumentFragment();
    for (const entry of shown) {
      const item = document.createElement('label');
      item.className = 'studio-archive-entry';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = state.selectedArchiveIds.has(entry.id);
      checkbox.disabled = !['quarantined', 'restored', 'verified', 'purging'].includes(entry.status) || !state.archiveWriteGranted || state.operationBusy;
      checkbox.setAttribute('aria-label', `Select ${entry.sourcePath} (${entry.status})`);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) state.selectedArchiveIds.add(entry.id); else state.selectedArchiveIds.delete(entry.id);
        updateArchiveActionButtons();
      });
      const text = document.createElement('span'); text.className = 'studio-archive-entry-copy';
      const path = document.createElement('strong'); path.textContent = entry.sourcePath;
      const detail = document.createElement('span'); detail.textContent = `${formatBytes(entry.sizeBytes)} · ${entry.status}${entry.reason ? ` · ${entry.reason}` : ''}`;
      text.append(path, detail); item.append(checkbox, text); fragment.append(item);
    }
    if (entries.length === 0) {
      const empty = document.createElement('p'); empty.className = 'studio-archive-empty';
      empty.textContent = state.archiveRoot ? 'No archived files in this local journal.' : 'No archive folder selected.';
      fragment.append(empty);
    }
    nodes.archiveEntryList.replaceChildren(fragment);
    nodes.archivePagination.hidden = entries.length <= pageSize;
    nodes.archivePrevious.disabled = state.archivePage <= 0;
    nodes.archiveNext.disabled = state.archivePage >= pages - 1;
    nodes.archivePageCopy.textContent = `${state.archivePage + 1} / ${pages}`;
    nodes.archiveJournalCopy.textContent = state.archiveRoot
      ? `${entries.length.toLocaleString('en')} journal entries · paths, reasons, and hashes are stored locally in the selected archive folder and are not uploaded.`
      : 'Choose an archive folder to open its local journal. Paths and hashes remain in that folder and are not uploaded.';
    updateArchiveActionButtons();
  }

  function setArchiveStatus(message, tone = 'info') {
    nodes.archiveStatus.textContent = message;
    nodes.archiveStatus.classList.toggle('is-error', tone === 'error');
    nodes.archiveStatus.hidden = !message;
  }

  function setFileOperationProgress(progress, label) {
    nodes.archiveProgress.hidden = false;
    const total = Math.max(0, progress?.total ?? 0);
    const completed = Math.min(total, Math.max(0, progress?.completed ?? 0));
    const percentage = total ? Math.round(completed / total * 100) : 0;
    nodes.fileOpTrack.setAttribute('aria-valuenow', String(percentage));
    nodes.fileOpTrack.setAttribute('aria-valuetext', `${label} ${formatBytes(completed)} of ${formatBytes(total)}`);
    nodes.fileOpProgressFill.style.width = `${percentage}%`;
    nodes.fileOpProgressCopy.textContent = `${label} · ${formatBytes(completed)} of ${formatBytes(total)}`;
  }

  function selectedRecords() { return state.records.filter((record) => state.selectedForPlan.has(record.id)); }
  function selectedArchiveEntries() { return state.archiveEntries.filter((entry) => state.selectedArchiveIds.has(entry.id)); }
  function appendPathList(container, entries, sizeLabel = (entry) => formatBytes(entry.bytes ?? entry.sizeBytes)) {
    const fragment = document.createDocumentFragment();
    for (const entry of entries) {
      const item = document.createElement('li');
      item.textContent = `${entry.path ?? entry.sourcePath} · ${sizeLabel(entry)}${entry.reason ? ` · ${entry.reason}` : ''}`;
      fragment.append(item);
    }
    container.replaceChildren(fragment);
  }

  function fillArchiveDialog() {
    const records = selectedRecords();
    nodes.archiveDialogCount.textContent = String(records.length);
    nodes.archiveDialogBytes.textContent = formatBytes(records.reduce((sum, record) => sum + record.bytes, 0));
    appendPathList(nodes.archiveDialogFiles, records);
    nodes.archiveReason.value = '';
    nodes.archiveStorageConfirm.checked = false;
    nodes.archiveDialogConfirm.disabled = true;
    nodes.archiveDialog.showModal();
    nodes.archiveReason.focus();
  }

  async function refreshArchiveJournal() {
    if (!state.archiveRoot) return;
    try {
      const journal = await loadQuarantine(state.archiveRoot);
      state.archiveEntries = [...journal.entries].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      state.selectedArchiveIds = new Set([...state.selectedArchiveIds].filter((id) => state.archiveEntries.some((entry) => entry.id === id && ['quarantined', 'restored', 'verified', 'purging'].includes(entry.status))));
      renderArchiveJournal();
    } catch (error) {
      state.archiveEntries = [];
      renderArchiveJournal();
      setArchiveStatus(quarantineErrorMessage(error), 'error');
    }
  }

  async function runFileOperation(dialog, work) {
    if (state.operationBusy) return;
    state.operationBusy = true;
    state.operationController = new AbortController();
    nodes.archiveProgress.hidden = false;
    nodes.cancelFileOperation.disabled = false;
    nodes.fileOpProgressCopy.textContent = 'Preparing local file operation…';
    nodes.fileOpProgressFill.style.width = '0%';
    nodes.fileOpTrack.removeAttribute('aria-valuenow');
    setArchiveStatus('Operation in progress. Keep this tab open; stopping is honored only at safe checkpoints.');
    for (const button of dialog.querySelectorAll('button')) button.disabled = true;
    for (const active of [nodes.archiveDialog, nodes.restoreDialog, nodes.resumeDialog, nodes.purgeDialog]) {
      active.addEventListener('cancel', (event) => { if (state.operationBusy) event.preventDefault(); }, {once: true});
    }
    updateCounts();
    try {
      const result = await work(state.operationController.signal);
      dialog.close();
      setArchiveStatus(result.message);
      state.selectedArchiveIds.clear();
      await refreshArchiveJournal();
      if (result.sourceBytesRemoved !== undefined) {
        state.sourceBytesRemoved = (state.sourceBytesRemoved ?? 0) + result.sourceBytesRemoved;
        updateCounts();
        const root = state.sourceRoot;
        state.selectedForPlan.clear();
        void scanEntries(directoryEntries(root, () => state.cancelRequested), {source: 'Recursive folder scan after archive', rootHandle: root});
      } else if (result.restoredBytes !== undefined) {
        const root = state.sourceRoot;
        setArchiveStatus(`Restored ${formatBytes(result.restoredBytes)} of verified files. The archive copies remain until you explicitly purge them. OS free space is not measured.`);
        void scanEntries(directoryEntries(root, () => state.cancelRequested), {source: 'Recursive folder scan after restore', rootHandle: root});
      }
    } catch (error) {
      setArchiveStatus(quarantineErrorMessage(error), 'error');
      await refreshArchiveJournal();
    } finally {
      state.operationBusy = false;
      state.operationController = null;
      nodes.archiveProgress.hidden = true;
      nodes.cancelFileOperation.textContent = 'Stop safely';
      for (const button of dialog.querySelectorAll('button')) button.disabled = false;
      updateCounts();
    }
  }

  function renderFolders() {
    const folderCounts = new Map();
    for (const record of state.records) folderCounts.set(record.folder, (folderCounts.get(record.folder) ?? 0) + 1);
    const fragment = document.createDocumentFragment();
    for (const [name, count] of [...folderCounts].sort(([a], [b]) => a.localeCompare(b))) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = `studio-folder-item${state.folder === name ? ' is-active' : ''}`;
      item.dataset.folder = name;
      item.setAttribute('aria-pressed', String(state.folder === name));
      const label = document.createElement('span');
      label.className = 'studio-folder-name';
      label.textContent = name;
      const number = document.createElement('span');
      number.className = 'studio-folder-count';
      number.textContent = String(count);
      item.append(label, number);
      item.addEventListener('click', () => {
        state.folder = state.folder === name ? null : name;
        state.view = 'all'; state.page = 0;
        updateNavigation(); updateFolderButtons(); renderRows();
      });
      fragment.append(item);
    }
    nodes.folders.replaceChildren(fragment);
  }

  function updateFolderButtons() {
    for (const item of nodes.folders.querySelectorAll('[data-folder]')) {
      const active = item.dataset.folder === state.folder;
      item.classList.toggle('is-active', active);
      item.setAttribute('aria-pressed', String(active));
    }
  }

  function updateNavigation() {
    for (const item of document.querySelectorAll('[data-view]')) {
      const active = item.dataset.view === state.view && !state.folder;
      item.classList.toggle('is-active', active);
      if (active) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    }
    nodes.clearSearch.hidden = state.query.length === 0;
    nodes.subtitle.textContent = state.folder ? `Folder: ${state.folder} · image files only.`
      : state.view === 'duplicates' ? 'Only files confirmed by SHA-256 and byte comparison are shown.'
        : state.view === 'similar' ? 'Local visual-pattern candidates can be resized or re-encoded versions; inspect previews because this is only a heuristic.'
          : state.view === 'large' ? 'Large images are informational; size alone never makes a review candidate.'
            : state.view === 'plan' ? 'Temporary selection for human review. No files are changed.'
              : 'Review exact matches and visual candidates; large size alone is not a cleanup signal.';
  }

  function addBadge(label, neutral = false) {
    const badge = document.createElement('span');
    badge.className = `studio-badge${neutral ? ' studio-badge-neutral' : ''}`;
    badge.textContent = label;
    nodes.badges.append(badge);
  }

  async function readPngMetadata(file) {
    const bytes = new Uint8Array(await file.slice(0, MAX_METADATA_BYTES).arrayBuffer());
    return {
      ...parsePngGenerationMetadata(bytes),
      limitReached: file.size > MAX_METADATA_BYTES,
    };
  }

  function describeMetadata(result) {
    if (result.status === 'invalid') return 'PNG signature not recognized';
    if (result.fields.length > 0) {
      const count = result.fields.length;
      return `${count} supported generation field${count === 1 ? '' : 's'} found${result.status === 'incomplete' ? ' · partial read' : ''}`;
    }
    if (result.status === 'unsupported') return 'Generation metadata is compressed and was not decoded';
    if (result.status === 'incomplete') return result.limitReached ? 'Partial read · PNG metadata exceeds the 1 MB check limit' : 'Partial read · PNG metadata is truncated or malformed';
    return 'No supported generation fields in checked PNG text chunks';
  }

  function renderMetadataDisclosure(fields, label) {
    nodes.metadataContent.replaceChildren();
    if (fields.length === 0) return;
    const disclosure = document.createElement('details');
    disclosure.className = 'studio-metadata-disclosure';
    const summary = document.createElement('summary');
    summary.textContent = `${label}: reveal ${fields.length} field${fields.length === 1 ? '' : 's'}`;
    disclosure.append(summary);
    disclosure.addEventListener('toggle', () => {
      if (disclosure.open) {
        for (const field of fields) {
          const item = document.createElement('details');
          item.className = 'studio-metadata-field';
          const heading = document.createElement('summary');
          heading.textContent = `${field.key} · ${field.producer}${field.truncated ? ' · value truncated' : ''}`;
          item.append(heading);
          item.addEventListener('toggle', () => {
            if (item.open) {
              const value = document.createElement('pre');
              value.textContent = field.value;
              item.append(value);
            } else if (item.lastElementChild?.tagName === 'PRE') {
              item.lastElementChild.remove();
            }
          });
          disclosure.append(item);
        }
      } else {
        while (disclosure.childElementCount > 1) disclosure.lastElementChild.remove();
      }
    });
    nodes.metadataContent.append(disclosure);
  }

  async function renderInspector() {
    const record = state.records.find((item) => item.id === state.selectedFile);
    if (!record) {
      nodes.preview.removeAttribute('src');
      nodes.preview.alt = 'No image selected';
      nodes.previewUnavailable.hidden = true;
      nodes.name.textContent = 'No image selected';
      nodes.path.textContent = 'Choose a folder containing image files.';
      nodes.size.textContent = '—'; nodes.type.textContent = '—'; nodes.folder.textContent = '—';
      nodes.metadata.textContent = 'Not checked'; nodes.metadataContent.replaceChildren(); nodes.badges.replaceChildren();
      updateCounts();
      return;
    }
    const imageUrl = previewUrl(record);
    if (imageUrl) nodes.preview.src = imageUrl;
    else nodes.preview.removeAttribute('src');
    nodes.previewUnavailable.hidden = record.type !== 'SVG';
    const demoAlt = record.type === 'PNG' && record.path.includes('cabin') ? 'Synthetic demo image of a small cabin in a forest clearing.'
      : record.type === 'PNG' && record.path.includes('observatory') ? 'Synthetic demo image of a fictional observatory under a starry sky.'
        : record.isDemo ? `Synthetic demo image preview for ${record.name}` : `Local image preview for ${record.name}`;
    nodes.preview.alt = record.type === 'SVG' ? 'Preview disabled for SVG to keep embedded content offline.' : record.isDemo ? demoAlt : `Local image preview for ${record.name}`;
    nodes.name.textContent = record.name;
    nodes.path.textContent = record.path;
    nodes.size.textContent = formatBytes(record.bytes);
    nodes.type.textContent = record.type;
    nodes.folder.textContent = record.folder;
    nodes.badges.replaceChildren();
    if (record.isDemo) addBadge('Synthetic demo', true);
    if (record.duplicateGroup) addBadge('Exact byte match');
    if (record.similarGroup) addBadge('Visual similarity candidate', true);
    if (record.bytes >= LARGE_IMAGE_BYTES) addBadge('Large image', true);
    nodes.metadataContent.replaceChildren();
    if (record.isDemo && record.type === 'PNG') {
      const fields = record.metadataFields ?? [];
      nodes.metadata.textContent = fields.length ? `${fields.length} synthetic generation field${fields.length === 1 ? '' : 's'} · sample only` : 'No supported generation fields in this synthetic sample';
      renderMetadataDisclosure(fields, 'Synthetic sample');
    } else if (!record.isDemo && record.type === 'PNG') {
      const selectedId = record.id;
      nodes.metadata.textContent = 'Reading selected PNG text chunks…';
      try {
        if (!state.metadataCache.has(selectedId)) state.metadataCache.set(selectedId, readPngMetadata(record.file));
        const metadata = await state.metadataCache.get(selectedId);
        if (state.selectedFile === selectedId) {
          nodes.metadata.textContent = describeMetadata(metadata);
          renderMetadataDisclosure(metadata.fields, 'Local PNG metadata');
          if (metadata.unsupportedKeys.length > 0 && metadata.fields.length > 0) {
            nodes.metadata.textContent += ` · ${metadata.unsupportedKeys.length} compressed field${metadata.unsupportedKeys.length === 1 ? '' : 's'} not decoded`;
          }
        }
      } catch {
        if (state.selectedFile === selectedId) nodes.metadata.textContent = 'Not checked (read error)';
      }
    } else {
      nodes.metadata.textContent = record.type === 'PNG' ? 'Not checked' : `Not checked for ${record.type}; generation metadata reader currently supports PNG text chunks only`;
    }
    updateCounts();
  }

  function selectFile(id) {
    if (state.selectedFile === id) return;
    state.selectedFile = id;
    state.metadataCache.clear();
    for (const item of [...nodes.rows.querySelectorAll('[data-file-id]'), ...nodes.contactSheet.querySelectorAll('[data-file-id]')]) {
      item.setAttribute('aria-pressed', String(item.dataset.fileId === id));
      item.closest('.studio-contact-card')?.classList.toggle('is-inspected', item.dataset.fileId === id);
    }
    const selected = state.records.find((record) => record.id === id);
    if (selected) nodes.index.textContent = `${String(state.records.indexOf(selected) + 1).padStart(2, '0')} / ${String(state.records.length).padStart(2, '0')}`;
    void renderInspector();
  }

  function renderSort() {
    for (const buttonNode of document.querySelectorAll('[data-sort]')) {
      const header = buttonNode.closest('th');
      const key = buttonNode.dataset.sort;
      const active = key === state.sort;
      if (active) header.setAttribute('aria-sort', state.direction);
      else header.removeAttribute('aria-sort');
      const label = key === 'bytes' ? 'file size' : key === 'folder' ? 'folder' : 'file name';
      buttonNode.setAttribute('aria-label', `Sort by ${label}${active ? `, ${state.direction}` : ''}`);
      const glyph = buttonNode.querySelector('[aria-hidden="true"]');
      if (glyph) glyph.textContent = active ? state.direction === 'ascending' ? '↑' : '↓' : '↕';
    }
  }

  function render() {
    updateNavigation();
    updateCounts();
    renderFolders();
    renderRows();
    renderSort();
    void renderInspector();
  }

  function yieldToBrowser() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  async function* fileListEntries(files) {
    for (const file of files) yield {kind: 'file', file, path: file.webkitRelativePath || file.name};
  }

  async function* directoryEntries(root, shouldStop) {
    async function* visit(directory, parentPath) {
      let iterator;
      try { iterator = directory.values(); }
      catch { yield {kind: 'error', path: parentPath}; return; }
      try {
        for await (const handle of iterator) {
          if (shouldStop()) return;
          const path = parentPath ? `${parentPath}/${handle.name}` : handle.name;
          if (handle.kind === 'directory') {
            yield {kind: 'directory', path};
            yield* visit(handle, path);
          } else if (handle.kind === 'directory') {
            if (handle.name === QUARANTINE_DIRECTORY) continue;
            yield {kind: 'directory', path};
            yield* visit(handle, path);
          } else if (handle.kind === 'file') {
            try { yield {kind: 'file', handle, file: await handle.getFile(), path}; }
            catch { yield {kind: 'error', path}; }
          }
        }
      } catch {
        yield {kind: 'error', path: parentPath};
      }
    }
    yield* visit(root, '');
  }

  function setInventoryProgress(progress, knownTotal, token) {
    if (token !== state.scanToken) return;
    state.totalImageCount = progress.imageCount;
    state.totalImageBytes = progress.imageBytes;
    nodes.totalAssets.textContent = new Intl.NumberFormat('en').format(progress.imageCount);
    nodes.imageBytes.textContent = formatBytes(progress.imageBytes);
    nodes.assetCaption.textContent = 'counting selected folder…';
    nodes.storageCaption.textContent = 'partial image-byte total';
    nodes.folderStatus.textContent = `${progress.imageCount.toLocaleString('en')} images counted so far · ${formatBytes(progress.imageBytes)} · local only.`;
    nodes.scanState.textContent = 'Reading folder';
    nodes.progressTrack.classList.toggle('is-indeterminate', !knownTotal);
    if (knownTotal) {
      const percentage = Math.min(100, Math.round(progress.entriesScanned / knownTotal * 100));
      nodes.progressTrack.setAttribute('aria-valuenow', String(percentage));
      nodes.progressTrack.setAttribute('aria-valuetext', `${progress.entriesScanned} of ${knownTotal} selected entries`);
      nodes.progressFill.style.width = `${percentage}%`;
      nodes.progressCopy.textContent = `Reading selected files · ${progress.entriesScanned.toLocaleString('en')} of ${knownTotal.toLocaleString('en')} entries · ${progress.imageCount.toLocaleString('en')} images · ${formatBytes(progress.imageBytes)}`;
    } else {
      nodes.progressTrack.removeAttribute('aria-valuenow');
      nodes.progressTrack.removeAttribute('aria-valuetext');
      nodes.progressFill.style.width = '25%';
      nodes.progressCopy.textContent = `Reading folders · ${progress.entriesScanned.toLocaleString('en')} entries · ${progress.imageCount.toLocaleString('en')} images · ${formatBytes(progress.imageBytes)}`;
    }
  }

  function setDuplicateProgress(progress, token) {
    if (token !== state.scanToken) return;
    if (progress.phase === 'hash') {
      state.scanStats = {...state.scanStats, candidateFiles: progress.total, hashedFiles: progress.hashedFiles};
      const percentage = progress.total ? Math.round(progress.completed / progress.total * 100) : 100;
      nodes.progressTrack.classList.remove('is-indeterminate');
      nodes.progressTrack.setAttribute('aria-valuenow', String(percentage));
      nodes.progressTrack.setAttribute('aria-valuetext', `${progress.completed} of ${progress.total} duplicate candidates hashed`);
      nodes.progressFill.style.width = `${percentage}%`;
      nodes.progressCopy.textContent = `Checking exact duplicates · ${progress.completed.toLocaleString('en')} of ${progress.total.toLocaleString('en')} candidates · ${progress.hashedFiles.toLocaleString('en')} hashed`;
      nodes.duplicateMethod.textContent = `${progress.hashedFiles.toLocaleString('en')} of ${progress.total.toLocaleString('en')} candidates hashed`;
    } else {
      nodes.progressTrack.classList.add('is-indeterminate');
      nodes.progressTrack.removeAttribute('aria-valuenow');
      nodes.progressTrack.removeAttribute('aria-valuetext');
      nodes.progressFill.style.width = '25%';
      nodes.progressCopy.textContent = `Verifying matching bytes · ${progress.completed.toLocaleString('en')} comparison${progress.completed === 1 ? '' : 's'} completed`;
    }
  }

  function emptyDuplicateResult(cancelled = false) {
    return {groups: [], stats: {candidateFiles: 0, hashedFiles: 0, skippedLargeFiles: 0, readFailures: 0, confirmedGroups: 0}, cancelled};
  }

  function emptyVisualResult(cancelled = false, failed = false) {
    return {groups: [], stats: {eligibleFiles: 0, hashedFiles: 0, skippedFormats: 0, readFailures: 0, candidatePairs: 0, candidatePairsCapped: false, candidateGroups: 0}, cancelled, failed};
  }

  async function scanDuplicates(records, token) {
    const shouldCancel = () => token !== state.scanToken || state.cancelRequested;
    const fallback = () => findExactDuplicateGroups(records, {
      maxHashBytes: MAX_HASH_BYTES,
      shouldCancel,
      onProgress: (progress) => setDuplicateProgress(progress, token),
      yieldToBrowser,
    });
    if (typeof Worker !== 'function') return fallback();

    let worker;
    try { worker = new Worker(new URL('./studio-worker.js', import.meta.url), {type: 'module'}); }
    catch { return fallback(); }

    return new Promise((resolve) => {
      let settled = false;
      let failingOver = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        worker.terminate();
        if (state.worker === worker) state.worker = null;
        resolve(result);
      };
      const failOver = async () => {
        if (settled || failingOver) return;
        failingOver = true;
        worker.terminate();
        if (state.worker === worker) state.worker = null;
        if (shouldCancel()) { finish(emptyDuplicateResult(true)); return; }
        try { finish(await fallback()); }
        catch { finish({...emptyDuplicateResult(false), failed: true}); }
      };
      state.worker = worker;
      worker.onmessage = (event) => {
        const message = event.data;
        if (!message || message.token !== token) return;
        if (message.type === 'progress') setDuplicateProgress(message.progress, token);
        else if (message.type === 'error') void failOver();
        else if (message.type === 'result') {
          const byId = new Map(records.map((record) => [record.id, record]));
          finish({...message, groups: message.groups.map((group) => group.map((id) => byId.get(id)).filter(Boolean)).filter((group) => group.length > 1)});
        }
      };
      worker.onerror = () => { void failOver(); };
      try {
        worker.postMessage({type: 'scan', token, maxHashBytes: MAX_HASH_BYTES, records: records.map(({id, file}) => ({id, file}))});
      } catch {
        void failOver();
      }
    });
  }

  function setVisualProgress(progress, token) {
    if (token !== state.scanToken) return;
    state.visualStats = {
      ...state.visualStats,
      eligibleFiles: progress.total ?? state.visualStats?.eligibleFiles ?? 0,
      hashedFiles: progress.hashedFiles ?? state.visualStats?.hashedFiles ?? 0,
      readFailures: progress.readFailures ?? state.visualStats?.readFailures ?? 0,
      candidatePairs: progress.candidatePairs ?? state.visualStats?.candidatePairs ?? 0,
    };
    const total = progress.total ?? 0;
    const percentage = progress.phase === 'visual-hash'
      ? (total ? Math.round(progress.completed / total * 65) : 65)
      : (total ? 65 + Math.round(progress.completed / total * 35) : 100);
    nodes.progressTrack.classList.remove('is-indeterminate');
    nodes.progressTrack.setAttribute('aria-valuenow', String(percentage));
    nodes.progressTrack.setAttribute('aria-valuetext', progress.phase === 'visual-hash'
      ? `${progress.completed} of ${total} raster images checked for visual candidates`
      : `Grouping visual candidates · ${progress.completed} of ${total} image patterns`);
    nodes.progressFill.style.width = `${percentage}%`;
    nodes.scanState.textContent = 'Checking visual candidates';
    nodes.progressCopy.textContent = progress.phase === 'visual-hash'
      ? `Checking local image patterns · ${progress.completed.toLocaleString('en')} of ${total.toLocaleString('en')} raster images`
      : `Grouping visual review candidates · ${progress.completed.toLocaleString('en')} of ${total.toLocaleString('en')} image patterns`;
  }

  async function scanVisualSimilarities(records, token) {
    const shouldCancel = () => token !== state.scanToken || state.cancelRequested;
    const maxDistance = 5;
    const maxCandidatePairs = 50_000;
    const fallback = () => findVisualSimilarityGroups(records, {
      maxDistance,
      maxCandidatePairs,
      shouldCancel,
      onProgress: (progress) => setVisualProgress(progress, token),
      yieldToBrowser,
    });
    if (typeof Worker !== 'function') return fallback();

    let worker;
    try { worker = new Worker(new URL('./studio-worker.js', import.meta.url), {type: 'module'}); }
    catch { return fallback(); }

    return new Promise((resolve) => {
      let settled = false;
      let failingOver = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        worker.terminate();
        if (state.worker === worker) state.worker = null;
        resolve(result);
      };
      const failOver = async () => {
        if (settled || failingOver) return;
        failingOver = true;
        worker.terminate();
        if (state.worker === worker) state.worker = null;
        if (shouldCancel()) { finish(emptyVisualResult(true)); return; }
        try { finish(await fallback()); }
        catch { finish(emptyVisualResult(false, true)); }
      };
      state.worker = worker;
      worker.onmessage = (event) => {
        const message = event.data;
        if (!message || message.token !== token) return;
        if (message.type === 'progress') setVisualProgress(message.progress, token);
        else if (message.type === 'error') void failOver();
        else if (message.type === 'similarity-result') {
          const byId = new Map(records.map((record) => [record.id, record]));
          finish({...message, groups: message.groups.map((group) => group.map((id) => byId.get(id)).filter(Boolean)).filter((group) => group.length > 1)});
        }
      };
      worker.onerror = () => { void failOver(); };
      try {
        worker.postMessage({type: 'similarity-scan', token, maxDistance, maxCandidatePairs, records: records.map(({id, file, type, path}) => ({id, file, type, path}))});
      } catch {
        void failOver();
      }
    });
  }

  function startScanState() {
    state.scanToken += 1;
    state.worker?.terminate();
    state.worker = null;
    state.cancelRequested = false;
    state.scanning = true;
    state.sourceRoot = null;
    state.sourceWriteGranted = false;
    state.partial = false;
    state.visualPartial = false;
    state.scanStats = null;
    state.visualStats = null;
    state.plan = null;
    state.selectedForPlan.clear();
    state.records = [];
    state.totalImageCount = 0;
    state.totalImageBytes = 0;
    state.indexedImageCount = 0;
    state.inventoryComplete = false;
    state.unreadableFiles = 0;
    state.selectedFile = null;
    state.view = 'all'; state.folder = null; state.query = ''; state.sort = 'bytes'; state.direction = 'descending'; state.page = 0;
    clearObjectUrls();
    state.metadataCache.clear();
    nodes.planResult.hidden = true;
    nodes.planResult.replaceChildren();
    nodes.search.value = '';
    nodes.chooseFolder.disabled = true;
    nodes.progress.hidden = false;
    nodes.cancel.disabled = false;
    nodes.cancel.textContent = 'Stop scan';
    nodes.cancel.hidden = false;
    nodes.progressFill.style.width = '25%';
    nodes.progressTrack.classList.add('is-indeterminate');
    nodes.progressTrack.removeAttribute('aria-valuenow');
    nodes.progressTrack.removeAttribute('aria-valuetext');
    nodes.progressCopy.textContent = 'Starting local folder scan…';
    nodes.folderStatus.textContent = 'Reading image names, sizes, and folders locally…';
    nodes.demoLabel.textContent = 'Local folder · read only';
    nodes.scopeCopy.textContent = 'Guardian is reading the selected folder in this browser. Image bytes and metadata stay local.';
    nodes.scanState.textContent = 'Starting scan';
    setNotice('');
    render();
    return state.scanToken;
  }

  async function scanEntries(entries, {source, knownTotal = 0, rootHandle = null} = {}) {
    if (rootHandle && (rootHandle.name === QUARANTINE_DIRECTORY || await isProtectedQuarantineDirectory(rootHandle))) {
      setNotice('Guardian will not scan its quarantine data directory as a source. Choose the original image folder.', 'error');
      return;
    }
    const keepWriteGrant = Boolean(rootHandle && rootHandle === state.sourceRoot && state.sourceWriteGranted);
    const token = startScanState();
    state.sourceRoot = rootHandle;
    state.sourceWriteGranted = keepWriteGrant;
    let inventory;
    try {
      inventory = await collectImageInventory(entries, {
        maxRecords: MAX_SCAN_FILES,
        maxEntries: 250_000,
        shouldCancel: () => token !== state.scanToken || state.cancelRequested,
        onProgress: (progress) => setInventoryProgress(progress, knownTotal, token),
        yieldToBrowser,
      });
      if (token !== state.scanToken) return;
      state.totalImageCount = inventory.imageCount;
      state.totalImageBytes = inventory.imageBytes;
      state.indexedImageCount = inventory.records.length;
      state.unreadableFiles = inventory.unreadableFiles;
      state.inventoryComplete = !inventory.cancelled && !inventory.capped && inventory.unreadableFiles === 0;
      state.records = inventory.records.map((record, index) => ({...record, id: `local-${token}-${index}`}));
      state.selectedFile = state.records[0]?.id ?? null;
      state.folder = null; state.page = 0;
      state.scanStats = {candidateFiles: 0, hashedFiles: 0, skippedLargeFiles: 0, readFailures: 0, confirmedGroups: 0};
      nodes.folderStatus.textContent = `${inventory.imageCount.toLocaleString('en')} images counted · ${inventory.records.length.toLocaleString('en')} largest retained for review · ${formatBytes(inventory.imageBytes)} total.`;
      nodes.scopeCopy.textContent = `${source}. Counts include supported image files; the largest ${MAX_SCAN_FILES.toLocaleString('en')} are retained for visual review. Scanning is read-only; archive actions require separate write permission and per-file confirmation.`;
      render();

      let result = emptyDuplicateResult(inventory.cancelled);
      if (!inventory.cancelled && state.records.length > 0) {
        nodes.scanState.textContent = 'Checking exact duplicates';
        nodes.progressTrack.classList.add('is-indeterminate');
        nodes.progressTrack.removeAttribute('aria-valuenow');
        nodes.progressTrack.removeAttribute('aria-valuetext');
        nodes.progressCopy.textContent = 'Grouping same-size images before local hash checks…';
        result = await scanDuplicates(state.records, token);
      }
      if (token !== state.scanToken) return;
      let matchIndex = 0;
      for (const matches of result.groups) {
        const id = `exact-byte-match-${token}-${matchIndex++}`;
        for (const record of matches) record.duplicateGroup = id;
      }
      let visual = emptyVisualResult(inventory.cancelled || result.cancelled);
      if (!inventory.cancelled && !result.cancelled && !state.cancelRequested && state.records.length > 0) {
        nodes.scanState.textContent = 'Checking visual candidates';
        nodes.progressTrack.classList.remove('is-indeterminate');
        nodes.progressTrack.setAttribute('aria-valuenow', '0');
        nodes.progressTrack.setAttribute('aria-valuetext', 'Preparing local visual candidate scan');
        nodes.progressFill.style.width = '0%';
        nodes.progressCopy.textContent = 'Preparing local visual candidate scan…';
        visual = await scanVisualSimilarities(state.records, token);
      }
      if (token !== state.scanToken) return;
      let visualIndex = 0;
      for (const matches of visual.groups) {
        const id = `visual-candidate-${token}-${visualIndex++}`;
        for (const record of matches) record.similarGroup = id;
      }
      state.scanStats = result.stats;
      state.visualStats = visual.stats;
      state.visualPartial = visual.cancelled || visual.failed || visual.stats.skippedFormats > 0
        || visual.stats.readFailures > 0 || visual.stats.candidatePairsCapped;
      state.partial = inventory.cancelled || inventory.capped || inventory.imageCount > inventory.records.length
        || inventory.unreadableFiles > 0 || result.cancelled || result.failed
        || result.stats.skippedLargeFiles > 0 || result.stats.readFailures > 0;
      state.scanning = false;
      state.cancelRequested = false;
      nodes.chooseFolder.disabled = false;
      nodes.progress.hidden = true;
      nodes.progressTrack.classList.remove('is-indeterminate');
      nodes.progressTrack.setAttribute('aria-valuenow', state.partial ? '0' : '100');
      nodes.cancel.hidden = true;
      nodes.cancel.disabled = false;
      nodes.cancel.textContent = 'Stop scan';
      nodes.scanState.textContent = state.partial ? 'Partial scan' : state.visualPartial ? 'Scan complete · visual hints partial' : 'Scan complete';
      const warnings = [];
      if (inventory.cancelled || result.cancelled) warnings.push('Scan stopped early. Counts, duplicates, and the review set may be incomplete.');
      if (inventory.capped) warnings.push('The scan reached the 250,000-entry safety limit; total image count and bytes are partial.');
      if (inventory.imageCount > inventory.records.length) warnings.push(`Only the ${inventory.records.length.toLocaleString('en')} largest of ${inventory.imageCount.toLocaleString('en')} images were retained and checked for duplicates.`);
      if (result.failed) warnings.push('Exact-duplicate verification failed; no duplicate conclusion is available.');
      if (result.stats.skippedLargeFiles > 0) warnings.push(`${result.stats.skippedLargeFiles.toLocaleString('en')} retained images over 64 MiB were not hash-checked.`);
      const readErrors = inventory.unreadableFiles + result.stats.readFailures;
      if (readErrors > 0) warnings.push(`${readErrors.toLocaleString('en')} file reads failed; those files were not marked as duplicates.`);
      if (visual.failed) warnings.push('Visual candidate checking could not run in this browser. Exact duplicate results remain available.');
      if (visual.cancelled) warnings.push('Visual candidate checking stopped early; no complete visual result is available.');
      if (visual.stats.skippedFormats > 0) warnings.push(`${visual.stats.skippedFormats.toLocaleString('en')} GIF/SVG or unsupported image files were skipped by visual candidate checking.`);
      if (visual.stats.readFailures > 0) warnings.push(`${visual.stats.readFailures.toLocaleString('en')} raster images could not be decoded for visual candidate checking.`);
      if (visual.stats.candidatePairsCapped) warnings.push('Visual candidate grouping reached its safety limit; its results are partial.');
      const ending = 'No files were moved or deleted; space actually freed by Guardian is 0 B.';
      setNotice(warnings.length ? `${warnings.join(' ')} ${ending}` : `${inventory.imageCount.toLocaleString('en')} image files counted locally. Exact duplicates include a byte comparison; visual candidates are heuristic review hints. ${ending}`, warnings.length ? 'error' : 'info');
      render();
    } catch {
      if (token !== state.scanToken) return;
      state.scanning = false;
      state.cancelRequested = false;
      nodes.chooseFolder.disabled = false;
      nodes.progress.hidden = true;
      nodes.cancel.hidden = true;
      nodes.scanState.textContent = 'Scan failed';
      nodes.folderStatus.textContent = 'The selected folder could not be read. Choose it again or use the compatibility picker.';
      setNotice('The folder scan could not be completed. No files were changed; try selecting the folder again.', 'error');
      render();
    }
  }

  function directoryPickerAvailable() {
    return typeof window.showDirectoryPicker === 'function';
  }

  function directoryInputAvailable() {
    return typeof HTMLInputElement !== 'undefined' && 'webkitdirectory' in HTMLInputElement.prototype;
  }

  function updatePickerCapability() {
    if (directoryPickerAvailable()) {
      nodes.chooseFolder.textContent = 'Choose a folder';
      nodes.folderCapability.textContent = `Recursive browser folder picker available · ${typeof Worker === 'function' ? 'background duplicate scan' : 'slower compatible duplicate scan'} · read-only until you separately grant write access.`;
      nodes.folderFallback.hidden = false;
    } else if (directoryInputAvailable()) {
      nodes.chooseFolder.textContent = 'Choose a folder';
      nodes.folderCapability.textContent = 'Recursive compatibility folder picker available · duplicate scan may run in this tab.';
      nodes.folderFallback.hidden = true;
    } else {
      nodes.chooseFolder.textContent = 'Choose images';
      nodes.folderCapability.textContent = 'This browser cannot scan folders recursively; choose images manually or use a supported browser.';
      nodes.folderFallback.hidden = false;
      nodes.folderFallback.textContent = 'Choose images manually';
    }
  }

  nodes.chooseFolder.addEventListener('click', async () => {
    if (state.scanning) return;
    if (!directoryPickerAvailable()) { nodes.folderInput.click(); return; }
    try {
      const root = await window.showDirectoryPicker({mode: 'read'});
      if (root.name === QUARANTINE_DIRECTORY) {
        setNotice('Guardian will not scan its quarantine folder as a source. Choose the original image folder.', 'error');
        return;
      }
      void scanEntries(directoryEntries(root, () => state.cancelRequested), {source: 'Recursive folder scan', rootHandle: root});
    } catch (error) {
      if (error?.name === 'AbortError') return;
      nodes.folderFallback.hidden = false;
      setNotice('The browser folder picker could not open this folder. Try the compatibility picker; no write permission was requested.', 'error');
      nodes.folderFallback.focus();
    }
  });
  nodes.folderFallback.addEventListener('click', () => nodes.folderInput.click());
  nodes.folderInput.addEventListener('change', () => {
    const files = nodes.folderInput.files;
    if (files?.length) {
      const snapshot = Array.from(files);
      void scanEntries(fileListEntries(snapshot), {
        source: directoryInputAvailable() ? 'Compatibility folder scan' : 'Selected image files',
        knownTotal: snapshot.length,
      });
    }
    nodes.folderInput.value = '';
  });
  nodes.cancel.addEventListener('click', () => {
    if (!state.scanning || state.cancelRequested) return;
    state.cancelRequested = true;
    state.worker?.postMessage({type: 'cancel', token: state.scanToken});
    nodes.cancel.disabled = true;
    nodes.cancel.textContent = 'Stopping…';
    nodes.progressCopy.textContent = 'Stopping after the current local check…';
  });
  nodes.search.addEventListener('input', () => {
    state.query = nodes.search.value.trim();
    state.page = 0;
    updateNavigation(); renderRows();
  });
  nodes.clearSearch.addEventListener('click', () => {
    state.query = ''; state.page = 0; nodes.search.value = '';
    updateNavigation(); renderRows(); nodes.search.focus();
  });
  nodes.previousPage.addEventListener('click', () => {
    if (state.scanning) return;
    state.page = Math.max(0, state.page - 1);
    renderRows();
  });
  nodes.nextPage.addEventListener('click', () => {
    if (state.scanning) return;
    state.page += 1;
    renderRows();
  });
  nodes.viewList.addEventListener('click', () => {
    if (state.layout === 'list') return;
    state.layout = 'list';
    renderRows();
  });
  nodes.viewContactSheet.addEventListener('click', () => {
    if (state.layout === 'contact') return;
    state.layout = 'contact';
    renderRows();
  });
  for (const item of document.querySelectorAll('[data-view]')) {
    item.addEventListener('click', () => {
      state.view = item.dataset.view;
      state.folder = null;
      state.page = 0;
      if (state.view === 'large') { state.sort = 'bytes'; state.direction = 'descending'; renderSort(); }
      updateNavigation(); renderFolders(); renderRows();
    });
  }
  for (const sortButton of document.querySelectorAll('[data-sort]')) {
    sortButton.addEventListener('click', () => {
      const key = sortButton.dataset.sort;
      if (state.sort === key) state.direction = state.direction === 'ascending' ? 'descending' : 'ascending';
      else { state.sort = key; state.direction = key === 'bytes' ? 'descending' : 'ascending'; }
      state.page = 0;
      renderSort(); renderRows();
    });
  }
  nodes.createPlan.addEventListener('click', () => {
    const selected = state.records.filter((record) => state.selectedForPlan.has(record.id));
    if (selected.length === 0 || state.scanning) return;
    const candidateBytes = selected.reduce((sum, record) => sum + record.bytes, 0);
    state.plan = buildReviewPlan(state.records, state.selectedForPlan, {
      complete: state.inventoryComplete && !state.partial && !state.visualPartial,
      totalImageCount: state.totalImageCount,
      totalImageBytes: state.totalImageBytes,
      retainedForReview: state.indexedImageCount,
    });
    const heading = document.createElement('strong');
    heading.textContent = state.partial ? 'Partial scan plan exported · no files changed' : 'Review plan exported · no files changed';
    const text = document.createElement('span');
    text.textContent = `${selected.length.toLocaleString('en')} selected files · candidate size ${formatBytes(candidateBytes)} · actually freed 0 B. The JSON contains relative paths and sizes; keep it private if folder names are sensitive.`;
    const list = document.createElement('ul');
    for (const record of selected) {
      const item = document.createElement('li');
      item.textContent = `${record.path} · ${formatBytes(record.bytes)}`;
      list.append(item);
    }
    nodes.planResult.replaceChildren(heading, text, list);
    nodes.planResult.hidden = false;
    const downloadUrl = URL.createObjectURL(new Blob([JSON.stringify(state.plan, null, 2)], {type: 'application/json'}));
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.download = `guardian-studio-review-${new Date().toISOString().slice(0, 10)}.json`;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 30_000);
    setNotice(`Exported ${selected.length.toLocaleString('en')} candidates (${formatBytes(candidateBytes)}). Guardian has freed 0 B; no files were changed.`);
  });

  nodes.enableSourceWrite.addEventListener('click', async () => {
    const root = state.sourceRoot;
    if (!root || typeof root.requestPermission !== 'function') return;
    try {
      const permission = await root.requestPermission({mode: 'readwrite'});
      state.sourceWriteGranted = permission === 'granted';
      setArchiveStatus(state.sourceWriteGranted
        ? 'Source write access granted for this browser session. Archiving still requires a separate archive folder and exact-file confirmation.'
        : 'Source write access was not granted. Scanning and review remain available; archive is disabled.');
    } catch {
      state.sourceWriteGranted = false;
      setArchiveStatus('The browser did not grant source write access. No source file was changed.', 'error');
    }
    updateCounts();
  });

  nodes.chooseQuarantine.addEventListener('click', async () => {
    if (!directoryPickerAvailable() || !state.sourceRoot || state.operationBusy) return;
    try {
      const selected = await window.showDirectoryPicker({mode: 'readwrite'});
      if (selected.name === QUARANTINE_DIRECTORY || await isProtectedQuarantineDirectory(selected)) {
        state.archiveRoot = null;
        state.archiveWriteGranted = false;
        state.archiveEntries = [];
        state.selectedArchiveIds.clear();
        setArchiveStatus('Choose a normal archive folder, not Guardian’s protected quarantine data folder.', 'error');
        updateCounts();
        return;
      }
      await assertArchiveDestinationOutsideSource(state.sourceRoot, selected);
      state.archiveRoot = selected;
      state.archiveWriteGranted = await selected.queryPermission({mode: 'readwrite'}) === 'granted';
      state.archivePage = 0;
      state.selectedArchiveIds.clear();
      if (!state.archiveWriteGranted) setArchiveStatus('Archive-folder write access was not granted. Choose it again or authorize it; no file was changed.', 'error');
      else setArchiveStatus('Archive folder selected outside the source folder. Guardian cannot verify its storage volume. Archive copies continue to use storage; on the same volume, archiving does not recover device space until the copies are permanently purged.');
      await refreshArchiveJournal();
    } catch (error) {
      if (error?.name !== 'AbortError') {
        state.archiveRoot = null;
        state.archiveWriteGranted = false;
        state.archiveEntries = [];
        state.selectedArchiveIds.clear();
        setArchiveStatus('Guardian could not verify that this archive folder is outside the source folder. Choose a separate folder; nothing was changed.', 'error');
      }
    }
    updateCounts();
  });

  nodes.cleanupAction.addEventListener('click', async () => {
    if (nodes.cleanupAction.disabled) return;
    try {
      await assertArchiveDestinationOutsideSource(state.sourceRoot, state.archiveRoot);
    } catch {
      state.archiveRoot = null;
      state.archiveWriteGranted = false;
      state.archiveEntries = [];
      state.selectedArchiveIds.clear();
      setArchiveStatus('Guardian could not verify that this archive folder is outside the source folder. Choose a separate folder; archive is disabled.', 'error');
      updateCounts();
      return;
    }
    fillArchiveDialog();
  });
  const closeDialog = (dialog) => { if (dialog.open && !state.operationBusy) dialog.close(); };
  nodes.archiveDialogClose.addEventListener('click', () => closeDialog(nodes.archiveDialog));
  nodes.archiveDialogCancel.addEventListener('click', () => closeDialog(nodes.archiveDialog));
  const updateArchiveConfirmation = () => {
    nodes.archiveDialogConfirm.disabled = nodes.archiveReason.value.trim().length === 0 || !nodes.archiveStorageConfirm.checked || state.operationBusy;
  };
  nodes.archiveReason.addEventListener('input', updateArchiveConfirmation);
  nodes.archiveStorageConfirm.addEventListener('change', updateArchiveConfirmation);
  nodes.archiveDialogConfirm.addEventListener('click', async () => {
    if (!nodes.archiveReason.value.trim() || !nodes.archiveStorageConfirm.checked || state.operationBusy) return;
    const sourceRoot = state.sourceRoot;
    const destinationRoot = state.archiveRoot;
    try {
      await assertArchiveDestinationOutsideSource(sourceRoot, destinationRoot);
    } catch {
      state.archiveRoot = null;
      state.archiveWriteGranted = false;
      state.archiveEntries = [];
      state.selectedArchiveIds.clear();
      setArchiveStatus('Guardian could not verify that this archive folder is outside the source folder. Choose a separate folder; nothing was changed.', 'error');
      closeDialog(nodes.archiveDialog);
      updateCounts();
      return;
    }
    if (state.sourceRoot !== sourceRoot || state.archiveRoot !== destinationRoot) {
      setArchiveStatus('The selected source or archive folder changed during the safety check. Review the folders again; nothing was changed.', 'error');
      return;
    }
    const records = selectedRecords();
    void runFileOperation(nodes.archiveDialog, async (signal) => {
      await assertArchiveDestinationOutsideSource(sourceRoot, destinationRoot);
      const result = await quarantineFiles({sourceRoot, destinationRoot, records, reason: nodes.archiveReason.value.trim(), confirmed: true, signal, onProgress: (progress) => setFileOperationProgress(progress, progress.phase === 'copy' ? 'Copying' : 'Verifying')});
      const absent = result.sourceBytesAlreadyAbsent ? ` ${formatBytes(result.sourceBytesAlreadyAbsent)} more bytes were already absent and are not attributed to Guardian.` : '';
      return {sourceBytesRemoved: result.sourceBytesRemoved, message: `${formatBytes(result.sourceBytesRemoved)} of verified file bytes removed from the selected source.${absent} Verified archive copies remain stored in the selected folder. Guardian cannot verify the storage volume or measure device free space; on the same volume, source space is not recovered until the archive copies are permanently purged.`};
    });
  });

  nodes.archivePrevious.addEventListener('click', () => { state.archivePage = Math.max(0, state.archivePage - 1); renderArchiveJournal(); });
  nodes.archiveNext.addEventListener('click', () => { state.archivePage += 1; renderArchiveJournal(); });
  nodes.resumeVerified.addEventListener('click', () => {
    const entries = selectedArchiveEntries();
    if (!entries.length || nodes.resumeVerified.disabled) return;
    appendPathList(nodes.resumeDialogFiles, entries);
    nodes.resumeSourceConfirm.checked = false;
    nodes.resumeDialogConfirm.disabled = true;
    nodes.resumeDialog.showModal();
  });
  nodes.resumeSourceConfirm.addEventListener('change', () => { nodes.resumeDialogConfirm.disabled = !nodes.resumeSourceConfirm.checked || state.operationBusy; });
  nodes.resumeDialogClose.addEventListener('click', () => closeDialog(nodes.resumeDialog));
  nodes.resumeDialogCancel.addEventListener('click', () => closeDialog(nodes.resumeDialog));
  nodes.resumeDialogConfirm.addEventListener('click', () => {
    if (!nodes.resumeSourceConfirm.checked) return;
    const ids = selectedArchiveEntries().map((entry) => entry.id);
    void runFileOperation(nodes.resumeDialog, async (signal) => {
      const result = await reconcileVerifiedQuarantine({sourceRoot: state.sourceRoot, destinationRoot: state.archiveRoot, ids, confirmed: true, sourceRootConfirmed: true, signal, onProgress: (progress) => setFileOperationProgress(progress, 'Rechecking archive integrity')});
      const removed = result.sourceBytesRemoved ? `${formatBytes(result.sourceBytesRemoved)} source bytes removed after re-verification` : 'No source bytes were removed in this recovery step';
      const absent = result.sourceBytesAlreadyAbsent ? `; ${formatBytes(result.sourceBytesAlreadyAbsent)} were already absent and are not attributed to Guardian` : '';
      return {sourceBytesRemoved: result.sourceBytesRemoved, message: `${removed}${absent}. Archive retained; OS free space is not measured.`};
    });
  });
  nodes.restoreSelected.addEventListener('click', () => {
    const entries = selectedArchiveEntries();
    if (!entries.length || nodes.restoreSelected.disabled) return;
    appendPathList(nodes.restoreDialogFiles, entries);
    nodes.restoreSourceConfirm.checked = false;
    nodes.restoreDialogConfirm.disabled = true;
    nodes.restoreDialog.showModal();
  });
  nodes.restoreSourceConfirm.addEventListener('change', () => { nodes.restoreDialogConfirm.disabled = !nodes.restoreSourceConfirm.checked || state.operationBusy; });
  nodes.restoreDialogClose.addEventListener('click', () => closeDialog(nodes.restoreDialog));
  nodes.restoreDialogCancel.addEventListener('click', () => closeDialog(nodes.restoreDialog));
  nodes.restoreDialogConfirm.addEventListener('click', () => {
    if (!nodes.restoreSourceConfirm.checked) return;
    const ids = selectedArchiveEntries().map((entry) => entry.id);
    void runFileOperation(nodes.restoreDialog, async (signal) => {
      const result = await restoreQuarantined({sourceRoot: state.sourceRoot, destinationRoot: state.archiveRoot, ids, confirmed: true, signal, onProgress: (progress) => setFileOperationProgress(progress, 'Restoring and verifying')});
      return {restoredBytes: result.restoredBytes, message: `Restored ${formatBytes(result.restoredBytes)} of verified files. Archive copies remain until you explicitly purge them. OS free space is not measured.`};
    });
  });

  nodes.purgeSelected.addEventListener('click', () => {
    const entries = selectedArchiveEntries();
    if (!entries.length || nodes.purgeSelected.disabled) return;
    nodes.purgeDialogCount.textContent = String(entries.length);
    nodes.purgeDialogBytes.textContent = formatBytes(entries.reduce((sum, entry) => sum + entry.sizeBytes, 0));
    appendPathList(nodes.purgeDialogFiles, entries);
    nodes.purgeUnderstood.checked = false;
    nodes.purgePhrase.value = '';
    nodes.purgeDialogConfirm.disabled = true;
    nodes.purgeDialog.showModal();
    nodes.purgePhrase.focus();
  });
  const updatePurgeConfirmation = () => {
    nodes.purgeDialogConfirm.disabled = !nodes.purgeUnderstood.checked || nodes.purgePhrase.value !== 'PURGE' || state.operationBusy;
  };
  nodes.purgeUnderstood.addEventListener('change', updatePurgeConfirmation);
  nodes.purgePhrase.addEventListener('input', updatePurgeConfirmation);
  nodes.purgeDialogClose.addEventListener('click', () => closeDialog(nodes.purgeDialog));
  nodes.purgeDialogCancel.addEventListener('click', () => closeDialog(nodes.purgeDialog));
  nodes.purgeDialogConfirm.addEventListener('click', () => {
    const ids = selectedArchiveEntries().map((entry) => entry.id);
    void runFileOperation(nodes.purgeDialog, async (signal) => {
      const result = await purgeQuarantined({destinationRoot: state.archiveRoot, ids, confirmed: true, typedConfirmation: nodes.purgePhrase.value, signal, onProgress: (progress) => setFileOperationProgress(progress, 'Purging verified archive data')});
      return {message: `${formatBytes(result.purgedBytes)} of verified file bytes removed from Guardian’s archive. No OS free-space measurement is available.`};
    });
  });
  nodes.cancelFileOperation.addEventListener('click', () => {
    if (!state.operationController || !state.operationBusy) return;
    state.operationController.abort();
    nodes.cancelFileOperation.disabled = true;
    nodes.cancelFileOperation.textContent = 'Stopping safely…';
  });

  nodes.watchRefresh.addEventListener('click', () => {
    if (watchTimer !== null) window.clearTimeout(watchTimer);
    watchTimer = null;
    void refreshWatchStatus();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) scheduleWatchRefresh(0);
  });
  window.addEventListener('pagehide', () => {
    if (watchTimer !== null) window.clearTimeout(watchTimer);
    watchController?.abort();
  });

  updatePickerCapability();
  render();
  void refreshWatchStatus();
})();
