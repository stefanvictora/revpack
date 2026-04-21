import * as fs from 'node:fs';
import { Agent } from 'undici';
import type { ReviewProvider, NewThreadPosition } from '../provider.js';
import type {
  ReviewTarget,
  ReviewTargetRef,
  ReviewThread,
  ReviewDiff,
  ReviewVersion,
  ReviewComment,
  DiffPosition,
  DiffRefs,
  CommentOrigin,
} from '../../core/types.js';
import { ProviderError, AuthenticationError } from '../../core/errors.js';

interface GitLabRequestOptions {
  method?: string;
  body?: unknown;
  params?: Record<string, string>;
}

interface GitLabProviderOptions {
  caFile?: string;
  tlsVerify?: boolean;
}

export class GitLabProvider implements ReviewProvider {
  readonly providerType = 'gitlab' as const;
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchDispatcher: object | undefined;

  constructor(gitlabUrl: string, token: string, opts: GitLabProviderOptions = {}) {
    this.baseUrl = gitlabUrl.replace(/\/+$/, '');
    this.token = token;
    this.fetchDispatcher = buildDispatcher(opts);
  }

  // ─── Target resolution ──────────────────────────────────

  async resolveTarget(ref: string): Promise<ReviewTargetRef> {
    // Support formats: "!123", "123", "group/project!123", full URL
    // Full URL: extract path between host and /-/merge_requests/
    const urlMatch = ref.match(/https?:\/\/[^/]+\/(.+?)\/-\/merge_requests\/(\d+)/);
    if (urlMatch) {
      return {
        provider: 'gitlab',
        repository: urlMatch[1],
        targetType: 'merge_request',
        targetId: urlMatch[2],
      };
    }

    const bangMatch = ref.match(/^(.+?)!(\d+)$/);
    if (bangMatch) {
      return {
        provider: 'gitlab',
        repository: bangMatch[1],
        targetType: 'merge_request',
        targetId: bangMatch[2],
      };
    }

    const numMatch = ref.match(/^!?(\d+)$/);
    if (numMatch) {
      // Need a default repository — will be resolved by the caller setting repo context
      return {
        provider: 'gitlab',
        repository: '', // filled in by CLI from config or git remote
        targetType: 'merge_request',
        targetId: numMatch[1],
      };
    }

    throw new ProviderError(`Cannot parse GitLab target reference: ${ref}`, 'gitlab');
  }

  // ─── Read operations ────────────────────────────────────

  async listOpenReviewTargets(repo: string): Promise<ReviewTarget[]> {
    const projectId = encodeURIComponent(repo);
    const data = await this.request<GitLabMR[]>(
      `/api/v4/projects/${projectId}/merge_requests`,
      { params: { state: 'opened', per_page: '50' } },
    );
    return data.map((mr) => this.mapMR(repo, mr));
  }

  async findTargetByBranch(repo: string, branchName: string): Promise<ReviewTarget[]> {
    const projectId = encodeURIComponent(repo);
    const data = await this.request<GitLabMR[]>(
      `/api/v4/projects/${projectId}/merge_requests`,
      { params: { state: 'opened', source_branch: branchName, per_page: '10' } },
    );
    return data.map((mr) => this.mapMR(repo, mr));
  }

  async getTargetSnapshot(ref: ReviewTargetRef): Promise<ReviewTarget> {
    const projectId = encodeURIComponent(ref.repository);
    const mr = await this.request<GitLabMR>(
      `/api/v4/projects/${projectId}/merge_requests/${ref.targetId}`,
    );
    return this.mapMR(ref.repository, mr);
  }

  async listUnresolvedThreads(ref: ReviewTargetRef): Promise<ReviewThread[]> {
    const all = await this.listAllThreads(ref);
    return all.filter((t) => t.resolvable && !t.resolved);
  }

  async listAllThreads(ref: ReviewTargetRef): Promise<ReviewThread[]> {
    const projectId = encodeURIComponent(ref.repository);
    const discussions = await this.requestPaginated<GitLabDiscussion>(
      `/api/v4/projects/${projectId}/merge_requests/${ref.targetId}/discussions`,
    );
    return discussions.map((d) => this.mapDiscussion(ref, d));
  }

