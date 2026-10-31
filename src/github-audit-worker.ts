import type {ClaimedGitHubAuditJob, PostgresGitHubAuditQueue} from './github-audit-queue.js';

export type GitHubAuditProcessor = (
  job: ClaimedGitHubAuditJob,
  saveCheckRunId: (checkRunId: number) => Promise<void>,
) => Promise<void>;

export type GitHubAuditWorkerOptions = {
  pollIntervalMs?: number;
  log?: (message: string) => void;
};

export type GitHubAuditWorker = {close: () => Promise<void>};

/** Polls a durable queue serially so free web instances cannot lose acknowledged deliveries. */
export function startGitHubAuditWorker(
  queue: PostgresGitHubAuditQueue,
  processor: GitHubAuditProcessor,
  options: GitHubAuditWorkerOptions = {},
): GitHubAuditWorker {
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 100 || pollIntervalMs > 30_000) throw new Error('GitHub audit polling interval must be between 100 and 30000 ms');
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
      try {
        await processor(job, (checkRunId) => queue.setCheckRunId(job!.deliveryId, checkRunId));
        await queue.complete(job.deliveryId);
      } catch {
        try { await queue.fail(job.deliveryId, 'audit_processing_failed'); }
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
