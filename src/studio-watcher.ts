import {watch as watchPath, type FSWatcher} from 'node:fs';
import {lstat, readdir, realpath} from 'node:fs/promises';
import {basename, extname, relative, resolve} from 'node:path';

const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.svg']);
const ignoredDirectories = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'coverage', '.guardian', '.guardian-quarantine']);
const DEFAULT_LARGE_IMAGE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 250_000;
const DEFAULT_QUEUE_LIMIT = 100;
const DEFAULT_RECONCILE_MS = 60_000;
const DEFAULT_DEBOUNCE_MS = 500;
const DEFAULT_STABILITY_MS = 2_000;

type ObservedFile = {
  path: string;
  bytes: number;
  mtimeMs: number;
  isNew: boolean;
  firstSeenAt: number;
  stableSince: number;
};

export type StudioWatchCandidate = {
  path: string;
  bytes: number;
  modifiedAt: string;
  discoveredAt: string | null;
  isNew: boolean;
  isLarge: boolean;
  stable: boolean;
};

export type StudioWatchSnapshot = {
  enabled: true;
  mode: 'watching' | 'polling';
  folder: string;
  scannedAt: string | null;
  entriesScanned: number;
  imageCount: number;
  candidateCount: number;
  newCount: number;
  largeCount: number;
  pendingCount: number;
  partial: boolean;
  truncated: boolean;
  largeImageThresholdBytes: number;
  candidates: StudioWatchCandidate[];
  notice: string | null;
};

export type StudioWatcher = {
  getSnapshot(): StudioWatchSnapshot;
  close(): void;
};

export type StudioWatcherOptions = {
  largeImageThresholdBytes?: number;
  maxEntries?: number;
  queueLimit?: number;
  reconcileMs?: number;
  debounceMs?: number;
  stabilityMs?: number;
};

function relativePath(root: string, path: string): string {
  return relative(root, path).replaceAll('\\', '/');
}