  async getLatestDiff(ref: ReviewTargetRef): Promise<ReviewDiff[]> {
    const projectId = encodeURIComponent(ref.repository);
    const changes = await this.requestPaginated<GitLabDiffFile>(
      `/api/v4/projects/${projectId}/merge_requests/${ref.targetId}/diffs`,
    );
    return changes.map((c) => this.mapDiff(c));
  }

  async getDiffVersions(ref: ReviewTargetRef): Promise<ReviewVersion[]> {
    const projectId = encodeURIComponent(ref.repository);
    const versions = await this.request<GitLabDiffVersion[]>(
      `/api/v4/projects/${projectId}/merge_requests/${ref.targetId}/versions`,
    );
    return versions.map((v) => this.mapVersion(ref, v));
  }

  async getIncrementalDiff(
    ref: ReviewTargetRef,
    fromVersion: string,
    toVersion: string,
  ): Promise<ReviewDiff[]> {
    const projectId = encodeURIComponent(ref.repository);
    const basePath = `/api/v4/projects/${projectId}/merge_requests/${ref.targetId}/versions`;

    // Fetch diffs from both versions in parallel
    const [fromData, toData] = await Promise.all([
      this.request<GitLabVersionDetail>(`${basePath}/${fromVersion}`),
      this.request<GitLabVersionDetail>(`${basePath}/${toVersion}`),
    ]);

    const fromDiffs = fromData.diffs ?? [];
    const toDiffs = toData.diffs ?? [];

    // Build a lookup of the previous version's diffs keyed by new_path
    const fromByPath = new Map<string, string>();
    for (const d of fromDiffs) {
      fromByPath.set(d.new_path, d.diff ?? '');
    }

    // Return only files whose diff content changed between the two versions
    return toDiffs
      .filter((d) => fromByPath.get(d.new_path) !== (d.diff ?? ''))
      .map((d) => this.mapDiff(d));
  }

  // ─── Write operations ───────────────────────────────────

  async postReply(ref: ReviewTargetRef, threadId: string, body: string): Promise<void> {
    const projectId = encodeURIComponent(ref.repository);
    await this.request(
      `/api/v4/projects/${projectId}/merge_requests/${ref.targetId}/discussions/${threadId}/notes`,
      { method: 'POST', body: { body } },
    );
  }

  async resolveThread(ref: ReviewTargetRef, threadId: string): Promise<void> {
    const projectId = encodeURIComponent(ref.repository);
    await this.request(
      `/api/v4/projects/${projectId}/merge_requests/${ref.targetId}/discussions/${threadId}`,
      { method: 'PUT', body: { resolved: true } },
    );
  }

  async updateDescription(ref: ReviewTargetRef, body: string): Promise<void> {
    const projectId = encodeURIComponent(ref.repository);
    await this.request(
      `/api/v4/projects/${projectId}/merge_requests/${ref.targetId}`,
      { method: 'PUT', body: { description: body } },
    );
  }

  async createThread(ref: ReviewTargetRef, body: string, position?: NewThreadPosition): Promise<string> {
    const projectId = encodeURIComponent(ref.repository);

    // Build the request body
    const reqBody: Record<string, unknown> = { body };

    if (position) {
      // For diff-positioned threads, GitLab requires the position object
      // with SHA refs from the MR's diff_refs
      const mr = await this.request<GitLabMR>(
        `/api/v4/projects/${projectId}/merge_requests/${ref.targetId}`,
      );
      reqBody.position = {
        position_type: 'text',
        base_sha: mr.diff_refs?.base_sha,
        head_sha: mr.diff_refs?.head_sha,
        start_sha: mr.diff_refs?.start_sha,
        new_path: position.filePath,
        old_path: position.filePath,
        new_line: position.newLine,
        ...(position.oldLine ? { old_line: position.oldLine } : {}),
      };
    }

    const result = await this.request<GitLabDiscussion>(
      `/api/v4/projects/${projectId}/merge_requests/${ref.targetId}/discussions`,
      { method: 'POST', body: reqBody },
    );
    return result.id;
  }

