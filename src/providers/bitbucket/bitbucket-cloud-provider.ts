import * as fs from 'node:fs';
import { Agent } from 'undici';
import type { NewThreadPosition, ReviewProvider } from '../provider.js';
import type {
  CommentOrigin,
  DiffPosition,
  DiffRefs,
  ReviewComment,
  ReviewTarget,
  ReviewTargetRef,
  ReviewThread,
  ReviewVersion,
} from '../../core/types.js';
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
  readonly supportsDirectCommitFetch = false;
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
    const diffRefs = await this.expandDiffRefs(ref.repository, pr);
    return this.mapPullRequest(ref.repository, pr, diffRefs);
  }

  async listUnresolvedThreads(ref: ReviewTargetRef): Promise<ReviewThread[]> {
    const all = await this.listAllThreads(ref);
    return all.filter((thread) => thread.resolvable && !thread.resolved);
  }

  async listAllThreads(ref: ReviewTargetRef): Promise<ReviewThread[]> {
    const comments = await this.requestPaginated<BitbucketComment>(
      `${this.repoPath(ref.repository)}/pullrequests/${ref.targetId}/comments`,
      { pagelen: '100' },
    );
    return this.mapReviewThreads(ref, comments);
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
      },
    ];
  }

  async postReply(ref: ReviewTargetRef, threadId: string, body: string): Promise<void> {
    await this.createComment(ref, {
      content: { raw: body },
      parent: { id: Number(threadId) },
    });
  }

  async resolveThread(ref: ReviewTargetRef, threadId: string): Promise<void> {
    await this.request(`${this.commentPath(ref, threadId)}/resolve`, { method: 'POST' });
  }

  async updateDescription(ref: ReviewTargetRef, body: string): Promise<void> {
    await this.request(`${this.repoPath(ref.repository)}/pullrequests/${ref.targetId}`, {
      method: 'PUT',
      body: { description: body },
    });
  }

  async createThread(ref: ReviewTargetRef, body: string, position?: NewThreadPosition): Promise<string> {
    const payload: BitbucketCommentCreatePayload = { content: { raw: body } };
    if (position) {
      const inline = this.buildInlinePosition(position);
      if (inline) payload.inline = inline;
    }
    const comment = await this.createComment(ref, payload);
    return String(comment.id);
  }

  async createNote(ref: ReviewTargetRef, body: string, _options?: { internal?: boolean }): Promise<string> {
    const comment = await this.createComment(ref, { content: { raw: body } });
    return String(comment.id);
  }

  async updateNote(ref: ReviewTargetRef, noteId: string, body: string): Promise<void> {
    await this.request(this.commentPath(ref, noteId), {
      method: 'PUT',
      body: { content: { raw: body } },
    });
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
        ? ` (${this.redact(String((cause as NodeJS.ErrnoException).cause))})`
        : '';
      throw new ProviderError(
        `Network error reaching ${new URL(url).hostname}${detail}: ${this.redact(cause.message)}`,
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
          ? ` (${this.redact(String((cause as NodeJS.ErrnoException).cause))})`
          : '';
        throw new ProviderError(
          `Network error reaching ${new URL(nextUrl).hostname}${detail}: ${this.redact(cause.message)}`,
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
      throw new ProviderError(this.notFoundMessage(text), 'bitbucket-cloud', res.status);
    }

    if (res.status === 400) {
      const text = await res.text().catch(() => '');
      throw new ProviderError(
        `Bitbucket Cloud rejected the request (400). Check pull request comment fields and inline anchors. ${this.redact(text)}`.trim(),
        'bitbucket-cloud',
        res.status,
      );
    }

    if (res.status === 409) {
      const text = await res.text().catch(() => '');
      throw new ProviderError(
        `Bitbucket Cloud could not apply the requested state change (409). The comment thread may already be resolved or otherwise conflict with the current pull request state. ${this.redact(text)}`.trim(),
        'bitbucket-cloud',
        res.status,
      );
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ProviderError(
        `Bitbucket Cloud API error: ${res.status} ${res.statusText} — ${this.redact(text)}`,
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

  private commentsPath(ref: ReviewTargetRef): string {
    return `${this.repoPath(ref.repository)}/pullrequests/${ref.targetId}/comments`;
  }

  private commentPath(ref: ReviewTargetRef, commentId: string): string {
    return `${this.commentsPath(ref)}/${encodeURIComponent(commentId)}`;
  }

  private async createComment(ref: ReviewTargetRef, payload: BitbucketCommentCreatePayload): Promise<BitbucketComment> {
    return this.request<BitbucketComment>(this.commentsPath(ref), {
      method: 'POST',
      body: payload,
    });
  }

  private buildInlinePosition(position: NewThreadPosition): BitbucketInlinePosition | undefined {
    if (position.oldLine == null && position.newLine == null) return undefined;
    const isOldSide = position.oldLine != null && position.newLine == null;
    return isOldSide
      ? { path: position.oldPath, from: position.oldLine }
      : { path: position.newPath, to: position.newLine };
  }

  private notFoundMessage(text: string): string {
    return (
      'Bitbucket Cloud resource not found or inaccessible (404). Check repository access, pull request id, comment id, and inline anchor paths. ' +
      this.redact(text)
    ).trim();
  }

  private redact(value: string): string {
    const basicToken = Buffer.from(`${this.email}:${this.token}`, 'utf8').toString('base64');
    return value
      .split(this.email)
      .join('[REDACTED_EMAIL]')
      .split(this.token)
      .join('[REDACTED_TOKEN]')
      .split(basicToken)
      .join('[REDACTED_BASIC_AUTH]');
  }

  private mapPullRequest(repo: string, pr: BitbucketPullRequest, diffRefs = this.mapDiffRefs(pr)): ReviewTarget {
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
      diffRefs,
      ...(isFork ? { headRepository: sourceRepository } : {}),
    };
  }

  private async expandDiffRefs(repo: string, pr: BitbucketPullRequest): Promise<DiffRefs> {
    const diffRefs = this.mapDiffRefs(pr);
    const sourceRepo = pr.source?.repository?.full_name ?? repo;
    const destinationRepo = pr.destination?.repository?.full_name ?? repo;
    const [baseSha, headSha] = await Promise.all([
      this.expandCommitHash(destinationRepo, diffRefs.baseSha),
      this.expandCommitHash(sourceRepo, diffRefs.headSha),
    ]);

    return {
      baseSha,
      headSha,
      startSha: baseSha,
    };
  }

  private async expandCommitHash(repo: string, hash: string): Promise<string> {
    if (!isAbbreviatedSha(hash)) return hash;
    const commit = await this.request<BitbucketCommit>(`${this.repoPath(repo)}/commit/${hash}`);
    return commit.hash || hash;
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

  private mapReviewThreads(ref: ReviewTargetRef, comments: BitbucketComment[]): ReviewThread[] {
    const topLevel = new Map<number, BitbucketComment>();
    for (const comment of comments) {
      if (!this.isVisibleComment(comment) || comment.parent) continue;
      topLevel.set(comment.id, comment);
    }

    const replies = new Map<number, BitbucketComment[]>();
    for (const comment of comments) {
      if (!this.isVisibleComment(comment) || !comment.parent) continue;
      const parentId = comment.parent.id;
      if (!topLevel.has(parentId)) continue;
      const parentReplies = replies.get(parentId) ?? [];
      parentReplies.push(comment);
      replies.set(parentId, parentReplies);
    }

    return [...topLevel.values()].map((comment): ReviewThread => {
      const threadComments = [comment, ...(replies.get(comment.id) ?? [])];
      return {
        provider: 'bitbucket-cloud',
        targetRef: ref,
        threadId: String(comment.id),
        resolved: comment.resolution != null,
        resolvable: true,
        position: this.mapCommentPosition(comment),
        comments: threadComments.map((threadComment) => this.mapReviewComment(threadComment)),
      };
    });
  }

  private isVisibleComment(comment: BitbucketComment): boolean {
    return !comment.deleted && !comment.pending;
  }

  private mapCommentPosition(comment: BitbucketComment): DiffPosition | undefined {
    const inline = comment.inline;
    if (!inline?.path) return undefined;

    return {
      filePath: inline.path,
      oldLine: inline.from ?? undefined,
      newLine: inline.to ?? undefined,
      oldPath: inline.path,
      newPath: inline.path,
    };
  }

  private mapReviewComment(comment: BitbucketComment): ReviewComment {
    const body = this.commentBody(comment);
    return {
      id: String(comment.id),
      body,
      author: comment.user?.nickname ?? comment.user?.display_name ?? comment.user?.account_id ?? 'unknown',
      createdAt: comment.created_on,
      updatedAt: comment.updated_on,
      origin: this.detectOrigin(body, comment.user),
      system: false,
    };
  }

  private commentBody(comment: BitbucketComment): string {
    return comment.content?.raw ?? '';
  }

  private detectOrigin(body: string, user?: BitbucketUser | null): CommentOrigin {
    if (body.startsWith('<!-- revpack')) return 'bot';
    if (body.includes('Generated by [revpack]')) return 'bot';
    const normalized = [user?.nickname, user?.display_name, user?.account_id].filter(Boolean).join(' ').toLowerCase();
    if (normalized.includes('[bot]') || normalized.includes('bot')) return 'bot';
    return 'human';
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

interface BitbucketCommit {
  hash?: string;
}

interface BitbucketComment {
  id: number;
  content?: {
    raw?: string | null;
    markup?: string | null;
    html?: string | null;
  } | null;
  user?: BitbucketUser | null;
  created_on: string;
  updated_on: string;
  deleted?: boolean | null;
  pending?: boolean | null;
  parent?: { id: number } | null;
  inline?: {
    path?: string | null;
    from?: number | null;
    to?: number | null;
  } | null;
  resolution?: unknown;
}

interface BitbucketCommentCreatePayload {
  content: { raw: string };
  parent?: { id: number };
  inline?: BitbucketInlinePosition;
}

interface BitbucketInlinePosition {
  path: string;
  from?: number;
  to?: number;
}

interface BitbucketUser {
  display_name?: string | null;
  nickname?: string | null;
  account_id?: string | null;
}

function isAbbreviatedSha(hash: string): boolean {
  return /^[0-9a-f]{7,39}$/i.test(hash);
}
