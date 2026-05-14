import * as fs from 'node:fs';
import { Agent } from 'undici';
import type { ReviewProvider, NewThreadPosition } from '../provider.js';
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

interface GitHubRequestOptions {
  method?: string;
  body?: unknown;
  params?: Record<string, string>;
}

interface GitHubProviderOptions {
  caFile?: string;
  tlsVerify?: boolean;
  sshClone?: boolean;
}

interface GitHubEndpoints {
  apiBaseUrl: string;
  webBaseUrl: string;
  graphqlUrl: string;
}

export class GitHubProvider implements ReviewProvider {
  readonly providerType = 'github' as const;
  private readonly apiBaseUrl: string;
  private readonly webBaseUrl: string;
  private readonly graphqlUrl: string;
  private readonly token: string;
  private readonly fetchDispatcher: object | undefined;
  private readonly sshClone: boolean;

  constructor(githubUrl: string | undefined, token: string, opts: GitHubProviderOptions = {}) {
    const endpoints = normalizeGitHubEndpoints(githubUrl);
    this.apiBaseUrl = endpoints.apiBaseUrl;
    this.webBaseUrl = endpoints.webBaseUrl;
    this.graphqlUrl = endpoints.graphqlUrl;
    this.token = token;
    this.fetchDispatcher = buildDispatcher(opts);
    this.sshClone = opts.sshClone ?? false;
  }

  // ─── Target resolution ──────────────────────────────────