  // ─── HTTP layer ─────────────────────────────────────────

  private async request<T>(path: string, options?: GitLabRequestOptions): Promise<T> {
    const url = new URL(path, this.baseUrl);
    if (options?.params) {
      for (const [k, v] of Object.entries(options.params)) {
        url.searchParams.set(k, v);
      }
    }

    const headers: Record<string, string> = {
      'PRIVATE-TOKEN': this.token,
      'Content-Type': 'application/json',
    };

    let res: Response;
    try {
      res = await fetch(url.toString(), {
        method: options?.method ?? 'GET',
        headers,
        body: options?.body ? JSON.stringify(options.body) : undefined,
        ...(this.fetchDispatcher ? { dispatcher: this.fetchDispatcher } : {}),
      } as RequestInit);
    } catch (err) {
      const cause = err instanceof Error ? err : new Error(String(err));
      const detail = (cause as NodeJS.ErrnoException).cause
        ? ` (${String((cause as NodeJS.ErrnoException).cause)})`
        : '';
      throw new ProviderError(
        `Network error reaching ${url.hostname}${detail}: ${cause.message}`,
        'gitlab',
      );
    }

    if (res.status === 401 || res.status === 403) {
      throw new AuthenticationError(`GitLab authentication failed (${res.status})`, 'gitlab');
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ProviderError(
        `GitLab API error: ${res.status} ${res.statusText} — ${text}`,
        'gitlab',
        res.status,
      );
    }

    return res.json() as Promise<T>;
  }

  private async requestPaginated<T>(path: string, perPage = 100): Promise<T[]> {
    const results: T[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const url = new URL(path, this.baseUrl);
      url.searchParams.set('per_page', String(perPage));
      url.searchParams.set('page', String(page));

      const headers: Record<string, string> = {
        'PRIVATE-TOKEN': this.token,
        'Content-Type': 'application/json',
      };

      let res: Response;
      try {
        res = await fetch(url.toString(), {
          headers,
          ...(this.fetchDispatcher ? { dispatcher: this.fetchDispatcher } : {}),
        } as RequestInit);
      } catch (err) {
        const cause = err instanceof Error ? err : new Error(String(err));
        const detail = (cause as NodeJS.ErrnoException).cause
          ? ` (${String((cause as NodeJS.ErrnoException).cause)})`
          : '';
        throw new ProviderError(
          `Network error reaching ${url.hostname}${detail}: ${cause.message}`,
          'gitlab',
        );
      }

      if (res.status === 401 || res.status === 403) {
        throw new AuthenticationError(`GitLab authentication failed (${res.status})`, 'gitlab');
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new ProviderError(
          `GitLab API error: ${res.status} ${res.statusText} — ${text}`,
          'gitlab',
          res.status,
        );
      }

      const data = (await res.json()) as T[];
      results.push(...data);

      const totalPages = parseInt(res.headers.get('x-total-pages') ?? '1', 10);
      hasMore = page < totalPages;
      page++;
    }

    return results;
  }

  // ─── Mappers ────────────────────────────────────────────

  private mapMR(repo: string, mr: GitLabMR): ReviewTarget {
    return {
      provider: 'gitlab',
      repository: repo,
      targetType: 'merge_request',
      targetId: String(mr.iid),
      title: mr.title,
      description: mr.description ?? '',
      author: mr.author?.username ?? 'unknown',
      state: mr.state,
      sourceBranch: mr.source_branch,
      targetBranch: mr.target_branch,
      webUrl: mr.web_url,
      createdAt: mr.created_at,
      updatedAt: mr.updated_at,
      labels: mr.labels ?? [],
      diffRefs: this.mapDiffRefs(mr.diff_refs),
    };
  }

  private mapDiffRefs(refs?: GitLabDiffRefs): DiffRefs {
    return {
      baseSha: refs?.base_sha ?? '',
      headSha: refs?.head_sha ?? '',
      startSha: refs?.start_sha ?? '',
    };
  }

