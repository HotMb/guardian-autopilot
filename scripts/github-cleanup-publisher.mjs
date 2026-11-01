import {execFile} from 'node:child_process';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
import {WorktreeExecutor} from '@cleancode/core/executor';

const exec = promisify(execFile);
const hash = /^[a-f\d]{40}$/i;
const safePath = (value) => typeof value === 'string' && value.length <= 500 && value.length > 0
  && !/[\\:*?\[\]\x00-\x1f\x7f]/.test(value) && !value.startsWith('-')
  && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && !part.startsWith('-'));

async function git(target, ...args) {
  return (await exec('git', ['-C', target, ...args], {windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024})).stdout;
}

export async function publishCleanup(input) {
  const {candidate, checks, repository, branch, actor, runId, runAttempt, token} = input;
  const head = input.head?.toLowerCase();
  if (!safePath(candidate) || !safePath(checks) || candidate.toLowerCase() === checks.toLowerCase()
      || /^(?:\.git|\.github|\.guardian)(?:\/|$)/i.test(candidate)
      || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '')
      || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(actor ?? '')
      || !/^\d{1,20}$/.test(runId ?? '') || !/^\d{1,10}$/.test(runAttempt ?? '')
      || !hash.test(head ?? '') || typeof token !== 'string' || token.length === 0
      || typeof branch !== 'string' || branch.length === 0 || branch.length > 255
      || branch.startsWith('-') || /[\x00-\x20\x7f~^:?*\[\\]/.test(branch)) throw new Error('Invalid cleanup publication inputs');
  const target = resolve(input.target);
  await git(target, 'check-ref-format', '--branch', branch);
  if ((await git(target, 'status', '--porcelain=v1', '--untracked-files=all')).trim()) throw new Error('Checkout must be clean');
  if ((await git(target, 'rev-parse', 'HEAD')).trim().toLowerCase() !== head) throw new Error('Checkout does not match reviewed commit');
  const preview = await new WorktreeExecutor({rootDir: target}).previewDeletionExperiment([candidate]);
  if (preview.paths.length !== 1 || preview.paths[0] !== candidate) throw new Error('Candidate failed protection checks');
  const treeEntry = await git(target, 'ls-tree', '-z', head, '--', candidate);
  const match = /^(100644|100755) blob [a-f\d]{40}\t([^\0]+)\0$/i.exec(treeEntry);
  if (!match || match[2] !== candidate) throw new Error('Candidate must be a tracked regular file');

  const fetcher = input.fetch ?? globalThis.fetch;
  async function api(method, path, body) {
    let response;
    try {
      response = await fetcher(`https://api.github.com${path}`, {method, redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: {Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(body ? {'Content-Type': 'application/json'} : {})},
        ...(body ? {body: JSON.stringify(body)} : {})});
    } catch { throw new Error('GitHub request failed'); }
    if (!response.ok) throw new Error(`GitHub request failed (HTTP ${response.status})`);
    try { return await response.json(); } catch { throw new Error('Invalid GitHub response'); }
  }
  const repoPath = `/repos/${repository}`;
  async function checkBase() {
    const ref = await api('GET', `${repoPath}/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`);
    if (ref.object?.sha?.toLowerCase() !== head) throw new Error('Base branch changed since the experiment');
  }
  await checkBase();
  const original = await api('GET', `${repoPath}/git/commits/${head}`);
  if (original.sha?.toLowerCase() !== head || !hash.test(original.tree?.sha ?? '')) throw new Error('Invalid base commit');
  const user = await api('GET', `/users/${actor}`);
  if (user.type !== 'User' || user.login?.toLowerCase() !== actor.toLowerCase() || !Number.isSafeInteger(user.id) || user.id <= 0) throw new Error('Invalid initiating user');
  const tree = await api('POST', `${repoPath}/git/trees`, {base_tree: original.tree.sha, tree: [{path: candidate, mode: match[1], type: 'blob', sha: null}]});
  if (!hash.test(tree.sha ?? '')) throw new Error('Invalid proposed tree');
  const identity = {name: user.login, email: `${user.id}+${user.login}@users.noreply.github.com`};
  const commit = await api('POST', `${repoPath}/git/commits`, {message: 'Propose reviewed cleanup', tree: tree.sha, parents: [head], author: identity, committer: identity});
  if (!hash.test(commit.sha ?? '')) throw new Error('Invalid proposed commit');
  await checkBase();
  const cleanupBranch = `guardian/cleanup-${runId}-${runAttempt}`;
  await api('POST', `${repoPath}/git/refs`, {ref: `refs/heads/${cleanupBranch}`, sha: commit.sha});
  try {
    await checkBase();
    const pull = await api('POST', `${repoPath}/pulls`, {title: 'Review a Guardian cleanup', head: cleanupBranch, base: branch, draft: true,
      body: `Guardian prepared one deletion after the configured checks passed on commit ${head}.\n\nThis is a review experiment: passing checks do not establish that the file is unused. Review the diff, dynamic and external uses, and deployment checks before merging. No automatic merge is performed.`});
    const prefix = `https://github.com/${repository}/pull/`;
    if (typeof pull.html_url !== 'string' || !pull.html_url.startsWith(prefix) || !/^\d+$/.test(pull.html_url.slice(prefix.length))) throw new Error('Invalid pull request URL');
    return {url: pull.html_url, branch: cleanupBranch};
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : 'Publication failed'}; review branch ${cleanupBranch} may need manual cleanup`);
  }
}

async function main() {
  const env = process.env;
  const result = await publishCleanup({target: env.GUARDIAN_TARGET, candidate: env.GUARDIAN_CANDIDATE, checks: env.GUARDIAN_CHECKS,
    repository: env.GITHUB_REPOSITORY, branch: env.GITHUB_REF_NAME, head: env.GITHUB_SHA, actor: env.GITHUB_ACTOR,
    runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT, token: env.GH_TOKEN});
  console.log(`Draft pull request: ${result.url}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : 'Publication failed'); process.exitCode = 1; });
}
