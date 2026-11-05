import type {ClaimedGitHubAuditJob, PostgresGitHubAuditQueue} from './github-audit-queue.js';

export type GitHubAuditProcessor = (
  job: ClaimedGitHubAuditJob,
  saveCheckRunId: (checkRunId: number) => Promise<void>,
  ensureLease: () => Promise<void>,
) => Promise<void>;

export type GitHubAuditWorkerOptions = {
  pollIntervalMs?: number;
  leaseRenewIntervalMs?: number;
  log?: (message: string) => void;
};

export type GitHubAuditWorker = {close: () => Promise<void>};

/** Pause processing only; the signed webhook continues to persist incoming jobs. */
export function auditWorkerIsPaused(value: string | undefined): boolean {
  if (value === undefined || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error('GITHUB_AUDIT_WORKER_PAUSED must be true or false');
}

/** Polls a durable queue serially so free web instances cannot lose acknowledged deliveries. */
export function startGitHubAuditWorker(
  queue: PostgresGitHubAuditQueue,
  processor: GitHubAuditProcessor,
  options: GitHubAuditWorkerOptions = {},
): GitHubAuditWorker {
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 100 || pollIntervalMs > 30_000) throw new Error('GitHub audit polling interval must be between 100 and 30000 ms');
  const leaseRenewIntervalMs = options.leaseRenewIntervalMs ?? 120_000;
  if (!Number.isSafeInteger(leaseRenewIntervalMs) || leaseRenewIntervalMs < 100 || leaseRenewIntervalMs > 300_000) throw new Error('GitHub audit lease renewal interval must be between 100 and 300000 ms');
  const log = options.log ?? ((message) => console.error(message));
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let active: Promise<void> | undefined;
  let queueUnavailableLogged = false;

  const schedule = (): void => {
    if (!stopped) timer = setTimeout(() => { void run(); }, pollIntervalMs);
  };

  const run = async (): Promise<void> => {
    if (stopped) return;
    active = (async () => {
      let job: ClaimedGitHubAuditJob | undefined;
      try {
        job = await queue.claim();
      } catch {
        if (!queueUnavailableLogged) log('GitHub audit queue is temporarily unavailable.');
        queueUnavailableLogged = true;
        return;
      }
      queueUnavailableLogged = false;
      if (job === undefined) return;
      const currentJob = job;
      let leaseLost = false;
      let renewal = Promise.resolve();
      const renewTimer = setInterval(() => {
        renewal = renewal.then(async () => {
          if (leaseLost) return;
          try { await queue.renewLease(currentJob.deliveryId, currentJob.leaseToken); }
          catch { leaseLost = true; }
        });
      }, leaseRenewIntervalMs);
      try {
        await processor(currentJob, async (checkRunId) => {
          if (leaseLost) throw new Error('GitHub audit lease lost');
          await queue.setCheckRunId(currentJob.deliveryId, checkRunId, currentJob.leaseToken);
        }, async () => {
          if (leaseLost) throw new Error('GitHub audit lease lost');
          await queue.renewLease(currentJob.deliveryId, currentJob.leaseToken);
        });
        clearInterval(renewTimer);
        await renewal;
        if (leaseLost) throw new Error('GitHub audit lease lost');
        await queue.complete(currentJob.deliveryId, currentJob.leaseToken);
      } catch {
        clearInterval(renewTimer);
        await renewal;
        try { await queue.fail(currentJob.deliveryId, 'audit_processing_failed', currentJob.leaseToken); }
        catch { log('GitHub audit task could not be recorded for retry.'); }
        log('GitHub audit task failed; source content and provider error details were not logged.');
      }
    })();
    try { await active; }
    finally {
      active = undefined;
      schedule();
    }
  };

  void run();
  return {
    async close() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      await active;
    },
  };
}
