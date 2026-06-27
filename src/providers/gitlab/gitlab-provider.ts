import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { Agent } from 'undici';
import type {
  CheckoutBranchTarget,
  CheckoutFallbackRef,
  ReviewProvider,
  NewThreadPosition,
  ReviewAssetLocalizationOptions,
} from '../provider.js';
import type {
  ReviewTarget,
  ReviewTargetRef,
  ReviewThread,
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

interface GitLabUploadAssetRef {
  projectId: string;
  secret: string;
  filenamePath: string;
}

interface GitLabProviderOptions {
  caFile?: string;
  tlsVerify?: boolean;
  sshClone?: boolean;
}

const MAX_UPLOAD_ASSET_BYTES = 10 * 1024 * 1024;
const ALLOWED_UPLOAD_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif']);
const ALLOWED_UPLOAD_IMAGE_CONTENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/avif',
]);

export class GitLabProvider implements ReviewProvider {
  readonly providerType = 'gitlab' as const;
  private readonly baseUrl: string;
  private readonly webUrlOrigin: string;
  private readonly token: string;
  private readonly fetchDispatcher: object | undefined;
  private readonly sshClone: boolean;

  constructor(gitlabUrl: string, token: string, opts: GitLabProviderOptions = {}) {
    this.baseUrl = gitlabUrl.replace(/\/+$/, '');
    this.webUrlOrigin = new URL(this.baseUrl).origin;
    this.token = token;
    this.fetchDispatcher = buildDispatcher(opts);
    this.sshClone = opts.sshClone ?? false;
  }

  // ─── Target resolution ──────────────────────────────────

  resolveTarget(ref: string): ReviewTargetRef {
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
    const data = await this.request<GitLabMR[]>(`/api/v4/projects/${projectId}/merge_requests`, {
      params: { state: 'opened', per_page: '50' },
    });
    return data.map((mr) => this.mapMR(repo, mr));
  }

  async findTargetByBranch(repo: string, branchName: string): Promise<ReviewTarget[]> {
    const projectId = encodeURIComponent(repo);
    const data = await this.request<GitLabMR[]>(`/api/v4/projects/${projectId}/merge_requests`, {
      params: { state: 'opened', source_branch: branchName, per_page: '10' },
    });
    return data.map((mr) => this.mapMR(repo, mr));
  }

