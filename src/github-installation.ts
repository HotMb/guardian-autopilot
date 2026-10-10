type Options = {
  installationId: number;
  repositoryId: number;
  createJwt: () => string;
  fetch?: typeof globalThis.fetch;
};

const permissions = {contents: 'read', metadata: 'read', pull_requests: 'read', checks: 'read'} as const;

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('GitHub response is invalid');
  return value as Record<string, unknown>;
}

/** One-repository metadata access; credentials are never returned to callers. */
export class GitHubInstallationClient {
  private readonly request: typeof globalThis.fetch;

  constructor(private readonly options: Options) {
    for (const id of [options.installationId, options.repositoryId]) {
      if (!Number.isSafeInteger(id) || id <= 0) throw new Error('GitHub identifiers must be positive safe integers');
    }
    this.request = options.fetch ?? globalThis.fetch;
  }

  private async json(path: string, token: string, body?: unknown): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.request(`https://api.github.com${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: {Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'guardian-autopilot', 'Content-Type': 'application/json'},
        ...(body === undefined ? {} : {body: JSON.stringify(body)}),
      });
    } catch { throw new Error('GitHub request could not complete'); }
    if (!response.ok) throw new Error(`GitHub request failed (${response.status})`);
    try { return object(await response.json()); } catch { throw new Error('GitHub response is invalid'); }
  }

  async getRepository(owner: string, name: string): Promise<{id: number; fullName: string; defaultBranch: string; private: boolean}> {
    if (!/^[A-Za-z0-9-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(name) || name === '.' || name === '..') throw new Error('GitHub repository name is invalid');
    const grant = await this.json(`/app/installations/${this.options.installationId}/access_tokens`, this.options.createJwt(), {
      repository_ids: [this.options.repositoryId], permissions,
    });
    const grantedPermissions = object(grant.permissions);
    if (Object.entries(grantedPermissions).some(([key, value]) => !(key in permissions) || value !== 'read') || grantedPermissions.contents !== 'read' || grantedPermissions.metadata !== 'read') {
      throw new Error('GitHub installation token must be read-only');
    }
    if (!Array.isArray(grant.repositories) || grant.repositories.length !== 1 || object(grant.repositories[0]).id !== this.options.repositoryId) throw new Error('GitHub token repository scope is invalid');
    if (typeof grant.token !== 'string' || grant.token.trim() === '') throw new Error('GitHub installation token is missing');
    const repository = await this.json(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, grant.token);
    if (repository.id !== this.options.repositoryId || typeof repository.full_name !== 'string' || repository.full_name.toLowerCase() !== `${owner}/${name}`.toLowerCase() || typeof repository.default_branch !== 'string' || repository.default_branch === '' || typeof repository.private !== 'boolean') throw new Error('GitHub repository response does not match the authorized repository');
    return {id: this.options.repositoryId, fullName: repository.full_name, defaultBranch: repository.default_branch, private: repository.private};
  }
}
