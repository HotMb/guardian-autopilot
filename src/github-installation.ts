type Options = {
  installationId: number;
  repositoryId: number;
  createJwt: () => string;
  fetch?: typeof globalThis.fetch;
};

const permissions = {contents: 'read', metadata: 'read', checks: 'write'} as const;
const commitShaPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

export type GitHubCheckConclusion = 'success' | 'failure' | 'neutral' | 'action_required';

export type GitHubCheckOutput = {
  conclusion: GitHubCheckConclusion;
  title: string;
  summary: string;
};

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('GitHub response is invalid');
  return value as Record<string, unknown>;
}

/** One-repository metadata access; credentials are never returned to callers. */
export class GitHubInstallationClient {
  private readonly request: typeof globalThis.fetch;
  private cachedToken?: {value: string; expiresAt: number};

  constructor(private readonly options: Options) {
    for (const id of [options.installationId, options.repositoryId]) {
      if (!Number.isSafeInteger(id) || id <= 0) throw new Error('GitHub identifiers must be positive safe integers');
    }
    this.request = options.fetch ?? globalThis.fetch;
  }

  private async json(path: string, token: string, options: {method?: 'GET' | 'POST' | 'PATCH'; body?: unknown} = {}): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.request(`https://api.github.com${path}`, {
        method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: {Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'guardian-autopilot', 'Content-Type': 'application/json'},
        ...(options.body === undefined ? {} : {body: JSON.stringify(options.body)}),
      });
    } catch { throw new Error('GitHub request could not complete'); }
    if (!response.ok) throw new Error(`GitHub request failed (${response.status})`);
    try { return object(await response.json()); } catch { throw new Error('GitHub response is invalid'); }
  }

  private async repositoryPath(owner: string, name: string): Promise<string> {
    if (!/^[A-Za-z0-9-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(name) || name === '.' || name === '..') throw new Error('GitHub repository name is invalid');
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  }

  private async accessToken(): Promise<string> {
    if (this.cachedToken !== undefined && this.cachedToken.expiresAt - Date.now() > 60_000) return this.cachedToken.value;
    const grant = await this.json(`/app/installations/${this.options.installationId}/access_tokens`, this.options.createJwt(), {
      method: 'POST',
      body: {repository_ids: [this.options.repositoryId], permissions},
    });
    const grantedPermissions = object(grant.permissions);
    if (Object.entries(grantedPermissions).some(([key, value]) => !(key in permissions) || value !== permissions[key as keyof typeof permissions])
      || grantedPermissions.contents !== 'read' || grantedPermissions.metadata !== 'read' || grantedPermissions.checks !== 'write') {
      throw new Error('GitHub installation token must grant only read access to contents/metadata and write access to Checks');
    }
    if (!Array.isArray(grant.repositories) || grant.repositories.length !== 1 || object(grant.repositories[0]).id !== this.options.repositoryId) throw new Error('GitHub token repository scope is invalid');
    if (typeof grant.token !== 'string' || grant.token.trim() === '') throw new Error('GitHub installation token is missing');
    if (typeof grant.expires_at !== 'string' || !Number.isFinite(Date.parse(grant.expires_at)) || Date.parse(grant.expires_at) <= Date.now()) throw new Error('GitHub installation token expiry is invalid');
    this.cachedToken = {value: grant.token, expiresAt: Date.parse(grant.expires_at)};
    return grant.token;
  }

  private validateCommitSha(commitSha: string): void {
    if (!commitShaPattern.test(commitSha)) throw new Error('GitHub commit SHA is invalid');
  }

  async getRepository(owner: string, name: string): Promise<{id: number; fullName: string; defaultBranch: string; private: boolean}> {
    const repository = await this.json(await this.repositoryPath(owner, name), await this.accessToken());
    if (repository.id !== this.options.repositoryId || typeof repository.full_name !== 'string' || repository.full_name.toLowerCase() !== `${owner}/${name}`.toLowerCase() || typeof repository.default_branch !== 'string' || repository.default_branch === '' || typeof repository.private !== 'boolean') throw new Error('GitHub repository response does not match the authorized repository');
    return {id: this.options.repositoryId, fullName: repository.full_name, defaultBranch: repository.default_branch, private: repository.private};
  }

  async createCheckRun(owner: string, name: string, commitSha: string, deliveryId: string): Promise<number> {
    this.validateCommitSha(commitSha);
    if (deliveryId.trim() === '' || deliveryId.length > 255) throw new Error('GitHub delivery id is invalid');
    const path = `${await this.repositoryPath(owner, name)}/commits/${commitSha}/check-runs?check_name=CleanCode%20audit&per_page=100`;
    const existing = await this.json(path, await this.accessToken());
    if (!Array.isArray(existing.check_runs)) throw new Error('GitHub Check Run list is invalid');
    for (const entry of existing.check_runs) {
      const check = object(entry);
      if (check.external_id === deliveryId && check.head_sha === commitSha && check.name === 'CleanCode audit') {
        if (typeof check.id !== 'number' || !Number.isSafeInteger(check.id) || check.id <= 0) throw new Error('GitHub Check Run id is invalid');
        return check.id;
      }
    }
    const result = await this.json(`${await this.repositoryPath(owner, name)}/check-runs`, await this.accessToken(), {
      method: 'POST',
      body: {name: 'CleanCode audit', head_sha: commitSha, status: 'in_progress', started_at: new Date().toISOString(), external_id: deliveryId},
    });
    const id = result.id;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) throw new Error('GitHub check run id is invalid');
    return id;
  }

  async completeCheckRun(owner: string, name: string, checkRunId: number, output: GitHubCheckOutput): Promise<void> {
    if (!Number.isSafeInteger(checkRunId) || checkRunId <= 0) throw new Error('GitHub check run id is invalid');
    if (output.title.trim() === '' || output.title.length > 255) throw new Error('GitHub check title is invalid');
    if (output.summary.trim() === '' || output.summary.length > 60_000) throw new Error('GitHub check summary is invalid');
    await this.json(`${await this.repositoryPath(owner, name)}/check-runs/${checkRunId}`, await this.accessToken(), {
      method: 'PATCH',
      body: {
        status: 'completed',
        conclusion: output.conclusion,
        completed_at: new Date().toISOString(),
        output: {title: output.title, summary: output.summary},
      },
    });
  }

  async downloadRepositoryArchive(owner: string, name: string, commitSha: string): Promise<Response> {
    this.validateCommitSha(commitSha);
    const path = await this.repositoryPath(owner, name);
    let response: Response;
    try {
      response = await this.request(`https://api.github.com${path}/tarball/${commitSha}`, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000),
        headers: {Accept: 'application/vnd.github+json', Authorization: `Bearer ${await this.accessToken()}`, 'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'guardian-autopilot'},
      });
    } catch { throw new Error('GitHub archive request could not complete'); }
    if (response.status !== 302) throw new Error(`GitHub archive request failed (${response.status})`);
    const location = response.headers.get('location');
    if (location === null) throw new Error('GitHub archive redirect is missing');
    let redirect: URL;
    try { redirect = new URL(location); } catch { throw new Error('GitHub archive redirect is invalid'); }
    const allowedArchivePaths = [
      `/${owner}/${name}/legacy.tar.gz/${commitSha}`,
      `/${owner}/${name}/tar.gz/${commitSha}`,
    ].map((value) => value.toLowerCase());
    if (redirect.protocol !== 'https:' || redirect.hostname !== 'codeload.github.com' || redirect.port !== '' || redirect.username !== '' || redirect.password !== '' || redirect.search !== '' || redirect.hash !== '' || !allowedArchivePaths.includes(redirect.pathname.toLowerCase())) {
      throw new Error('GitHub archive redirect is outside the authorized repository');
    }
    try {
      response = await this.request(redirect, {method: 'GET', redirect: 'error', signal: AbortSignal.timeout(60_000), headers: {'User-Agent': 'guardian-autopilot', Accept: 'application/x-gzip'}});
    } catch { throw new Error('GitHub archive download could not complete'); }
    if (!response.ok || response.body === null) throw new Error(`GitHub archive download failed (${response.status})`);
    return response;
  }
}