  async getTargetSnapshot(ref: ReviewTargetRef): Promise<ReviewTarget> {
    const projectId = encodeURIComponent(ref.repository);
    const mr = await this.request<GitLabMR>(`/api/v4/projects/${projectId}/merge_requests/${ref.targetId}`);
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

  async localizeReviewAssets(
    _ref: ReviewTargetRef,
    threads: ReviewThread[],
    options: ReviewAssetLocalizationOptions,
  ): Promise<Record<string, string>> {
    const rewrites: Record<string, string> = {};
    const assetRefs = new Map<string, GitLabUploadAssetRef>();

    for (const thread of threads) {
      for (const comment of thread.comments) {
        for (const url of extractImageUrls(comment.body)) {
          const assetRef = this.parseUploadAssetUrl(url);
          if (assetRef) assetRefs.set(url, assetRef);
        }
      }
    }

    if (assetRefs.size > 0) {
      options.onProgress?.(`Downloading ${assetRefs.size} GitLab review comment asset(s).`);
    }

    let downloaded = 0;
    for (const [remoteUrl, assetRef] of assetRefs) {
      const result = await this.downloadUploadAsset(assetRef, remoteUrl, options.assetDir);
      if (!result.localPath) {
        options.onProgress?.(formatUploadDownloadFailure(assetRef, result.reason));
        continue;
      }

      const relativeAssetPath = toPosixPath(path.relative(options.assetDir, result.localPath));
      rewrites[remoteUrl] = `${options.markdownPathPrefix}/${relativeAssetPath}`;
      downloaded++;
    }

    if (downloaded > 0) {
      options.onProgress?.(`Downloaded ${downloaded} GitLab review comment asset(s) into .revpack/assets.`);
    }

    return rewrites;
  }

  async getDiffVersions(ref: ReviewTargetRef): Promise<ReviewVersion[]> {
    const projectId = encodeURIComponent(ref.repository);
    const versions = await this.request<GitLabDiffVersion[]>(
      `/api/v4/projects/${projectId}/merge_requests/${ref.targetId}/versions`,
    );
    return versions.map((v) => this.mapVersion(ref, v));
  }

  // ─── Write operations ───────────────────────────────────

  async postReply(ref: ReviewTargetRef, threadId: string, body: string): Promise<void> {
    const projectId = encodeURIComponent(ref.repository);
    await this.request(`/api/v4/projects/${projectId}/merge_requests/${ref.targetId}/discussions/${threadId}/notes`, {
      method: 'POST',
      body: { body },
    });
  }

  async resolveThread(ref: ReviewTargetRef, threadId: string): Promise<void> {
    const projectId = encodeURIComponent(ref.repository);
    await this.request(`/api/v4/projects/${projectId}/merge_requests/${ref.targetId}/discussions/${threadId}`, {
      method: 'PUT',
      body: { resolved: true },
    });
  }

  async updateDescription(ref: ReviewTargetRef, body: string): Promise<void> {
    const projectId = encodeURIComponent(ref.repository);
    await this.request(`/api/v4/projects/${projectId}/merge_requests/${ref.targetId}`, {
      method: 'PUT',
      body: { description: body },
    });
  }

  async createThread(ref: ReviewTargetRef, body: string, position?: NewThreadPosition): Promise<string> {
    const projectId = encodeURIComponent(ref.repository);
    const discussionsUrl = `/api/v4/projects/${projectId}/merge_requests/${ref.targetId}/discussions`;

    if (position) {
      // Fetch the latest MR version to get accurate SHA refs for diff positioning.
      // GitLab recommends using version SHAs over diff_refs for diff notes.
      const versions = await this.request<GitLabDiffVersion[]>(
        `/api/v4/projects/${projectId}/merge_requests/${ref.targetId}/versions`,
      );
      let baseSha: string | undefined;
      let headSha: string | undefined;
      let startSha: string | undefined;

      if (versions.length > 0) {
        const latest = versions[0];
        baseSha = latest.base_commit_sha;
        headSha = latest.head_commit_sha;
        startSha = latest.start_commit_sha;
      } else {
        // Fallback to MR diff_refs
        const mr = await this.request<GitLabMR>(`/api/v4/projects/${projectId}/merge_requests/${ref.targetId}`);
        baseSha = mr.diff_refs?.base_sha;
        headSha = mr.diff_refs?.head_sha;
        startSha = mr.diff_refs?.start_sha;
      }

      const positionPayload: Record<string, unknown> = {
        position_type: 'text',
        base_sha: baseSha,
        head_sha: headSha,
        start_sha: startSha,
        old_path: position.oldPath,
        new_path: position.newPath,
      };
      if (position.newLine != null) positionPayload.new_line = position.newLine;
      if (position.oldLine != null) positionPayload.old_line = position.oldLine;

      // Try diff-positioned note with the values the agent provided.
      try {
        const result = await this.request<GitLabDiscussion>(discussionsUrl, {
          method: 'POST',
          body: { body, position: positionPayload },
        });
        return result.id;
      } catch (err) {
        // GitLab rejects with 400 "line_code can't be blank" when the line is
        // outside every diff hunk (e.g. the agent pointed at a line far from
        // any change).  Fall back to a general comment with a file anchor.
        const isLineCodeError =
          err instanceof Error && err.message.includes('400') && err.message.toLowerCase().includes('line_code');
        if (!isLineCodeError) throw err;
      }

      // Fallback: post as a general MR comment with a file/line anchor.
      const displayPath = position.newPath || position.oldPath;
      const anchor = `📌 \`${displayPath}:${position.newLine ?? position.oldLine}\`\n\n`;
      const result = await this.request<GitLabDiscussion>(discussionsUrl, {
        method: 'POST',
        body: { body: anchor + body },
      });
      return result.id;
    }

    const result = await this.request<GitLabDiscussion>(discussionsUrl, { method: 'POST', body: { body } });
    return result.id;
  }

  async findNoteByMarker(ref: ReviewTargetRef, marker: string): Promise<{ id: string; body: string } | null> {
    const projectId = encodeURIComponent(ref.repository);
    const notes = await this.requestPaginated<GitLabNote>(
      `/api/v4/projects/${projectId}/merge_requests/${ref.targetId}/notes`,
    );
    const match = notes.find((n) => n.body.startsWith(marker));
    return match ? { id: String(match.id), body: match.body } : null;
  }

  async createNote(ref: ReviewTargetRef, body: string, options?: { internal?: boolean }): Promise<string> {
    const projectId = encodeURIComponent(ref.repository);
    const payload: Record<string, unknown> = { body };
    if (options?.internal) payload.internal = true;
    const result = await this.request<GitLabNote>(
      `/api/v4/projects/${projectId}/merge_requests/${ref.targetId}/notes`,
      { method: 'POST', body: payload },
    );
    return String(result.id);
  }

  async updateNote(ref: ReviewTargetRef, noteId: string, body: string): Promise<void> {
    const projectId = encodeURIComponent(ref.repository);
    await this.request(`/api/v4/projects/${projectId}/merge_requests/${ref.targetId}/notes/${noteId}`, {
      method: 'PUT',
      body: { body },
    });
  }

  getCloneUrl(repo: string): string {
    if (this.sshClone) {
      const host = new URL(this.baseUrl).hostname;
      return `git@${host}:${repo}.git`;
    }
    return `${this.baseUrl}/${repo}.git`;
  }

  getCheckoutFallbackRef(ref: ReviewTargetRef): CheckoutFallbackRef | null {
    if (ref.provider !== 'gitlab' || ref.targetType !== 'merge_request') {
      return null;
    }

    return {
      remoteRef: `refs/merge-requests/${ref.targetId}/head`,
      localBranch: this.checkoutFallbackBranchName(ref.targetId),
    };
  }

  getCheckoutFallbackBranch(target: CheckoutBranchTarget): string | null {
    const targetType = target.targetType ?? target.type;
    const targetId = target.targetId ?? target.id;
    if (target.provider !== 'gitlab' || targetType !== 'merge_request' || !targetId) {
      return null;
    }

    return this.checkoutFallbackBranchName(targetId);
  }

  formatCheckoutFallbackError(target: ReviewTarget, sourceError: unknown, fallbackError: unknown): Error {
    return new Error(
      [
        `Could not check out GitLab merge request !${target.targetId}.`,
        '',
        `The source branch "${target.sourceBranch}" may have been deleted.`,
        `revpack also tried GitLab's temporary MR head ref: refs/merge-requests/${target.targetId}/head.`,
        '',
        'GitLab only keeps this MR head ref temporarily after a merge request is merged or closed.',
        'On GitLab 16.6 and newer, GitLab removes the MR head ref 14 days after merge or close.',
        'This merge request can no longer be checked out unless the source branch or head commit is still reachable.',
        '',
        `Source branch fetch failed: ${errorMessage(sourceError)}`,
        `MR head ref fetch failed: ${errorMessage(fallbackError)}`,
      ].join('\n'),
      { cause: fallbackError },
    );
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
      throw new ProviderError(`Network error reaching ${url.hostname}${detail}: ${cause.message}`, 'gitlab');
    }

    if (res.status === 401 || res.status === 403) {
      throw new AuthenticationError(`GitLab authentication failed (${res.status})`, 'gitlab');
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ProviderError(`GitLab API error: ${res.status} ${res.statusText} — ${text}`, 'gitlab', res.status);
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
        throw new ProviderError(`Network error reaching ${url.hostname}${detail}: ${cause.message}`, 'gitlab');
      }

      if (res.status === 401 || res.status === 403) {
        throw new AuthenticationError(`GitLab authentication failed (${res.status})`, 'gitlab');
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new ProviderError(`GitLab API error: ${res.status} ${res.statusText} — ${text}`, 'gitlab', res.status);
      }

      const data = (await res.json()) as T[];
      results.push(...data);

      const totalPages = parseInt(res.headers.get('x-total-pages') ?? '1', 10);
      hasMore = page < totalPages;
      page++;
    }

