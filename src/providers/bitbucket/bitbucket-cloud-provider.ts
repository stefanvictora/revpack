import * as fs from 'node:fs';
import { Agent } from 'undici';
import type { NewThreadPosition, ReviewProvider } from '../provider.js';
import type { DiffRefs, ReviewTarget, ReviewTargetRef, ReviewThread, ReviewVersion } from '../../core/types.js';
import { AuthenticationError, ProviderError } from '../../core/errors.js';

interface BitbucketRequestOptions {
  method?: string;
  body?: unknown;
  params?: Record<string, string>;
}

interface BitbucketCloudProviderOptions {
  caFile?: string;
  tlsVerify?: boolean;
  sshClone?: boolean;
}

export class BitbucketCloudProvider implements ReviewProvider {
  readonly providerType = 'bitbucket-cloud' as const;
  private readonly apiBaseUrl = 'https://api.bitbucket.org/2.0';
  private readonly webBaseUrl = 'https://bitbucket.org';
  private readonly email: string;
  private readonly token: string;
  private readonly fetchDispatcher: object | undefined;
  private readonly sshClone: boolean;

  constructor(email: string, token: string, opts: BitbucketCloudProviderOptions = {}) {
    this.email = email;
    this.token = token;
    this.fetchDispatcher = buildDispatcher(opts);
    this.sshClone = opts.sshClone ?? false;
  }

