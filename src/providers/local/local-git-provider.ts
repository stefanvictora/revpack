import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ReviewComment, ReviewTarget, ReviewTargetRef, ReviewThread, ReviewVersion } from '../../core/types.js';
import type { NewThreadPosition, ReviewProvider } from '../provider.js';
import { GitHelper } from '../../workspace/git-helper.js';

interface LocalReviewState {
  schemaVersion: 1;
  target?: LocalTargetState;
  description: string;
  nextThreadNumber: number;
  threads: ReviewThread[];
  reviewNote?: { id: string; body: string };
}

interface LocalTargetState {
  repository: string;
  branch: string;
  baseRef: string;
  baseSha: string;
  headSha: string;
  targetId: string;
  title: string;
  author: string;
  createdAt: string;
  updatedAt: string;
}

interface ParsedReviewRange {
  baseRef: string;
  headRef: string;
  baseSha: string;
  headSha: string;
  targetId: string;
}

const DEFAULT_STATE: LocalReviewState = {
  schemaVersion: 1,
  description: '',
  nextThreadNumber: 1,
  threads: [],
};

const COMMON_BASE_REFS = [
  'origin/main',
  'main',
  'origin/master',
  'master',
  'origin/develop',
  'develop',
  'origin/trunk',
  'trunk',
];

export class LocalGitProvider implements ReviewProvider {
  readonly providerType = 'local' as const;

  private readonly git: GitHelper;
  private readonly statePath: string;

  constructor(
    workingDir: string,
    private readonly baseOrRange?: string,
  ) {
    this.git = new GitHelper(workingDir);
    this.statePath = path.join(workingDir, '.revpack', 'local', 'state.json');
  }

  resolveTarget(ref: string): ReviewTargetRef {
    return {
      provider: 'local',
      repository: '',
      targetType: 'local_review',
      targetId: ref || 'local',
    };
  }

  async listOpenReviewTargets(_repo: string): Promise<ReviewTarget[]> {
    return [await this.getTargetSnapshot(this.resolveTarget(this.baseOrRange ?? 'local'))];
  }

  async findTargetByBranch(_repo: string, _branchName: string): Promise<ReviewTarget[]> {
    return [await this.getTargetSnapshot(this.resolveTarget(this.baseOrRange ?? 'local'))];
  }

  async getTargetSnapshot(_ref: ReviewTargetRef): Promise<ReviewTarget> {
    const state = await this.loadState();
    const target = await this.computeTargetState(state.target);

    state.target = target;
    await this.saveState(state);

    return {
      provider: 'local',
      repository: target.repository,
      targetType: 'local_review',
      targetId: target.targetId,
      title: target.title,
      description: state.description,
      author: target.author,
      state: 'opened',
      sourceBranch: target.branch,
      targetBranch: target.baseRef,
      webUrl: '',
      createdAt: target.createdAt,
      updatedAt: target.updatedAt,
      labels: [],
      diffRefs: {
        baseSha: target.baseSha,
        startSha: target.baseSha,
        headSha: target.headSha,
      },
    };
  }

  async listUnresolvedThreads(ref: ReviewTargetRef): Promise<ReviewThread[]> {
    const threads = await this.listAllThreads(ref);
    return threads.filter((thread) => !thread.resolved);
  }

  async listAllThreads(ref: ReviewTargetRef): Promise<ReviewThread[]> {
    const state = await this.loadState();
    return state.threads.map((thread) => this.normalizeThreadRef(thread, ref));
  }