    return results;
  }

  private async requestBinaryUrl(url: string, extension: string): Promise<{ data?: Buffer; reason: string }> {
    const headers: Record<string, string> = {
      'PRIVATE-TOKEN': this.token,
    };

    let res: Response;
    try {
      res = await fetch(url, {
        headers,
        ...(this.fetchDispatcher ? { dispatcher: this.fetchDispatcher } : {}),
      } as RequestInit);
    } catch (err) {
      return { reason: err instanceof Error ? err.message : String(err) };
    }

    if (!res.ok) return { reason: `${res.status} ${res.statusText}`.trim() };

    const contentLength = parseInt(res.headers.get('content-length') ?? '', 10);
    if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_ASSET_BYTES) {
      return { reason: `asset is larger than ${formatBytes(MAX_UPLOAD_ASSET_BYTES)}` };
    }

    const contentType = res.headers.get('content-type') ?? '';
    const mimeType = contentType.split(';', 1)[0].trim().toLowerCase();
    if (mimeType === 'text/html') {
      return { reason: 'received HTML instead of an upload asset' };
    }
    const allowGenericBinary = ALLOWED_UPLOAD_IMAGE_EXTENSIONS.has(extension);
    if (
      mimeType &&
      (mimeType !== 'application/octet-stream' || !allowGenericBinary) &&
      !ALLOWED_UPLOAD_IMAGE_CONTENT_TYPES.has(mimeType)
    ) {
      return { reason: `unsupported content type ${mimeType}` };
    }

    const data = Buffer.from(await res.arrayBuffer());
    if (data.byteLength > MAX_UPLOAD_ASSET_BYTES) {
      return { reason: `asset is larger than ${formatBytes(MAX_UPLOAD_ASSET_BYTES)}` };
    }

    return { data, reason: 'ok' };
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
      comments: disc.notes.map((n) => this.mapNote(ref, n)),
    };
  }

  private mapNote(ref: ReviewTargetRef, note: GitLabNote): ReviewComment {
    return {
      id: String(note.id),
      body: this.expandRelativeUploadUrls(ref, note),
      author: note.author?.username ?? 'unknown',
      createdAt: note.created_at,
      updatedAt: note.updated_at,
      origin: this.detectOrigin(note),
      system: note.system ?? false,
    };
  }

  private expandRelativeUploadUrls(ref: ReviewTargetRef, note: GitLabNote): string {
    const projectId = note.project_id != null ? String(note.project_id) : encodeURIComponent(ref.repository);
    const uploadBase = `${this.webUrlOrigin}/-/project/${projectId}`;
    return note.body.replace(
      /(]\(|src\s*=\s*["'])(\/uploads\/[^)"'\s}]+)/gi,
      (_match, prefix: string, path: string) => {
        return `${prefix}${uploadBase}${path}`;
      },
    );
  }

  private parseUploadAssetUrl(rawUrl: string): GitLabUploadAssetRef | null {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return null;
    }

    if (url.origin !== this.webUrlOrigin) return null;

    const match = url.pathname.match(/^\/-\/project\/([^/]+)\/uploads\/([^/]+)\/(.+)$/);
    if (!match) return null;

    return {
      projectId: match[1],
      secret: match[2],
      filenamePath: match[3],
    };
  }

  private async downloadUploadAsset(
    assetRef: GitLabUploadAssetRef,
    webUrl: string,
    assetDir: string,
  ): Promise<{ localPath?: string; reason: string }> {
    const safeProjectId = safePathSegment(decodeURIComponent(assetRef.projectId));
    const safeSecret = safePathSegment(decodeURIComponent(assetRef.secret));
    const safeFilename = safeAssetFilename(decodeURIComponent(assetRef.filenamePath));
    const extension = path.extname(safeFilename).toLowerCase();
    if (!ALLOWED_UPLOAD_IMAGE_EXTENSIONS.has(extension)) {
      return { reason: `unsupported image file extension ${extension || '<none>'}` };
    }

    const localPath = path.join(assetDir, 'gitlab-uploads', safeProjectId, safeSecret, safeFilename);

    try {
      await fsp.access(localPath);
      return { localPath, reason: 'already downloaded' };
    } catch {
      // Download below.
    }

    const apiPath = `/api/v4/projects/${assetRef.projectId}/uploads/${assetRef.secret}/${assetRef.filenamePath}`;
    const apiUrl = new URL(apiPath, this.baseUrl).toString();
    const apiResult = await this.requestBinaryUrl(apiUrl, extension);
    const webResult = apiResult.data ? apiResult : await this.requestBinaryUrl(webUrl, extension);
    if (!webResult.data) {
      return { reason: webResult.reason ? `API ${apiResult.reason}; web ${webResult.reason}` : apiResult.reason };
    }

    await fsp.mkdir(path.dirname(localPath), { recursive: true });
    await fsp.writeFile(localPath, webResult.data);
    return { localPath, reason: 'downloaded' };
  }

  private detectOrigin(note: GitLabNote): CommentOrigin {
    if (note.system) return 'bot';
    // Comments published by revpack contain a marker
    if (note.body?.startsWith('<!-- revpack')) return 'bot';
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

  private checkoutFallbackBranchName(targetId: string): string {
    const safeId = targetId.replace(/[^A-Za-z0-9._-]/g, '-');
    return `revpack/mr-${safeId}`;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function extractImageUrls(body: string): string[] {
  const urls = new Set<string>();
  for (const match of body.matchAll(/!\[[^\]]*]\((https?:\/\/[^\s)"'<>}]+)[^)]*\)/g)) {
    urls.add(match[1]);
  }
  for (const match of body.matchAll(/<img\b[^>]*\bsrc\s*=\s*["'](https?:\/\/[^"']+)["'][^>]*>/gi)) {
    urls.add(match[1]);
  }
  return [...urls];
}

function safePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'asset';
}

function safeAssetFilename(value: string): string {
  const filename = value.split(/[\\/]/).pop() ?? 'asset';
  return safePathSegment(filename);
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join('/');
}

function formatUploadDownloadFailure(assetRef: GitLabUploadAssetRef, reason: string): string {
  const filename = safeAssetFilename(decodeURIComponent(assetRef.filenamePath));
  const permissionHint =
    reason.includes('401') || reason.includes('403')
      ? [
          '',
          'GitLab upload download failed.',
          '',
          'The token must have:',
          '- Fine-grained permission: Markdown Upload / Read',
          '- Access to this project or parent group',
          '- User role: Guest or higher',
          '',
          'Endpoint:',
          'GET /projects/:id/uploads/:secret/:filename',
        ].join('\n')
      : '';
  return `Could not download GitLab review comment asset ${filename}: ${reason}.${permissionHint}`;
}

function formatBytes(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MiB`;
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
  project_id?: number;
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

interface GitLabDiffVersion {
  id: number;
  head_commit_sha: string;
  base_commit_sha: string;
  start_commit_sha: string;
  created_at: string;
  real_size?: number;
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