export async function createStudioWatcher(rootDir: string, options: StudioWatcherOptions = {}): Promise<StudioWatcher> {
  const requestedRoot = resolve(rootDir);
  const rootInfo = await lstat(requestedRoot);
  if (['.guardian', '.guardian-quarantine'].includes(basename(requestedRoot).toLowerCase())) throw new Error('Guardian system folders cannot be watched as image sources');
  if (rootInfo.isSymbolicLink()) throw new Error('The watched folder must not be a symbolic link: ' + requestedRoot);
  if (!rootInfo.isDirectory()) throw new Error('The watched path must be a directory: ' + requestedRoot);
  const root = await realpath(requestedRoot);
  const largeImageThresholdBytes = options.largeImageThresholdBytes ?? DEFAULT_LARGE_IMAGE_BYTES;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const queueLimit = options.queueLimit ?? DEFAULT_QUEUE_LIMIT;
  const reconcileMs = options.reconcileMs ?? DEFAULT_RECONCILE_MS;
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const stabilityMs = options.stabilityMs ?? DEFAULT_STABILITY_MS;
  if (!Number.isSafeInteger(largeImageThresholdBytes) || largeImageThresholdBytes < 1) throw new Error('largeImageThresholdBytes must be a positive safe integer');
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new Error('maxEntries must be a positive safe integer');
  if (!Number.isSafeInteger(queueLimit) || queueLimit < 1) throw new Error('queueLimit must be a positive safe integer');
  if (!Number.isSafeInteger(reconcileMs) || reconcileMs < 50) throw new Error('reconcileMs must be at least 50 milliseconds');
  if (!Number.isSafeInteger(debounceMs) || debounceMs < 0) throw new Error('debounceMs must be a non-negative safe integer');
  if (!Number.isSafeInteger(stabilityMs) || stabilityMs < 0) throw new Error('stabilityMs must be a non-negative safe integer');

  let closed = false;
  let mode: StudioWatchSnapshot['mode'] = 'watching';
  let watcher: FSWatcher | undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let reconcileTimer: ReturnType<typeof setInterval> | undefined;
  let refreshPromise: Promise<void> | undefined;
  let refreshAgain = false;
  let previousFiles = new Map<string, ObservedFile>();
  let snapshot: StudioWatchSnapshot = {
    enabled: true,
    mode,
    folder: basename(root),
    scannedAt: null,
    entriesScanned: 0,
    imageCount: 0,
    candidateCount: 0,
    newCount: 0,
    largeCount: 0,
    pendingCount: 0,
    partial: false,
    truncated: false,
    largeImageThresholdBytes,
    candidates: [],
    notice: null,
  };

  function scheduleRefresh(delay = debounceMs): void {
    if (closed) return;
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      void refresh(false);
    }, delay);
    debounceTimer.unref?.();
  }

  function watcherFailed(): void {
    if (closed) return;
    mode = 'polling';
    snapshot = {...snapshot, mode, notice: 'Live file events are unavailable. Guardian is checking this folder periodically.'};
    watcher?.close();
    watcher = undefined;
  }

  async function refresh(initial: boolean): Promise<void> {
    if (closed) return;
    if (refreshPromise) {
      refreshAgain = true;
      await refreshPromise;
      return;
    }

    refreshPromise = (async () => {
      const now = Date.now();
      const found = new Map<string, {path: string; bytes: number; mtimeMs: number}>();
      let entriesScanned = 0;
      let readErrors = 0;
      let entryLimitReached = false;

      async function walk(directory: string): Promise<void> {
        if (closed || entryLimitReached) return;
        let entries;
        try {
          entries = await readdir(directory, {withFileTypes: true});
        } catch {
          readErrors += 1;
          return;
        }
        entries.sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
          if (closed) return;
          entriesScanned += 1;
          if (entriesScanned > maxEntries) {
            entryLimitReached = true;
            return;
          }
          const fullPath = resolve(directory, entry.name);
          if (entry.isSymbolicLink() || (entry.isDirectory() && ignoredDirectories.has(entry.name))) continue;
          if (entry.isDirectory()) {
            await walk(fullPath);
            continue;
          }
          if (!entry.isFile() || !imageExtensions.has(extname(entry.name).toLowerCase())) continue;
          try {
            const info = await lstat(fullPath);
            if (!info.isFile() || info.isSymbolicLink()) continue;
            const path = relativePath(root, fullPath);
            if (path === '' || path.startsWith('../') || path.startsWith('/')) continue;
            found.set(path, {path, bytes: info.size, mtimeMs: info.mtimeMs});
          } catch {
            readErrors += 1;
          }
        }
      }

      try {
        await walk(root);
        if (closed) return;

        const nextFiles = new Map<string, ObservedFile>();
        for (const [path, file] of found) {
          const old = previousFiles.get(path);
          const changed = old !== undefined && (old.bytes !== file.bytes || old.mtimeMs !== file.mtimeMs);
          const isNew = old === undefined ? !initial : old.isNew || changed;
          const firstSeenAt = old === undefined || (changed && !old.isNew) ? now : old.firstSeenAt;
          const stableSince = old === undefined || changed ? now : old.stableSince;
          nextFiles.set(path, {...file, isNew, firstSeenAt, stableSince});
        }
        previousFiles = nextFiles;

        const allCandidates = [...nextFiles.values()]
          .filter((file) => file.isNew || file.bytes >= largeImageThresholdBytes)
          .map((file): StudioWatchCandidate => ({
            path: file.path,
            bytes: file.bytes,
            modifiedAt: new Date(file.mtimeMs).toISOString(),
            discoveredAt: file.isNew ? new Date(file.firstSeenAt).toISOString() : null,
            isNew: file.isNew,
            isLarge: file.bytes >= largeImageThresholdBytes,
            stable: !file.isNew || now - file.stableSince >= stabilityMs,
          }))
          .sort((left, right) =>
            Number(right.isNew) - Number(left.isNew)
            || (right.discoveredAt ?? '').localeCompare(left.discoveredAt ?? '')
            || right.bytes - left.bytes
            || left.path.localeCompare(right.path));

        const newCount = allCandidates.filter((candidate) => candidate.isNew).length;
        const largeCount = allCandidates.filter((candidate) => candidate.isLarge).length;
        const pendingCount = allCandidates.filter((candidate) => candidate.isNew && !candidate.stable).length;
        snapshot = {
          enabled: true,
          mode,
          folder: basename(root),
          scannedAt: new Date(now).toISOString(),
          entriesScanned,
          imageCount: nextFiles.size,
          candidateCount: allCandidates.length,
          newCount,
          largeCount,
          pendingCount,
          partial: readErrors > 0 || entryLimitReached,
          truncated: allCandidates.length > queueLimit,
          largeImageThresholdBytes,
          candidates: allCandidates.slice(0, queueLimit),
          notice: readErrors > 0
            ? 'Some folder entries could not be read. Coverage is partial.'
            : entryLimitReached
              ? 'The ' + maxEntries.toLocaleString('en') + ' entry limit was reached. Coverage is partial.'
              : mode === 'polling'
                ? 'Live file events are unavailable. Guardian is checking this folder periodically.'
                : null,
        };

        if (!initial && pendingCount > 0) scheduleRefresh(Math.max(1_000, stabilityMs));
      } catch {
        snapshot = {...snapshot, mode, partial: true, notice: 'Guardian could not refresh this folder. Check local folder access.'};
      }
    })();

    try {
      await refreshPromise;
    } finally {
      refreshPromise = undefined;
      if (refreshAgain && !closed) {
        refreshAgain = false;
        void refresh(false);
      }
    }
  }

  try {
    watcher = watchPath(root, {recursive: true}, () => scheduleRefresh());
    watcher.on('error', watcherFailed);
  } catch {
    mode = 'polling';
    snapshot = {...snapshot, mode, notice: 'Live file events are unavailable. Guardian is checking this folder periodically.'};
  }

  reconcileTimer = setInterval(() => void refresh(false), reconcileMs);
  reconcileTimer.unref?.();
  await refresh(true);

  return {
    getSnapshot(): StudioWatchSnapshot {
      return {...snapshot, candidates: snapshot.candidates.map((candidate) => ({...candidate}))};
    },
    close(): void {
      if (closed) return;
      closed = true;
      if (debounceTimer !== undefined) clearTimeout(debounceTimer);
      if (reconcileTimer !== undefined) clearInterval(reconcileTimer);
      watcher?.close();
      watcher = undefined;
    },
  };
}