  resolveTarget(ref: string): ReviewTargetRef {
    const cloudUrlMatch = ref.match(
      /^https?:\/\/bitbucket\.org\/([^/?#]+\/[^/?#]+)\/pull-requests\/(\d+)\/?(?:[?#].*)?$/,
    );
    if (cloudUrlMatch) {
      return {
        provider: 'bitbucket-cloud',
        repository: cloudUrlMatch[1],
        targetType: 'pull_request',
        targetId: cloudUrlMatch[2],
      };
    }

    if (/^https?:\/\/[^/]+\/.*\/pull-requests\/\d+(?:\/[^?#]*)?(?:[?#].*)?$/.test(ref)) {
      throw new ProviderError(
        'Bitbucket Server/Data Center pull request URLs are not supported by provider "bitbucket-cloud". Use a Bitbucket Cloud URL like https://bitbucket.org/workspace/repo/pull-requests/123.',
        'bitbucket-cloud',
      );
    }

    const repoHashMatch = ref.match(/^([^/]+\/[^/]+)#(\d+)$/);
    if (repoHashMatch) {
      return {
        provider: 'bitbucket-cloud',
        repository: repoHashMatch[1],
        targetType: 'pull_request',
        targetId: repoHashMatch[2],
      };
    }

    const repoPullPathMatch = ref.match(/^([^/]+\/[^/]+)\/pull-requests\/(\d+)$/);
    if (repoPullPathMatch) {
      return {
        provider: 'bitbucket-cloud',
        repository: repoPullPathMatch[1],
        targetType: 'pull_request',
        targetId: repoPullPathMatch[2],
      };
    }

    const numMatch = ref.match(/^#?(\d+)$/);
    if (numMatch) {
      return {
        provider: 'bitbucket-cloud',
        repository: '',
        targetType: 'pull_request',
        targetId: numMatch[1],
      };
    }

    throw new ProviderError(`Cannot parse Bitbucket Cloud target reference: ${ref}`, 'bitbucket-cloud');
  }

  async listOpenReviewTargets(repo: string): Promise<ReviewTarget[]> {
    const data = await this.requestPaginated<BitbucketPullRequest>(`${this.repoPath(repo)}/pullrequests`, {
      state: 'OPEN',
      pagelen: '50',
    });
    return data.map((pr) => this.mapPullRequest(repo, pr));
  }

  async findTargetByBranch(repo: string, branchName: string): Promise<ReviewTarget[]> {
    const data = await this.requestPaginated<BitbucketPullRequest>(`${this.repoPath(repo)}/pullrequests`, {
      state: 'OPEN',
      q: `source.branch.name="${branchName.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
      pagelen: '50',
    });
    return data.map((pr) => this.mapPullRequest(repo, pr));
  }

  async getTargetSnapshot(ref: ReviewTargetRef): Promise<ReviewTarget> {
    const pr = await this.request<BitbucketPullRequest>(
      `${this.repoPath(ref.repository)}/pullrequests/${ref.targetId}`,
    );
    return this.mapPullRequest(ref.repository, pr);
  }

  listUnresolvedThreads(_ref: ReviewTargetRef): Promise<ReviewThread[]> {
    return Promise.resolve([]);
  }

  listAllThreads(_ref: ReviewTargetRef): Promise<ReviewThread[]> {
    return Promise.resolve([]);
  }

  async getDiffVersions(ref: ReviewTargetRef): Promise<ReviewVersion[]> {
    const target = await this.getTargetSnapshot(ref);
    return [
      {
        provider: 'bitbucket-cloud',
        targetRef: ref,
        versionId: target.diffRefs.headSha,
        headCommitSha: target.diffRefs.headSha,
        baseCommitSha: target.diffRefs.baseSha,
        startCommitSha: target.diffRefs.startSha,
        createdAt: target.updatedAt,
        realSize: 0,
      },
    ];
  }

  postReply(_ref: ReviewTargetRef, _threadId: string, _body: string): Promise<void> {
    return Promise.reject(this.unsupported('reply publishing'));
  }

  resolveThread(_ref: ReviewTargetRef, _threadId: string): Promise<void> {
    return Promise.reject(this.unsupported('thread resolution'));
  }

  async updateDescription(ref: ReviewTargetRef, body: string): Promise<void> {
    await this.request(`${this.repoPath(ref.repository)}/pullrequests/${ref.targetId}`, {
      method: 'PUT',
      body: { description: body },
    });
  }

  createThread(_ref: ReviewTargetRef, _body: string, _position?: NewThreadPosition): Promise<string> {
    return Promise.reject(this.unsupported('inline review comments'));
  }

  findNoteByMarker(_ref: ReviewTargetRef, _marker: string): Promise<{ id: string; body: string } | null> {
    return Promise.resolve(null);
  }

  createNote(_ref: ReviewTargetRef, _body: string, _options?: { internal?: boolean }): Promise<string> {
    return Promise.reject(this.unsupported('review notes'));
  }

  updateNote(_ref: ReviewTargetRef, _noteId: string, _body: string): Promise<void> {
    return Promise.reject(this.unsupported('review notes'));
  }

  getCloneUrl(repo: string): string {
    return this.sshClone ? `git@bitbucket.org:${repo}.git` : `${this.webBaseUrl}/${repo}.git`;
  }

  private async request<T>(path: string, options?: BitbucketRequestOptions): Promise<T> {
    const url = this.buildApiUrl(path, options?.params);

    let res: Response;
    try {
      res = await fetch(url, {
        method: options?.method ?? 'GET',
        headers: this.headers(),
        body: options?.body ? JSON.stringify(options.body) : undefined,
        ...(this.fetchDispatcher ? { dispatcher: this.fetchDispatcher } : {}),
      } as RequestInit);
    } catch (err) {
      const cause = err instanceof Error ? err : new Error(String(err));
      const detail = (cause as NodeJS.ErrnoException).cause
        ? ` (${String((cause as NodeJS.ErrnoException).cause)})`
        : '';
      throw new ProviderError(
        `Network error reaching ${new URL(url).hostname}${detail}: ${cause.message}`,
        'bitbucket-cloud',
      );
    }

    await this.ensureOk(res);
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  private async requestPaginated<T>(path: string, params?: Record<string, string>): Promise<T[]> {
    const results: T[] = [];
    let nextUrl: string | null = this.buildApiUrl(path, params);

    while (nextUrl) {
      let res: Response;
      try {
        res = await fetch(nextUrl, {
          headers: this.headers(),
          ...(this.fetchDispatcher ? { dispatcher: this.fetchDispatcher } : {}),
        } as RequestInit);
      } catch (err) {
        const cause = err instanceof Error ? err : new Error(String(err));
        const detail = (cause as NodeJS.ErrnoException).cause
          ? ` (${String((cause as NodeJS.ErrnoException).cause)})`
          : '';
        throw new ProviderError(
          `Network error reaching ${new URL(nextUrl).hostname}${detail}: ${cause.message}`,
          'bitbucket-cloud',
        );
      }

      await this.ensureOk(res);
      const page = (await res.json()) as BitbucketPage<T>;
      results.push(...(page.values ?? []));
      nextUrl = page.next ?? null;
    }

    return results;
  }

  private headers(): Record<string, string> {
    return {
      Accept: 'application/json',
      Authorization: `Basic ${Buffer.from(`${this.email}:${this.token}`, 'utf8').toString('base64')}`,
      'Content-Type': 'application/json',
    };
  }

  private async ensureOk(res: Response): Promise<void> {
    if (res.status === 401) {
      throw new AuthenticationError('Bitbucket Cloud authentication failed (401)', 'bitbucket-cloud');
    }

    if (res.status === 403) {
      throw new ProviderError(
        'Bitbucket Cloud access forbidden (403). Check repository permissions and token scopes.',
        'bitbucket-cloud',
        res.status,
      );
    }

    if (res.status === 404) {
      const text = await res.text().catch(() => '');
      throw new ProviderError(
        `Bitbucket Cloud resource not found or inaccessible (404). Check repository access and pull request id. ${text}`.trim(),
        'bitbucket-cloud',
        res.status,
      );
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ProviderError(
        `Bitbucket Cloud API error: ${res.status} ${res.statusText} — ${text}`,
        'bitbucket-cloud',
        res.status,
      );
    }
  }

  private buildApiUrl(path: string, params?: Record<string, string>): string {
    const url = new URL(`${this.apiBaseUrl}/${path.replace(/^\/+/, '')}`);
    for (const [key, value] of Object.entries(params ?? {})) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }

  private repoPath(repo: string): string {
    const { workspace, slug } = splitRepository(repo);
    return `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(slug)}`;
  }

  private mapPullRequest(repo: string, pr: BitbucketPullRequest): ReviewTarget {
    const sourceRepository = pr.source?.repository?.full_name;
    const isFork = sourceRepository != null && sourceRepository !== repo;

    return {
      provider: 'bitbucket-cloud',
      repository: repo,
      targetType: 'pull_request',
      targetId: String(pr.id),
      title: pr.title,
      description: pr.description ?? pr.summary?.raw ?? '',
      author: pr.author?.nickname ?? pr.author?.display_name ?? pr.author?.account_id ?? 'unknown',
      state: pr.state,
      sourceBranch: pr.source?.branch?.name ?? '',
      targetBranch: pr.destination?.branch?.name ?? '',
      webUrl: pr.links?.html?.href ?? `${this.webBaseUrl}/${repo}/pull-requests/${pr.id}`,
      createdAt: pr.created_on,
      updatedAt: pr.updated_on,
      labels: [],
      diffRefs: this.mapDiffRefs(pr),
      ...(isFork ? { headRepository: sourceRepository } : {}),
    };
  }

  private mapDiffRefs(pr: BitbucketPullRequest): DiffRefs {
    const baseSha = pr.destination?.commit?.hash ?? '';
    const headSha = pr.source?.commit?.hash ?? '';
    return {
      baseSha,
      headSha,
      startSha: baseSha,
    };
  }

  private unsupported(feature: string): ProviderError {
    return new ProviderError(`Bitbucket Cloud ${feature} is not supported yet.`, 'bitbucket-cloud');
  }
}

function splitRepository(repository: string): { workspace: string; slug: string } {
  const parts = repository.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new ProviderError(`Invalid Bitbucket Cloud repository slug: ${repository}`, 'bitbucket-cloud');
  }
  return { workspace: parts[0], slug: parts[1] };
}

function buildDispatcher(opts: BitbucketCloudProviderOptions): object | undefined {
  if (!opts.caFile && opts.tlsVerify !== false) return undefined;

  const connectOptions: Record<string, unknown> = {};
  if (opts.caFile) {
    connectOptions['ca'] = fs.readFileSync(opts.caFile);
  }
  if (opts.tlsVerify === false) {
    connectOptions['rejectUnauthorized'] = false;
  }

  return new Agent({ connect: connectOptions });
}

interface BitbucketPage<T> {
  values?: T[];
  next?: string;
}

interface BitbucketPullRequest {
  id: number;
  title: string;
  description?: string | null;
  summary?: { raw?: string | null } | null;
  state: string;
  author?: {
    display_name?: string | null;
    nickname?: string | null;
    account_id?: string | null;
  } | null;
  source?: BitbucketPullRequestEndpoint | null;
  destination?: BitbucketPullRequestEndpoint | null;
  links?: {
    html?: { href?: string | null } | null;
  } | null;
  created_on: string;
  updated_on: string;
}

interface BitbucketPullRequestEndpoint {
  branch?: { name?: string | null } | null;
  commit?: { hash?: string | null } | null;
  repository?: { full_name?: string | null } | null;
}