  private mapDiscussion(ref: ReviewTargetRef, disc: GitLabDiscussion): ReviewThread {
    const firstNote = disc.notes[0];
    const position = firstNote?.position ? this.mapPosition(firstNote.position) : undefined;

    return {
      provider: 'gitlab',
      targetRef: ref,
      threadId: disc.id,
      resolved: firstNote?.resolved ?? false,
      resolvable: firstNote?.resolvable ?? false,
      resolvedBy: firstNote?.resolved_by?.username,
      resolvedAt: undefined, // GitLab doesn't expose resolved_at in discussions endpoint
      position,
      comments: disc.notes.map((n) => this.mapNote(n)),
    };
  }

  private mapNote(note: GitLabNote): ReviewComment {
    return {
      id: String(note.id),
      body: note.body,
      author: note.author?.username ?? 'unknown',
      createdAt: note.created_at,
      updatedAt: note.updated_at,
      origin: this.detectOrigin(note),
      system: note.system ?? false,
    };
  }

  private detectOrigin(note: GitLabNote): CommentOrigin {
    if (note.system) return 'bot';
    if (note.author?.username?.includes('bot') || note.author?.username?.includes('[bot]')) return 'bot';
    return 'human';
  }

  private mapPosition(pos: GitLabPosition): DiffPosition {
    return {
      filePath: pos.new_path ?? pos.old_path ?? '',
      oldLine: pos.old_line ?? undefined,
      newLine: pos.new_line ?? undefined,
      oldPath: pos.old_path ?? undefined,
      newPath: pos.new_path ?? undefined,
      baseSha: pos.base_sha ?? undefined,
      headSha: pos.head_sha ?? undefined,
      startSha: pos.start_sha ?? undefined,
    };
  }

  private mapDiff(diff: GitLabDiffFile): ReviewDiff {
    return {
      oldPath: diff.old_path,
      newPath: diff.new_path,
      diff: diff.diff ?? '',
      newFile: diff.new_file ?? false,
      renamedFile: diff.renamed_file ?? false,
      deletedFile: diff.deleted_file ?? false,
    };
  }

  private mapVersion(ref: ReviewTargetRef, v: GitLabDiffVersion): ReviewVersion {
    return {
      provider: 'gitlab',
      targetRef: ref,
      versionId: String(v.id),
      headCommitSha: v.head_commit_sha,
      baseCommitSha: v.base_commit_sha,
      startCommitSha: v.start_commit_sha,
      createdAt: v.created_at,
      realSize: v.real_size ?? 0,
    };
  }
}

// ─── GitLab API response types (internal) ─────────────────

interface GitLabMR {
  iid: number;
  title: string;
  description?: string;
  state: string;
  source_branch: string;
  target_branch: string;
  web_url: string;
  created_at: string;
  updated_at: string;
  labels?: string[];
  diff_refs?: GitLabDiffRefs;
  author?: { username: string };
}

interface GitLabDiffRefs {
  base_sha?: string;
  head_sha?: string;
  start_sha?: string;
}

interface GitLabDiscussion {
  id: string;
  notes: GitLabNote[];
}

interface GitLabNote {
  id: number;
  body: string;
  author?: { username: string };
  created_at: string;
  updated_at: string;
  system?: boolean;
  resolvable?: boolean;
  resolved?: boolean;
  resolved_by?: { username: string };
  position?: GitLabPosition;
}

interface GitLabPosition {
  old_path?: string;
  new_path?: string;
  old_line?: number;
  new_line?: number;
  base_sha?: string;
  head_sha?: string;
  start_sha?: string;
}

interface GitLabDiffFile {
  old_path: string;
  new_path: string;
  diff?: string;
  new_file?: boolean;
  renamed_file?: boolean;
  deleted_file?: boolean;
}

interface GitLabDiffVersion {
  id: number;
  head_commit_sha: string;
  base_commit_sha: string;
  start_commit_sha: string;
  created_at: string;
  real_size?: number;
  diffs?: GitLabDiffFile[];
}

interface GitLabVersionDetail {
  id: number;
  head_commit_sha: string;
  base_commit_sha: string;
  start_commit_sha: string;
  created_at: string;
  diffs?: GitLabDiffFile[];
}

// ─── TLS / dispatcher helper ──────────────────────────────

function buildDispatcher(opts: GitLabProviderOptions): object | undefined {
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