  resolveTarget(ref: string): ReviewTargetRef {
    const urlMatch = ref.match(/^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/(\d+)(?:[/?#].*)?$/);
    if (urlMatch) {
      return {
        provider: 'github',
        repository: urlMatch[1],
        targetType: 'pull_request',
        targetId: urlMatch[2],
      };
    }

    const repoHashMatch = ref.match(/^([^/]+\/[^/]+)#(\d+)$/);
    if (repoHashMatch) {
      return {
        provider: 'github',
        repository: repoHashMatch[1],
        targetType: 'pull_request',
        targetId: repoHashMatch[2],
      };
    }

    const repoPullPathMatch = ref.match(/^([^/]+\/[^/]+)\/pull\/(\d+)$/);
    if (repoPullPathMatch) {
      return {
        provider: 'github',
        repository: repoPullPathMatch[1],
        targetType: 'pull_request',
        targetId: repoPullPathMatch[2],
      };
    }

    const numMatch = ref.match(/^#?(\d+)$/);
    if (numMatch) {
      return {
        provider: 'github',
        repository: '',
        targetType: 'pull_request',
        targetId: numMatch[1],
      };
    }

    throw new ProviderError(`Cannot parse GitHub target reference: ${ref}`, 'github');
  }

  // ─── Read operations ────────────────────────────────────

  async listOpenReviewTargets(repo: string): Promise<ReviewTarget[]> {
    const data = await this.requestPaginated<GitHubPullRequest>(`${this.repoPath(repo)}/pulls`, {
      state: 'open',
      per_page: '50',
    });
    return data.map((pr) => this.mapPullRequest(repo, pr));
  }

  async findTargetByBranch(repo: string, branchName: string): Promise<ReviewTarget[]> {
    const data = await this.requestPaginated<GitHubPullRequest>(`${this.repoPath(repo)}/pulls`, {
      state: 'open',
      per_page: '100',
    });
    return data.filter((pr) => pr.head.ref === branchName).map((pr) => this.mapPullRequest(repo, pr));
  }

  async getTargetSnapshot(ref: ReviewTargetRef): Promise<ReviewTarget> {
    const pr = await this.request<GitHubPullRequest>(`${this.repoPath(ref.repository)}/pulls/${ref.targetId}`);
    return this.mapPullRequest(ref.repository, pr);
  }

  async listUnresolvedThreads(ref: ReviewTargetRef): Promise<ReviewThread[]> {
    const all = await this.listAllThreads(ref);
    return all.filter((t) => t.resolvable && !t.resolved);
  }

  async listAllThreads(ref: ReviewTargetRef): Promise<ReviewThread[]> {
    const { owner, name } = splitRepository(ref.repository);
    const threads: GitHubReviewThread[] = [];
    let after: string | null = null;
    let hasNextPage = true;

    while (hasNextPage) {
      const data: GitHubReviewThreadsQuery = await this.graphql<GitHubReviewThreadsQuery>(
        `query ReviewThreads($owner: String!, $name: String!, $number: Int!, $after: String) {
          repository(owner: $owner, name: $name) {
            pullRequest(number: $number) {
              reviewThreads(first: 100, after: $after) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  id
                  isResolved
                  isOutdated
                  path
                  line
                  startLine
                  diffSide
                  startDiffSide
                  comments(first: 100) {
                    nodes {
                      id
                      databaseId
                      body
                      author { login }
                      createdAt
                      updatedAt
                    }
                  }
                }
              }
            }
          }
        }`,
        { owner, name, number: Number(ref.targetId), after },
      );

      const page: GitHubReviewThreadsPage | undefined = data.repository?.pullRequest?.reviewThreads;
      if (!page) return threads.map((thread) => this.mapReviewThread(ref, thread));
      threads.push(...page.nodes);
      hasNextPage = page.pageInfo.hasNextPage;
      after = page.pageInfo.endCursor;
    }

    return threads.map((thread) => this.mapReviewThread(ref, thread));
  }

  async getDiffVersions(ref: ReviewTargetRef): Promise<ReviewVersion[]> {
    const pr = await this.request<GitHubPullRequest>(`${this.repoPath(ref.repository)}/pulls/${ref.targetId}`);
    return [this.mapVersion(ref, pr)];
  }

  // ─── Write operations ───────────────────────────────────

  async postReply(_ref: ReviewTargetRef, threadId: string, body: string): Promise<void> {
    await this.graphql<GitHubThreadReplyMutation>(
      `mutation AddThreadReply($threadId: ID!, $body: String!) {
        addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
          comment { id }
        }
      }`,
      { threadId, body },
    );
  }

  async resolveThread(_ref: ReviewTargetRef, threadId: string): Promise<void> {
    await this.graphql<GitHubResolveThreadMutation>(
      `mutation ResolveThread($threadId: ID!) {
        resolveReviewThread(input: { threadId: $threadId }) {
          thread { id isResolved }
        }
      }`,
      { threadId },
    );
  }

  async updateDescription(ref: ReviewTargetRef, body: string): Promise<void> {
    await this.request(`${this.repoPath(ref.repository)}/pulls/${ref.targetId}`, {
      method: 'PATCH',
      body: { body },
    });
  }

  async createThread(ref: ReviewTargetRef, body: string, position?: NewThreadPosition): Promise<string> {
    if (!position) {
      return this.createNote(ref, body);
    }

    const pullRequestId = await this.getPullRequestNodeId(ref);
    const input = this.buildThreadInput(pullRequestId, body, position);

    try {
      const data = await this.graphql<GitHubCreateThreadMutation>(
        `mutation AddThread($input: AddPullRequestReviewThreadInput!) {
          addPullRequestReviewThread(input: $input) {
            thread { id }
          }
        }`,
        { input },
      );
      return data.addPullRequestReviewThread.thread.id;
    } catch (err) {
      if (!isValidationError(err)) throw err;
      const displayPath = position.newPath || position.oldPath;
      const anchor = `📌 \`${displayPath}:${position.newLine ?? position.oldLine}\`\n\n`;
      return this.createNote(ref, anchor + body);
    }
  }

  async findNoteByMarker(ref: ReviewTargetRef, marker: string): Promise<{ id: string; body: string } | null> {
    const notes = await this.requestPaginated<GitHubIssueComment>(
      `${this.repoPath(ref.repository)}/issues/${ref.targetId}/comments`,
    );
    const match = notes.find((note) => note.body.startsWith(marker));
    return match ? { id: String(match.id), body: match.body } : null;
  }

  async createNote(ref: ReviewTargetRef, body: string, _options?: { internal?: boolean }): Promise<string> {
    const note = await this.request<GitHubIssueComment>(
      `${this.repoPath(ref.repository)}/issues/${ref.targetId}/comments`,
      {
        method: 'POST',
        body: { body },
      },
    );
    return String(note.id);
  }

  async updateNote(ref: ReviewTargetRef, noteId: string, body: string): Promise<void> {
    await this.request(`${this.repoPath(ref.repository)}/issues/comments/${noteId}`, {
      method: 'PATCH',
      body: { body },
    });
  }

  getCloneUrl(repo: string): string {
    if (this.sshClone) {
      const host = new URL(this.webBaseUrl).hostname;
      return `git@${host}:${repo}.git`;
    }
    return `${this.webBaseUrl}/${repo}.git`;
  }

  /**
   * GitHub permanently keeps `refs/pull/<number>/head` in the base repository,
   * even after the source branch is deleted from the contributor's fork.
   * Using this refspec for checkout is always reliable.
   */
  getSourceRefspec(ref: ReviewTargetRef): string {
    return `refs/pull/${ref.targetId}/head`;
  }

  // ─── HTTP / GraphQL layer ───────────────────────────────

  private async request<T>(path: string, options?: GitHubRequestOptions): Promise<T> {
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
      throw new ProviderError(`Network error reaching ${new URL(url).hostname}${detail}: ${cause.message}`, 'github');
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
          'github',
        );
      }

      await this.ensureOk(res);
      const page = (await res.json()) as T[];
      results.push(...page);
      nextUrl = parseNextLink(res.headers.get('link'));
    }

    return results;
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.graphqlUrl, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ query, variables }),
        ...(this.fetchDispatcher ? { dispatcher: this.fetchDispatcher } : {}),
      } as RequestInit);
    } catch (err) {
      const cause = err instanceof Error ? err : new Error(String(err));
      const detail = (cause as NodeJS.ErrnoException).cause
        ? ` (${String((cause as NodeJS.ErrnoException).cause)})`
        : '';
      throw new ProviderError(
        `Network error reaching ${new URL(this.graphqlUrl).hostname}${detail}: ${cause.message}`,
        'github',
      );
    }

    await this.ensureOk(res);
    const payload = (await res.json()) as GitHubGraphQLResponse<T>;
    if (payload.errors?.length) {
      throw new ProviderError(`GitHub GraphQL error: ${payload.errors.map((e) => e.message).join('; ')}`, 'github');
    }
    if (!payload.data) {
      throw new ProviderError('GitHub GraphQL error: response did not include data', 'github');
    }
    return payload.data;
  }

  private headers(): Record<string, string> {
    return {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  private async ensureOk(res: Response): Promise<void> {
    if (res.status === 401 || res.status === 403) {
      throw new AuthenticationError(`GitHub authentication failed (${res.status})`, 'github');
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ProviderError(`GitHub API error: ${res.status} ${res.statusText} — ${text}`, 'github', res.status);
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
    const { owner, name } = splitRepository(repo);
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  }

  // ─── Mappers ────────────────────────────────────────────

  private mapPullRequest(repo: string, pr: GitHubPullRequest): ReviewTarget {
    // Detect fork PRs: head.repo differs from the base repository.
    const headRepoFullName = pr.head.repo?.full_name;
    const isFork = headRepoFullName != null && headRepoFullName !== repo;

    return {
      provider: 'github',
      repository: repo,
      targetType: 'pull_request',
      targetId: String(pr.number),
      title: pr.title,
      description: pr.body ?? '',
      author: pr.user?.login ?? 'unknown',
      state: pr.state,
      sourceBranch: pr.head.ref,
      targetBranch: pr.base.ref,
      webUrl: pr.html_url,
      createdAt: pr.created_at,
      updatedAt: pr.updated_at,
      labels: pr.labels?.map((label) => label.name) ?? [],
      diffRefs: this.mapDiffRefs(pr),
      ...(isFork ? { headRepository: headRepoFullName } : {}),
    };
  }

  private mapDiffRefs(pr: GitHubPullRequest): DiffRefs {
    return {
      baseSha: pr.base.sha,
      headSha: pr.head.sha,
      startSha: pr.base.sha,
    };
  }

  private mapReviewThread(ref: ReviewTargetRef, thread: GitHubReviewThread): ReviewThread {
    return {
      provider: 'github',
      targetRef: ref,
      threadId: thread.id,
      resolved: thread.isResolved,
      resolvable: true,
      resolvedBy: undefined,
      resolvedAt: undefined,
      position: this.mapThreadPosition(thread),
      comments: thread.comments.nodes.map((comment) => this.mapReviewComment(comment)),
    };
  }

  private mapThreadPosition(thread: GitHubReviewThread): DiffPosition | undefined {
    if (!thread.path) return undefined;
    const side = thread.diffSide ?? 'RIGHT';
    return {
      filePath: thread.path,
      oldLine: side === 'LEFT' ? (thread.line ?? undefined) : undefined,
      newLine: side === 'RIGHT' ? (thread.line ?? undefined) : undefined,
      oldPath: thread.path,
      newPath: thread.path,
    };
  }

  private mapReviewComment(comment: GitHubReviewComment): ReviewComment {
    return {
      id: String(comment.databaseId ?? comment.id),
      body: comment.body,
      author: comment.author?.login ?? 'unknown',
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      origin: this.detectOrigin(comment.body, comment.author?.login),
      system: false,
    };
  }

  private mapVersion(ref: ReviewTargetRef, pr: GitHubPullRequest): ReviewVersion {
    return {
      provider: 'github',
      targetRef: ref,
      versionId: pr.head.sha,
      headCommitSha: pr.head.sha,
      baseCommitSha: pr.base.sha,
      startCommitSha: pr.base.sha,
      createdAt: pr.updated_at,
      realSize: pr.changed_files ?? 0,
    };
  }

  private detectOrigin(body: string, login?: string): CommentOrigin {
    if (body.startsWith('<!-- revpack')) return 'bot';
    const normalized = login?.toLowerCase() ?? '';
    if (normalized.includes('[bot]') || normalized.includes('bot')) return 'bot';
    return 'human';
  }

  private async getPullRequestNodeId(ref: ReviewTargetRef): Promise<string> {
    const pr = await this.request<GitHubPullRequest>(`${this.repoPath(ref.repository)}/pulls/${ref.targetId}`);
    return pr.node_id;
  }

  private buildThreadInput(pullRequestId: string, body: string, position: NewThreadPosition): GitHubCreateThreadInput {
    const isLeftSide = position.oldLine != null && position.newLine == null;
    return {
      pullRequestId,
      body,
      path: isLeftSide ? position.oldPath : position.newPath,
      line: isLeftSide ? position.oldLine : position.newLine,
      side: isLeftSide ? 'LEFT' : 'RIGHT',
    };
  }

  /**
   * Submit a GitHub PR review batch with inline comments and an optional body.
   * Uses the REST API: POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews
   */
  async submitReview(
    ref: ReviewTargetRef,
    comments: Array<{ body: string; path: string; line?: number; side?: 'LEFT' | 'RIGHT' }>,
    body: string,
    event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES',
  ): Promise<void> {
    const payload: Record<string, unknown> = {
      event,
      comments: comments.map((c) => ({
        body: c.body,
        path: c.path,
        ...(c.line != null ? { line: c.line } : {}),
        ...(c.side ? { side: c.side } : {}),
      })),
    };
    if (body) {
      payload.body = body;
    }
    await this.request(`${this.repoPath(ref.repository)}/pulls/${ref.targetId}/reviews`, {
      method: 'POST',
      body: payload,
    });
  }
}

// ─── GitHub API response types (internal) ─────────────────

interface GitHubPullRequest {
  node_id: string;
  number: number;
  title: string;
  body?: string | null;
  state: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  changed_files?: number;
  labels?: { name: string }[];
  user?: GitHubUser | null;
  head: { ref: string; sha: string; repo?: { full_name: string; clone_url: string; ssh_url: string } | null };
  base: { ref: string; sha: string };
}

interface GitHubUser {
  login: string;
}

interface GitHubIssueComment {
  id: number;
  body: string;
}

interface GitHubGraphQLResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

interface GitHubReviewThreadsQuery {
  repository?: {
    pullRequest?: {
      reviewThreads: GitHubReviewThreadsPage;
    } | null;
  } | null;
}

interface GitHubReviewThreadsPage {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: GitHubReviewThread[];
}

interface GitHubReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path?: string | null;
  line?: number | null;
  startLine?: number | null;
  diffSide?: 'LEFT' | 'RIGHT' | null;
  startDiffSide?: 'LEFT' | 'RIGHT' | null;
  comments: {
    nodes: GitHubReviewComment[];
  };
}

interface GitHubReviewComment {
  id: string;
  databaseId?: number | null;
  body: string;
  author?: { login: string } | null;
  createdAt: string;
  updatedAt: string;
}

interface GitHubThreadReplyMutation {
  addPullRequestReviewThreadReply: {
    comment: { id: string };
  };
}

interface GitHubResolveThreadMutation {
  resolveReviewThread: {
    thread: { id: string; isResolved: boolean };
  };
}

interface GitHubCreateThreadMutation {
  addPullRequestReviewThread: {
    thread: { id: string };
  };
}

interface GitHubCreateThreadInput {
  pullRequestId: string;
  body: string;
  path: string;
  line?: number;
  side: 'LEFT' | 'RIGHT';
}

// ─── Helpers ─────────────────────────────────────────────

function normalizeGitHubEndpoints(inputUrl: string | undefined): GitHubEndpoints {
  const raw = (inputUrl || 'https://github.com').replace(/\/+$/, '');
  const url = new URL(raw);

  if (url.hostname === 'api.github.com') {
    return {
      apiBaseUrl: url.origin,
      webBaseUrl: 'https://github.com',
      graphqlUrl: `${url.origin}/graphql`,
    };
  }

  if (url.pathname === '/api/v3' || url.pathname.endsWith('/api/v3')) {
    const webPath = url.pathname.replace(/\/api\/v3$/, '');
    const webBaseUrl = `${url.origin}${webPath}`.replace(/\/+$/, '');
    const graphqlBase = `${url.origin}${webPath}/api/graphql`.replace(/([^:]\/)\/+/g, '$1');
    return {
      apiBaseUrl: raw,
      webBaseUrl,
      graphqlUrl: graphqlBase,
    };
  }

  if (url.hostname === 'github.com') {
    return {
      apiBaseUrl: 'https://api.github.com',
      webBaseUrl: url.origin,
      graphqlUrl: 'https://api.github.com/graphql',
    };
  }

  return {
    apiBaseUrl: `${url.origin}/api/v3`,
    webBaseUrl: url.origin,
    graphqlUrl: `${url.origin}/api/graphql`,
  };
}

function splitRepository(repository: string): { owner: string; name: string } {
  const parts = repository.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new ProviderError(`Invalid GitHub repository slug: ${repository}`, 'github');
  }
  return { owner: parts[0], name: parts[1] };
}

function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match?.[2] === 'next') return match[1];
  }
  return null;
}

function isValidationError(err: unknown): boolean {
  return err instanceof ProviderError && (err.message.includes('422') || err.message.includes('GraphQL error'));
}

function buildDispatcher(opts: GitHubProviderOptions): object | undefined {
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