  async getDiffVersions(ref: ReviewTargetRef): Promise<ReviewVersion[]> {
    const target = await this.getTargetSnapshot(ref);
    return [
      {
        provider: 'local',
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

  async postReply(ref: ReviewTargetRef, threadId: string, body: string): Promise<void> {
    const state = await this.loadState();
    const thread = state.threads.find((item) => item.threadId === threadId);
    if (!thread) throw new Error(`Local thread not found: ${threadId}`);

    const now = new Date().toISOString();
    thread.comments.push({
      id: `${thread.threadId}-C${String(thread.comments.length + 1).padStart(3, '0')}`,
      body,
      author: 'agent',
      createdAt: now,
      updatedAt: now,
      origin: 'bot',
      system: false,
    });
    thread.targetRef = ref;
    await this.saveState(state);
  }

  async resolveThread(_ref: ReviewTargetRef, threadId: string): Promise<void> {
    const state = await this.loadState();
    const thread = state.threads.find((item) => item.threadId === threadId);
    if (!thread) throw new Error(`Local thread not found: ${threadId}`);

    thread.resolved = true;
    thread.resolvedBy = 'local';
    thread.resolvedAt = new Date().toISOString();
    await this.saveState(state);
  }

  async updateDescription(_ref: ReviewTargetRef, body: string): Promise<void> {
    const state = await this.loadState();
    state.description = body;
    await this.saveState(state);
  }

  async createThread(ref: ReviewTargetRef, body: string, position?: NewThreadPosition): Promise<string> {
    const state = await this.loadState();
    const target = await this.computeTargetState(state.target);
    state.target = target;

    const threadId = `L-${String(state.nextThreadNumber).padStart(3, '0')}`;
    state.nextThreadNumber++;

    const now = new Date().toISOString();
    const thread: ReviewThread = {
      provider: 'local',
      targetRef: ref,
      threadId,
      resolved: false,
      resolvable: true,
      position: position
        ? {
            filePath: position.newPath || position.oldPath,
            oldLine: position.oldLine,
            newLine: position.newLine,
            oldPath: position.oldPath,
            newPath: position.newPath,
            baseSha: target.baseSha,
            startSha: target.baseSha,
            headSha: target.headSha,
          }
        : undefined,
      comments: [
        {
          id: `${threadId}-C001`,
          body,
          author: 'agent',
          createdAt: now,
          updatedAt: now,
          origin: 'bot',
          system: false,
        },
      ],
    };

    state.threads.push(thread);
    await this.saveState(state);
    return threadId;
  }

  async findNoteByMarker(_ref: ReviewTargetRef, marker: string): Promise<{ id: string; body: string } | null> {
    const state = await this.loadState();
    if (state.reviewNote?.body.startsWith(marker)) return state.reviewNote;
    return null;
  }

  async createNote(_ref: ReviewTargetRef, body: string): Promise<string> {
    const state = await this.loadState();
    const id = state.reviewNote?.id ?? 'local-review-note';
    state.reviewNote = { id, body };
    await this.saveState(state);
    return id;
  }

  async updateNote(_ref: ReviewTargetRef, noteId: string, body: string): Promise<void> {
    const state = await this.loadState();
    state.reviewNote = { id: noteId, body };
    await this.saveState(state);
  }

  getCloneUrl(repo: string): string {
    return repo;
  }

  private async computeTargetState(existing?: LocalTargetState): Promise<LocalTargetState> {
    const branch = await this.git.currentBranch();
    if (branch === 'HEAD') {
      throw new Error('Cannot prepare a local review from a detached HEAD checkout.');
    }

    if (existing && existing.branch !== branch) {
      throw new Error(
        `Current branch "${branch}" differs from the active local review branch "${existing.branch}".\n` +
          'Run `revpack clean` to remove the active local review, or switch back to the review branch.',
      );
    }

    const range = await this.resolveReviewRange(existing);
    if (existing && existing.baseRef !== range.baseRef) {
      throw new Error(
        `The active local review uses base "${existing.baseRef}", but this run resolved "${range.baseRef}".\n` +
          'Run `revpack clean` before preparing a local review with a different base.',
      );
    }

    const repository = await this.repositorySlug();
    const author = (await this.git.configValue('user.name')) ?? (await this.git.configValue('user.email')) ?? 'local';
    const now = new Date().toISOString();

    return {
      repository,
      branch,
      baseRef: range.baseRef,
      baseSha: range.baseSha,
      headSha: range.headSha,
      targetId: `${range.baseRef}...${branch}`,
      title: `Local review: ${branch} into ${range.baseRef}`,
      author,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
  }

  private async resolveReviewRange(existing?: LocalTargetState): Promise<ParsedReviewRange> {
    const headRef = 'HEAD';
    const explicit = this.baseOrRange?.trim();

    if (explicit) {
      const tripleDot = explicit.match(/^(.+)\.\.\.(.+)$/);
      if (tripleDot) {
        const baseRef = tripleDot[1].trim();
        const explicitHead = tripleDot[2].trim();
        const [baseSha, headSha] = await Promise.all([
          this.git.mergeBase(baseRef, explicitHead),
          this.git.revParse(explicitHead),
        ]);
        return { baseRef, headRef: explicitHead, baseSha, headSha, targetId: explicit };
      }

      const doubleDot = explicit.match(/^(.+)\.\.(.+)$/);
      if (doubleDot) {
        const baseRef = doubleDot[1].trim();
        const explicitHead = doubleDot[2].trim();
        const [baseSha, headSha] = await Promise.all([this.git.revParse(baseRef), this.git.revParse(explicitHead)]);
        return { baseRef, headRef: explicitHead, baseSha, headSha, targetId: explicit };
      }

      const [baseSha, headSha] = await Promise.all([this.git.mergeBase(explicit, headRef), this.git.revParse(headRef)]);
      return { baseRef: explicit, headRef, baseSha, headSha, targetId: `${explicit}...HEAD` };
    }

    if (existing?.baseRef) {
      const [baseSha, headSha] = await Promise.all([
        this.git.mergeBase(existing.baseRef, headRef),
        this.git.revParse(headRef),
      ]);
      return { baseRef: existing.baseRef, headRef, baseSha, headSha, targetId: `${existing.baseRef}...HEAD` };
    }

    for (const candidate of COMMON_BASE_REFS) {
      if (!(await this.git.refExists(candidate))) continue;
      const headSha = await this.git.revParse(headRef);
      const candidateSha = await this.git.revParse(candidate);
      if (candidateSha === headSha) continue;
      return {
        baseRef: candidate,
        headRef,
        baseSha: await this.git.mergeBase(candidate, headRef),
        headSha,
        targetId: `${candidate}...HEAD`,
      };
    }

    throw new Error(
      'Could not determine a base branch for local review.\n' +
        'Run `revpack prepare --local <base>` or `revpack prepare --local <base>...HEAD`.',
    );
  }

  private async repositorySlug(): Promise<string> {
    try {
      return await this.git.deriveRepoSlug();
    } catch {
      const root = await this.git.repositoryRoot();
      return path.basename(root);
    }
  }

  private normalizeThreadRef(thread: ReviewThread, ref: ReviewTargetRef): ReviewThread {
    return {
      ...thread,
      provider: 'local',
      targetRef: ref,
      comments: thread.comments.map((comment): ReviewComment => ({ ...comment })),
    };
  }

  private async loadState(): Promise<LocalReviewState> {
    try {
      const raw = await fs.readFile(this.statePath, 'utf-8');
      const parsed = JSON.parse(raw) as LocalReviewState;
      return {
        ...DEFAULT_STATE,
        ...parsed,
        nextThreadNumber: parsed.nextThreadNumber || 1,
        threads: parsed.threads ?? [],
      };
    } catch {
      return { ...DEFAULT_STATE, threads: [] };
    }
  }

  private async saveState(state: LocalReviewState): Promise<void> {
    await fs.mkdir(path.dirname(this.statePath), { recursive: true });
    await fs.writeFile(this.statePath, JSON.stringify(state, null, 2), 'utf-8');
  }
}
