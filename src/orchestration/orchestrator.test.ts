import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ReviewOrchestrator } from '../orchestration/orchestrator.js';
import { WorkspaceManager } from '../workspace/workspace-manager.js';
import { GitHelper } from '../workspace/git-helper.js';
import { computeContentHash } from '../workspace/thread-digest.js';
import { mergeWithMarkers } from '../workspace/description-summary.js';
import {
  buildCheckpointState,
  patchDescriptionWithState,
  parseDescriptionState,
  REVIEW_NOTE_MARKER,
} from '../workspace/checkpoint.js';
import type { ReviewProvider } from '../providers/provider.js';
import type { ReviewTarget, ReviewThread, ReviewVersion, ReviewTargetRef } from '../core/types.js';

const targetRef: ReviewTargetRef = {
  provider: 'gitlab',
  repository: 'group/project',
  targetType: 'merge_request',
  targetId: '42',
};

const mockTarget: ReviewTarget = {
  ...targetRef,
  title: 'Test MR',
  description: 'Test',
  author: 'alice',
  state: 'opened',
  sourceBranch: 'feature/test',
  targetBranch: 'main',
  webUrl: 'https://gitlab.example.com/group/project/-/merge_requests/42',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  labels: [],
  diffRefs: { baseSha: 'aaa', headSha: 'bbb', startSha: 'aaa' },
};

const mockThread: ReviewThread = {
  provider: 'gitlab',
  targetRef,
  threadId: 'thread-1',
  resolved: false,
  resolvable: true,
  comments: [
    {
      id: 'note-1',
      body: 'This has a security vulnerability',
      author: 'reviewer',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      origin: 'human',
      system: false,
    },
  ],
};

function localPatch(): string {
  return [
    'diff --git a/src/app.ts b/src/app.ts',
    'index 1111111..2222222 100644',
    '--- a/src/app.ts',
    '+++ b/src/app.ts',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    '',
  ].join('\n');
}

const mockVersion: ReviewVersion = {
  provider: 'gitlab',
  targetRef,
  versionId: 'v1',
  headCommitSha: 'bbb',
  baseCommitSha: 'aaa',
  startCommitSha: 'aaa',
  createdAt: '2026-01-01T00:00:00Z',
  realSize: 1,
};

function createMockProvider(): ReviewProvider {
  return {
    providerType: 'gitlab',
    resolveTarget: vi.fn().mockResolvedValue(targetRef),
    listOpenReviewTargets: vi.fn().mockResolvedValue([mockTarget]),
    findTargetByBranch: vi.fn().mockResolvedValue([mockTarget]),
    getTargetSnapshot: vi.fn().mockResolvedValue(mockTarget),
    listUnresolvedThreads: vi.fn().mockResolvedValue([mockThread]),
    listAllThreads: vi.fn().mockResolvedValue([mockThread]),
    getDiffVersions: vi.fn().mockResolvedValue([mockVersion]),
    postReply: vi.fn().mockResolvedValue(undefined),
    resolveThread: vi.fn().mockResolvedValue(undefined),
    updateDescription: vi.fn().mockResolvedValue(undefined),
    createThread: vi.fn().mockResolvedValue('new-thread-id'),
    findNoteByMarker: vi.fn().mockResolvedValue(null),
    createNote: vi.fn().mockResolvedValue('note-1'),
    updateNote: vi.fn().mockResolvedValue(undefined),
    getCloneUrl: vi.fn().mockReturnValue('https://gitlab.example.com/group/project.git'),
  };
}

describe('ReviewOrchestrator', () => {
  let mockProvider: ReviewProvider;
  let tmpDir: string;
  let headShaSpy: MockInstance<any[], any>;
  let currentBranchSpy: MockInstance<any[], any>;
  let repositoryRootSpy: MockInstance<any[], any>;
  let isCleanSpy: MockInstance<any[], any>;
  let isAncestorSpy: MockInstance<any[], any>;
  let hasCommitSpy: MockInstance<any[], any>;
  let fetchCommitSpy: MockInstance<any[], any>;
  let fetchSpy: MockInstance<any[], any>;
  let fetchBranchSpy: MockInstance<any[], any>;
  let diffForReviewSpy: MockInstance<any[], any>;
  let diffSpy: MockInstance<any[], any>;

  beforeEach(async () => {
    mockProvider = createMockProvider();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-orch-test-'));
    // Mock git operations so tests work in non-git temp dirs
    headShaSpy = vi.spyOn(GitHelper.prototype, 'headSha').mockResolvedValue('bbb');
    currentBranchSpy = vi.spyOn(GitHelper.prototype, 'currentBranch').mockResolvedValue('feature/test');
    repositoryRootSpy = vi.spyOn(GitHelper.prototype, 'repositoryRoot').mockResolvedValue(tmpDir);
    isCleanSpy = vi.spyOn(GitHelper.prototype, 'isClean').mockResolvedValue(true);
    isAncestorSpy = vi.spyOn(GitHelper.prototype, 'isAncestor').mockResolvedValue(false);
    hasCommitSpy = vi.spyOn(GitHelper.prototype, 'hasCommit').mockResolvedValue(true);
    fetchCommitSpy = vi.spyOn(GitHelper.prototype, 'fetchCommit').mockResolvedValue(undefined);
    fetchSpy = vi.spyOn(GitHelper.prototype, 'fetch').mockResolvedValue(undefined);
    fetchBranchSpy = vi.spyOn(GitHelper.prototype, 'fetchBranch').mockResolvedValue(undefined);
    diffForReviewSpy = vi.spyOn(GitHelper.prototype, 'diffForReview').mockResolvedValue(localPatch());
    diffSpy = vi.spyOn(GitHelper.prototype, 'diff').mockResolvedValue(localPatch());
  });

  afterEach(async () => {
    headShaSpy.mockRestore();
    currentBranchSpy.mockRestore();
    repositoryRootSpy.mockRestore();
    isCleanSpy.mockRestore();
    isAncestorSpy.mockRestore();
    hasCommitSpy.mockRestore();
    fetchCommitSpy.mockRestore();
    fetchSpy.mockRestore();
    fetchBranchSpy.mockRestore();
    diffForReviewSpy.mockRestore();
    diffSpy.mockRestore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('open', () => {
    it('resolves and fetches target', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      const target = await orchestrator.open('!42', 'group/project');

      expect(mockProvider.resolveTarget).toHaveBeenCalledWith('!42');
      expect(mockProvider.getTargetSnapshot).toHaveBeenCalled();
      expect(target.title).toBe('Test MR');
    });
  });

  describe('publishReply', () => {
    it('calls provider.postReply with marker', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await orchestrator.publishReply('!42', 'thread-1', 'Thanks, fixed!', 'group/project');

      expect(mockProvider.postReply).toHaveBeenCalledWith(
        targetRef,
        'thread-1',
        expect.stringContaining('Thanks, fixed!'),
      );
    });
  });

  describe('resolveThread', () => {
    it('calls provider.resolveThread', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await orchestrator.resolveThread('!42', 'thread-1', 'group/project');

      expect(mockProvider.resolveThread).toHaveBeenCalledWith(targetRef, 'thread-1');
    });
  });

  describe('updateDescription', () => {
    it('calls provider.updateDescription', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await orchestrator.updateDescription('!42', 'New description', 'group/project');

      expect(mockProvider.updateDescription).toHaveBeenCalledWith(targetRef, 'New description');
    });
  });

  describe('prepare', () => {
    it('generates latest.patch from local git by default', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      const onProgress = vi.fn();
      await orchestrator.prepare('!42', 'group/project', { onProgress });

      expect(hasCommitSpy).toHaveBeenCalledWith('aaa');
      expect(hasCommitSpy).toHaveBeenCalledWith('bbb');
      expect(diffForReviewSpy).toHaveBeenCalledWith('aaa', 'bbb');
      expect(onProgress).not.toHaveBeenCalled();
      const latestPatch = await fs.readFile(path.join(tmpDir, '.revpack', 'diffs', 'latest.patch'), 'utf-8');
      expect(latestPatch).toBe(localPatch());
    });

    it('prints a minimal message and streams git fetch when commits are missing', async () => {
      hasCommitSpy
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true);
      const onProgress = vi.fn();

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await orchestrator.prepare('!42', 'group/project', { onProgress });

      expect(onProgress).toHaveBeenCalledWith(expect.stringContaining('Fetching additional Git objects'));
      expect(fetchCommitSpy).toHaveBeenCalledWith('aaa', 'origin', { depth: 1, noTags: true, progress: true });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(fetchBranchSpy).not.toHaveBeenCalled();
    });

    it('fails prepare when local git patch generation fails', async () => {
      diffForReviewSpy.mockRejectedValue(new Error('local diff failed'));

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await expect(orchestrator.prepare('!42', 'group/project')).rejects.toThrow(
        'could not generate the review patch from local Git',
      );
      await expect(fs.access(path.join(tmpDir, '.revpack', 'diffs', 'latest.patch'))).rejects.toThrow();
    });

    it('uses commit-to-commit local diff without requiring a clean working tree', async () => {
      isCleanSpy.mockResolvedValue(false);

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      const result = await orchestrator.prepare('!42', 'group/project');

      expect(result.bundleState.local.workingTreeClean).toBe(false);
      expect(fetchCommitSpy).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(fetchBranchSpy).not.toHaveBeenCalled();
      expect(diffForReviewSpy).toHaveBeenCalledWith('aaa', 'bbb');
    });

    it('creates bundle, bundle.json, and CONTEXT.md', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      const result = await orchestrator.prepare('!42', 'group/project');

      expect(result.bundle.target.title).toBe('Test MR');
      expect(result.bundle.threads).toHaveLength(1);
      expect(result.bundle.diffs).toHaveLength(1);
      expect(result.contextPath).toContain('CONTEXT.md');
      expect(result.mode).toBe('fresh');
    });

    it('writes outputs to disk', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await orchestrator.prepare('!42', 'group/project');

      const bundleDir = path.join(tmpDir, '.revpack');
      const contextMd = await fs.readFile(path.join(bundleDir, 'CONTEXT.md'), 'utf-8');

      expect(contextMd).toContain('Test MR');
    });

    it('saves bundle.json with correct structure', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await orchestrator.prepare('!42', 'group/project');

      const bundlePath = path.join(tmpDir, '.revpack', 'bundle.json');
      const bundleState = JSON.parse(await fs.readFile(bundlePath, 'utf-8'));
      expect(bundleState.schemaVersion).toBe(2);
      expect(bundleState.target.id).toBe('42');
      expect(bundleState.target.provider).toBe('gitlab');
      expect(bundleState.threads.items.map((i: { providerThreadId: string }) => i.providerThreadId)).toContain(
        'thread-1',
      );
      expect(bundleState.prepare.mode).toBe('fresh');
    });

    it('detects refresh mode from existing bundle.json', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });

      // First run creates fresh bundle
      const first = await orchestrator.prepare('!42', 'group/project');
      expect(first.mode).toBe('fresh');

      // Second run detects bundle and goes refresh
      const second = await orchestrator.prepare('!42', 'group/project');
      expect(second.mode).toBe('refresh');
    });

    it('--fresh removes bundle and starts clean', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });

      // First run creates bundle
      await orchestrator.prepare('!42', 'group/project');

      // Second run with --fresh should be fresh mode
      const result = await orchestrator.prepare('!42', 'group/project', { fresh: true });
      expect(result.mode).toBe('fresh');
    });

    it('does not attempt incremental diff without checkpoint even when code changes between prepares', async () => {
      // Without a checkpoint, there's no baseline for incremental diff
      (mockProvider.findNoteByMarker as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });

      // First run
      await orchestrator.prepare('!42', 'group/project');

      // Change the headSha
      const updatedTarget = { ...mockTarget, diffRefs: { ...mockTarget.diffRefs, headSha: 'ccc' } };
      (mockProvider.getTargetSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(updatedTarget);
      headShaSpy.mockResolvedValue('ccc');

      diffForReviewSpy.mockClear();

      // Second run — no checkpoint → only the canonical full patch is generated
      await orchestrator.prepare('!42', 'group/project');

      expect(diffForReviewSpy).toHaveBeenCalledTimes(1);
      expect(diffForReviewSpy).toHaveBeenCalledWith('aaa', 'ccc');
    });

    it('resumes from bundle.json when no ref is provided', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });

      // First run establishes bundle
      await orchestrator.prepare('!42', 'group/project');

      // Second run without ref should use bundle
      const result = await orchestrator.prepare(undefined, 'group/project');
      expect(result.bundle.target.targetId).toBe('42');
    });

    it('throws when no ref and no bundle and no matching MR', async () => {
      (mockProvider.findTargetByBranch as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });

      await expect(orchestrator.prepare(undefined, 'group/project')).rejects.toThrow(
        'Could not determine which MR to prepare',
      );
    });

    it('does not derive a remote repository slug for explicit local refs', async () => {
      mockProvider = {
        ...createMockProvider(),
        providerType: 'local',
        resolveTarget: vi.fn().mockReturnValue({
          provider: 'local',
          repository: '',
          targetType: 'local_review',
          targetId: 'main...HEAD',
        }),
        findTargetByBranch: vi.fn().mockResolvedValue([]),
        getTargetSnapshot: vi.fn().mockResolvedValue({
          ...mockTarget,
          provider: 'local',
          repository: '',
          targetType: 'local_review',
          targetId: 'main...HEAD',
          sourceBranch: 'feature/test',
          targetBranch: 'main',
          webUrl: '',
        }),
        getDiffVersions: vi.fn().mockResolvedValue([
          {
            ...mockVersion,
            provider: 'local',
            targetRef: {
              provider: 'local',
              repository: '',
              targetType: 'local_review',
              targetId: 'main...HEAD',
            },
          },
        ]),
      };
      const deriveRepoSlugSpy = vi
        .spyOn(GitHelper.prototype, 'deriveRepoSlug')
        .mockRejectedValue(new Error('no remote'));

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      const result = await orchestrator.prepare('main...HEAD');

      expect(result.bundle.target.provider).toBe('local');
      expect(deriveRepoSlugSpy).not.toHaveBeenCalled();
      deriveRepoSlugSpy.mockRestore();
    });

    it('returns prepare stats on second run', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });

      // First run
      const first = await orchestrator.prepare('!42', 'group/project');
      expect(first.prunedReplies).toBe(0);
      expect(first.publishedActionCount).toBe(0);

      // Add a new thread for second run
      const newThread: ReviewThread = {
        ...mockThread,
        threadId: 'thread-new',
      };
      (mockProvider.listAllThreads as ReturnType<typeof vi.fn>).mockResolvedValue([mockThread, newThread]);

      const second = await orchestrator.prepare('!42', 'group/project');
      expect(second.mode).toBe('refresh');
      // Without checkpoint, threadsChanged is null
      expect(second.threadsChanged).toBeNull();
    });

    it('preserves publishedActions across prepare runs', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });

      // First run
      await orchestrator.prepare('!42', 'group/project');

      // Simulate publishing by appending to bundle.json
      const ws = new WorkspaceManager(tmpDir);
      await ws.appendPublishedAction({
        type: 'reply',
        providerThreadId: 'thread-1',
        title: 'Fixed!',
        publishedAt: '2026-01-01T12:00:00Z',
      });

      // Second run should carry over the action
      const second = await orchestrator.prepare('!42', 'group/project');
      expect(second.publishedActionCount).toBe(1);

      // Bundle should still have the action
      const bundleState = await ws.loadBundleState();
      expect(bundleState!.publishedActions).toHaveLength(1);
      expect(bundleState!.publishedActions[0].type).toBe('reply');
    });

    it('excludes system-only threads from bundle and index', async () => {
      const systemThread: ReviewThread = {
        provider: 'gitlab',
        targetRef,
        threadId: 'system-thread-1',
        resolved: false,
        resolvable: false,
        comments: [
          {
            id: 'sys-1',
            body: 'added 5 commits',
            author: 'bot',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            origin: 'bot',
            system: true,
          },
        ],
      };
      const generalComment: ReviewThread = {
        provider: 'gitlab',
        targetRef,
        threadId: 'general-comment-1',
        resolved: false,
        resolvable: false,
        comments: [
          {
            id: 'gen-1',
            body: 'Great work on this MR overall!',
            author: 'reviewer',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            origin: 'human',
            system: false,
          },
        ],
      };

      // Provider returns: system thread, real thread, general comment
      (mockProvider.listAllThreads as ReturnType<typeof vi.fn>).mockResolvedValue([
        systemThread,
        mockThread,
        generalComment,
      ]);

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      const result = await orchestrator.prepare('!42', 'group/project');

      // Bundle should have 2 threads: mockThread + generalComment (not system)
      expect(result.bundle.threads).toHaveLength(2);
      expect(result.bundle.threads.map((t) => t.threadId)).toEqual(['thread-1', 'general-comment-1']);

      // Thread files: T-001 = mockThread (index 0 after filtering), T-002 = generalComment
      const threadDir = path.join(tmpDir, '.revpack', 'threads');
      const files = (await fs.readdir(threadDir)).filter((f) => f.endsWith('.json')).sort();
      expect(files).toEqual(['T-001.json', 'T-002.json']);

      const t1 = JSON.parse(await fs.readFile(path.join(threadDir, 'T-001.json'), 'utf-8'));
      expect(t1.threadId).toBe('thread-1');
      const t2 = JSON.parse(await fs.readFile(path.join(threadDir, 'T-002.json'), 'utf-8'));
      expect(t2.threadId).toBe('general-comment-1');
    });
  });

  describe('publishFinding', () => {
    it('calls provider.createThread with position', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });

      // Need a bundle for resolveRef to work without explicit ref
      await orchestrator.prepare('!42', 'group/project');

      const finding = {
        oldPath: 'src/app.ts',
        newPath: 'src/app.ts',
        newLine: 42,
        body: 'Potential null dereference here',
        severity: 'high' as const,
        category: 'correctness' as const,
      };

      const threadId = await orchestrator.publishFinding(finding, 'group/project');
      expect(threadId).toBe('new-thread-id');
      expect(mockProvider.createThread).toHaveBeenCalledWith(
        expect.objectContaining({ targetId: '42' }),
        expect.stringContaining('Potential null dereference here'),
        { oldPath: 'src/app.ts', newPath: 'src/app.ts', newLine: 42, oldLine: undefined },
      );
    });
  });

  describe('resolveRef auto-detect from branch', () => {
    let deriveSlugSpy: MockInstance<any[], any>;

    afterEach(() => {
      deriveSlugSpy?.mockRestore();
    });

    it('auto-detects MR when a single open MR matches the current branch', async () => {
      deriveSlugSpy = vi.spyOn(GitHelper.prototype, 'deriveRepoSlug').mockResolvedValue('group/project');
      (mockProvider.findTargetByBranch as ReturnType<typeof vi.fn>).mockResolvedValue([mockTarget]);

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      const result = await orchestrator.prepare(undefined, undefined);

      expect(mockProvider.findTargetByBranch).toHaveBeenCalledWith('group/project', 'feature/test');
      expect(result.bundle.target.targetId).toBe('42');
    });

    it('throws descriptive error when multiple MRs match the branch', async () => {
      deriveSlugSpy = vi.spyOn(GitHelper.prototype, 'deriveRepoSlug').mockResolvedValue('group/project');

      const secondTarget: ReviewTarget = { ...mockTarget, targetId: '99' };
      (mockProvider.findTargetByBranch as ReturnType<typeof vi.fn>).mockResolvedValue([mockTarget, secondTarget]);

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await expect(orchestrator.prepare(undefined, undefined)).rejects.toThrow(
        'Multiple open MRs found for branch "feature/test": !42, !99',
      );
    });

    it('throws when no MR found for the current branch', async () => {
      deriveSlugSpy = vi.spyOn(GitHelper.prototype, 'deriveRepoSlug').mockResolvedValue('group/project');
      currentBranchSpy.mockResolvedValue('feature/orphan');
      (mockProvider.findTargetByBranch as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await expect(orchestrator.prepare(undefined, undefined)).rejects.toThrow(
        'Could not determine which MR to prepare',
      );
    });

    it('falls through to error on detached HEAD', async () => {
      deriveSlugSpy = vi.spyOn(GitHelper.prototype, 'deriveRepoSlug').mockResolvedValue('group/project');
      currentBranchSpy.mockResolvedValue('HEAD');

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await expect(orchestrator.prepare(undefined, undefined)).rejects.toThrow(
        'Could not determine which MR to prepare',
      );
      expect(mockProvider.findTargetByBranch).not.toHaveBeenCalled();
    });

    it('uses defaultRepo when deriveRepoSlug fails', async () => {
      deriveSlugSpy = vi.spyOn(GitHelper.prototype, 'deriveRepoSlug').mockRejectedValue(new Error('not a git repo'));
      (mockProvider.findTargetByBranch as ReturnType<typeof vi.fn>).mockResolvedValue([mockTarget]);

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      const result = await orchestrator.prepare(undefined, 'group/project');

      expect(mockProvider.findTargetByBranch).toHaveBeenCalledWith('group/project', 'feature/test');
      expect(result.bundle.target.targetId).toBe('42');
    });

    it('prefers bundle over auto-detect', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });

      // First run creates bundle
      await orchestrator.prepare('!42', 'group/project');

      // Second run should use bundle, not auto-detect
      const result = await orchestrator.prepare(undefined, 'group/project');
      expect(result.bundle.target.targetId).toBe('42');
      expect(mockProvider.findTargetByBranch).not.toHaveBeenCalled();
    });
  });

  describe('checkBranchMismatch', () => {
    it('returns null when no bundle exists', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      const result = await orchestrator.checkBranchMismatch();
      expect(result).toBeNull();
    });

    it('returns null when branch matches', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await orchestrator.prepare('!42', 'group/project');

      const result = await orchestrator.checkBranchMismatch();
      expect(result).toBeNull();
    });

    it('returns mismatch info when branch differs', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await orchestrator.prepare('!42', 'group/project');

      currentBranchSpy.mockResolvedValue('other-branch');
      const result = await orchestrator.checkBranchMismatch();
      expect(result).toEqual({
        currentBranch: 'other-branch',
        expectedBranch: 'feature/test',
        targetId: '42',
      });
    });
  });

  describe('branch mismatch in resolveRef', () => {
    it('throws when resuming bundle on wrong branch', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await orchestrator.prepare('!42', 'group/project');

      currentBranchSpy.mockResolvedValue('wrong-branch');

      await expect(orchestrator.prepare(undefined, 'group/project')).rejects.toThrow(/Branch mismatch|does not match/);
    });

    it('throws when explicit ref is provided on wrong branch', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await orchestrator.prepare('!42', 'group/project');

      currentBranchSpy.mockResolvedValue('wrong-branch');

      // Source consistency check prevents prepare even with explicit ref
      await expect(orchestrator.prepare('!42', 'group/project')).rejects.toThrow('does not match the MR source branch');
    });
  });

  // ─── Source consistency tests ──────────────────────────

  describe('prepare source consistency', () => {
    it('succeeds when local HEAD equals target head', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      const result = await orchestrator.prepare('!42', 'group/project');
      expect(result.bundle.target.title).toBe('Test MR');
      expect(result.bundleState.local.matchesTargetHead).toBe(true);
    });

    it('fails when local is behind target head', async () => {
      headShaSpy.mockResolvedValue('old-commit-sha');
      isAncestorSpy.mockResolvedValue(false);

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await expect(orchestrator.prepare('!42', 'group/project')).rejects.toThrow(
        'local checkout is behind the MR head',
      );
    });

    it('fails when local is ahead of target head', async () => {
      headShaSpy.mockResolvedValue('ahead-commit-sha');
      isAncestorSpy.mockResolvedValue(true);

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await expect(orchestrator.prepare('!42', 'group/project')).rejects.toThrow(
        'local checkout is ahead of the MR head',
      );
    });

    it('fails when current branch does not match source branch', async () => {
      currentBranchSpy.mockResolvedValue('develop');

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await expect(orchestrator.prepare('!42', 'group/project')).rejects.toThrow('does not match the MR source branch');
    });

    it('failed prepare does not modify existing bundle files', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });

      // First successful prepare
      await orchestrator.prepare('!42', 'group/project');
      const bundlePath = path.join(tmpDir, '.revpack', 'bundle.json');
      const originalBundle = await fs.readFile(bundlePath, 'utf-8');

      // Now make local HEAD differ
      headShaSpy.mockResolvedValue('wrong-sha');

      // Second prepare should fail
      await expect(orchestrator.prepare('!42', 'group/project')).rejects.toThrow();

      // Bundle should be unchanged
      const afterBundle = await fs.readFile(bundlePath, 'utf-8');
      expect(afterBundle).toBe(originalBundle);
    });

    it('failed prepare does not update previous/current baseline', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });

      // First successful prepare
      await orchestrator.prepare('!42', 'group/project');

      const ws = new WorkspaceManager(tmpDir);
      const bundleBefore = await ws.loadBundleState();
      const preparedAtBefore = bundleBefore!.preparedAt;

      // Make the second prepare fail
      headShaSpy.mockResolvedValue('different-sha');

      await expect(orchestrator.prepare('!42', 'group/project')).rejects.toThrow();

      // preparedAt should not have changed
      const bundleAfter = await ws.loadBundleState();
      expect(bundleAfter!.preparedAt).toBe(preparedAtBefore);
    });

    it('includes local metadata in bundle.json for successful prepare', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      const result = await orchestrator.prepare('!42', 'group/project');

      expect(result.bundleState.local).toBeDefined();
      expect(result.bundleState.local.headSha).toBe('bbb');
      expect(result.bundleState.local.branch).toBe('feature/test');
      expect(result.bundleState.local.matchesTargetHead).toBe(true);
      expect(result.bundleState.local.matchesTargetSourceBranch).toBe(true);
      expect(result.bundleState.local.workingTreeClean).toBe(true);
    });

    it('prepare after git pull succeeds when HEAD matches', async () => {
      // Simulate: first fail (behind), then succeed after pull
      headShaSpy.mockResolvedValueOnce('old-sha');

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });

      // First attempt fails
      await expect(orchestrator.prepare('!42', 'group/project')).rejects.toThrow('behind the MR head');

      // After "git pull", HEAD now matches
      headShaSpy.mockResolvedValue('bbb');
      const result = await orchestrator.prepare('!42', 'group/project');
      expect(result.mode).toBe('fresh');
    });
  });

  // ─── Thread digest change detection ────────────────────

  describe('thread digest change detection', () => {
    it('without checkpoint, threadsChanged is null', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });

      // First prepare — no checkpoint exists
      await orchestrator.prepare('!42', 'group/project');

      // Add a reply to the thread
      const updatedThread: ReviewThread = {
        ...mockThread,
        comments: [
          ...mockThread.comments,
          {
            id: 'note-reply-1',
            body: 'Thanks for the review, fixing now',
            author: 'alice',
            createdAt: '2026-01-02T00:00:00Z',
            updatedAt: '2026-01-02T00:00:00Z',
            origin: 'human' as const,
            system: false,
          },
        ],
      };
      (mockProvider.listAllThreads as ReturnType<typeof vi.fn>).mockResolvedValue([updatedThread]);

      const second = await orchestrator.prepare('!42', 'group/project');
      // No checkpoint → threadsChanged is null
      expect(second.threadsChanged).toBeNull();
    });

    it('without checkpoint, targetCodeChanged is null', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });

      await orchestrator.prepare('!42', 'group/project');
      const second = await orchestrator.prepare('!42', 'group/project');
      expect(second.targetCodeChanged).toBeNull();
    });
  });

  // ─── Prepare comparison fields ─────────────────────────

  describe('prepare comparison fields', () => {
    it('uses checkpoint-based comparison fields', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      const result = await orchestrator.prepare('!42', 'group/project');

      const ps = result.bundleState.prepare;
      expect(ps).toHaveProperty('comparison');
      expect(ps.comparison).toHaveProperty('targetCodeChangedSinceCheckpoint');
      expect(ps.comparison).toHaveProperty('threadsChangedSinceCheckpoint');
      expect(ps.comparison).toHaveProperty('descriptionChangedSinceCheckpoint');
    });

    it('tracks thread digest in prepare.current', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      const result = await orchestrator.prepare('!42', 'group/project');

      expect(result.bundleState.prepare.current.threadsDigest).toBeTruthy();
      expect(result.bundleState.prepare.current.localHeadSha).toBe('bbb');
      expect(result.bundleState.prepare.current.targetHeadSha).toBe('bbb');
    });
  });

  // ─── Output publish state ──────────────────────────────

  describe('output publish state', () => {
    it('summary without publish hash shows as pending', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await orchestrator.prepare('!42', 'group/project');

      // Write some content to summary
      await fs.writeFile(path.join(tmpDir, '.revpack', 'outputs', 'summary.md'), '# Summary\nThis is a test', 'utf-8');

      const ws = new WorkspaceManager(tmpDir);
      const state = await ws.getOutputState('summary');
      expect(state).toBe('pending');
    });

    it('summary with matching publish hash shows as published', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await orchestrator.prepare('!42', 'group/project');

      const content = '# Summary\nThis is a test';
      await fs.writeFile(path.join(tmpDir, '.revpack', 'outputs', 'summary.md'), content, 'utf-8');

      // Simulate publish by storing hash
      const ws = new WorkspaceManager(tmpDir);
      await ws.updateOutputPublishState('summary', computeContentHash(content), 'bbb');

      const state = await ws.getOutputState('summary');
      expect(state).toBe('published');
    });

    it('edited summary after publish shows as modified since publish', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await orchestrator.prepare('!42', 'group/project');

      const original = '# Summary\nOriginal';
      await fs.writeFile(path.join(tmpDir, '.revpack', 'outputs', 'summary.md'), original, 'utf-8');

      const ws = new WorkspaceManager(tmpDir);
      await ws.updateOutputPublishState('summary', computeContentHash(original), 'bbb');

      // Edit the file
      await fs.writeFile(path.join(tmpDir, '.revpack', 'outputs', 'summary.md'), '# Summary\nEdited', 'utf-8');

      const state = await ws.getOutputState('summary');
      expect(state).toBe('modified since publish');
    });

    it('empty summary shows as empty', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await orchestrator.prepare('!42', 'group/project');

      const ws = new WorkspaceManager(tmpDir);
      const state = await ws.getOutputState('summary');
      expect(state).toBe('empty');
    });

    it('prefills summary from published description marker and marks it as published', async () => {
      const summary = '## Changed\n\n- Updated the login flow.';
      const targetWithPublishedSummary = {
        ...mockTarget,
        description: mergeWithMarkers('Original MR description', summary),
      };
      (mockProvider.getTargetSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(targetWithPublishedSummary);

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await orchestrator.prepare('!42', 'group/project');

      const summaryPath = path.join(tmpDir, '.revpack', 'outputs', 'summary.md');
      await expect(fs.readFile(summaryPath, 'utf-8')).resolves.toBe(summary);

      const ws = new WorkspaceManager(tmpDir);
      await expect(ws.getOutputState('summary')).resolves.toBe('published');
    });

    it('does not overwrite a non-empty summary with the published description marker', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await orchestrator.prepare('!42', 'group/project');

      const summaryPath = path.join(tmpDir, '.revpack', 'outputs', 'summary.md');
      await fs.writeFile(summaryPath, '## Changed\n\n- Local draft.', 'utf-8');

      const targetWithPublishedSummary = {
        ...mockTarget,
        description: mergeWithMarkers('Original MR description', '## Changed\n\n- Published summary.'),
      };
      (mockProvider.getTargetSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(targetWithPublishedSummary);

      await orchestrator.prepare('!42', 'group/project');

      await expect(fs.readFile(summaryPath, 'utf-8')).resolves.toBe('## Changed\n\n- Local draft.');
    });

    it('review without publish hash shows as pending', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await orchestrator.prepare('!42', 'group/project');

      await fs.writeFile(path.join(tmpDir, '.revpack', 'outputs', 'review.md'), '## Notes\nSome notes', 'utf-8');

      const ws = new WorkspaceManager(tmpDir);
      const state = await ws.getOutputState('review');
      expect(state).toBe('pending');
    });

    it('review with matching publish hash shows as published', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await orchestrator.prepare('!42', 'group/project');

      const content = '## Notes\nReview notes';
      await fs.writeFile(path.join(tmpDir, '.revpack', 'outputs', 'review.md'), content, 'utf-8');

      const ws = new WorkspaceManager(tmpDir);
      await ws.updateOutputPublishState('review', computeContentHash(content), 'bbb');

      const state = await ws.getOutputState('review');
      expect(state).toBe('published');
    });

    it('edited review after publish shows as modified since publish', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await orchestrator.prepare('!42', 'group/project');

      const original = '## Notes\nOriginal review notes';
      await fs.writeFile(path.join(tmpDir, '.revpack', 'outputs', 'review.md'), original, 'utf-8');

      const ws = new WorkspaceManager(tmpDir);
      await ws.updateOutputPublishState('review', computeContentHash(original), 'bbb');

      await fs.writeFile(path.join(tmpDir, '.revpack', 'outputs', 'review.md'), '## Notes\nEdited', 'utf-8');

      const state = await ws.getOutputState('review');
      expect(state).toBe('modified since publish');
    });

    it('bundle.json includes outputs section', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      const result = await orchestrator.prepare('!42', 'group/project');

      expect(result.bundleState.outputs).toBeDefined();
      expect(result.bundleState.outputs.summary.path).toBe('.revpack/outputs/summary.md');
      expect(result.bundleState.outputs.review.path).toBe('.revpack/outputs/review.md');
    });
  });

  // ─── Thread items in bundle.json ───────────────────────

  describe('thread items in bundle', () => {
    it('includes thread items with digests', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      const result = await orchestrator.prepare('!42', 'group/project');

      expect(result.bundleState.threads.items).toHaveLength(1);
      expect(result.bundleState.threads.items[0].providerThreadId).toBe('thread-1');
      expect(result.bundleState.threads.items[0].digest).toBeTruthy();
      expect(result.bundleState.threads.items[0].shortId).toBe('T-001');
    });

    it('includes aggregate threads digest', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      const result = await orchestrator.prepare('!42', 'group/project');

      expect(result.bundleState.threads.digest).toBeTruthy();
      expect(result.bundleState.threads.digestVersion).toBe(2);
    });
  });

  // ─── Remote checkpoint tests ───────────────────────────

  describe('remote checkpoint behavior', () => {
    it('prepare with no checkpoint generates fresh review context', async () => {
      // No managed review note exists
      (mockProvider.findNoteByMarker as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      const result = await orchestrator.prepare('!42', 'group/project');

      expect(result.hasCheckpoint).toBe(false);
      expect(result.targetCodeChanged).toBeNull();
      expect(result.threadsChanged).toBeNull();
      expect(result.descriptionChanged).toBeNull();

      // CONTEXT.md should say "No previous revpack review checkpoint"
      const contextMd = await fs.readFile(path.join(tmpDir, '.revpack', 'CONTEXT.md'), 'utf-8');
      expect(contextMd).toContain('No previous revpack review checkpoint');
      expect(contextMd).toContain('Treat this as a fresh review');
    });

    it('prepare with checkpoint compares checkpoint head to current head', async () => {
      // Simulate checkpoint state embedded in the MR description
      const checkpointState = buildCheckpointState(
        targetRef,
        'old-head-sha', // checkpoint head differs from current
        'aaa',
        'aaa',
        'sha256:old-threads-digest',
        'v1',
        'sha256:old-desc-digest',
      );
      const descriptionWithState = patchDescriptionWithState('Test description', checkpointState);

      const targetWithState = { ...mockTarget, description: descriptionWithState };
      (mockProvider.getTargetSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(targetWithState);
      (mockProvider.findNoteByMarker as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      const result = await orchestrator.prepare('!42', 'group/project');

      // Checkpoint head was 'old-head-sha', current is 'bbb' → code changed
      expect(result.hasCheckpoint).toBe(true);
      expect(result.targetCodeChanged).toBe(true);
      expect(result.threadsChanged).toBe(true); // digests differ

      // CONTEXT.md should reference checkpoint
      const contextMd = await fs.readFile(path.join(tmpDir, '.revpack', 'CONTEXT.md'), 'utf-8');
      expect(contextMd).toContain('Review Checkpoint Summary');
      expect(contextMd).toContain('Last review checkpoint');
      expect(contextMd).toContain('old-head-sha');
    });

    it('repeated prepare does not advance checkpoint', async () => {
      const checkpointState = buildCheckpointState(targetRef, 'bbb', 'aaa', 'aaa', null, 'v1');
      const descriptionWithState = patchDescriptionWithState('Test description', checkpointState);

      const targetWithState = { ...mockTarget, description: descriptionWithState };
      (mockProvider.getTargetSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(targetWithState);
      (mockProvider.findNoteByMarker as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });

      // First prepare
      const first = await orchestrator.prepare('!42', 'group/project');
      expect(first.hasCheckpoint).toBe(true);
      expect(first.targetCodeChanged).toBe(false); // head matches checkpoint

      // Second prepare — same checkpoint, same result
      const second = await orchestrator.prepare('!42', 'group/project');
      expect(second.hasCheckpoint).toBe(true);
      expect(second.targetCodeChanged).toBe(false);
      expect(second.threadsChanged).toBeNull(); // checkpoint has no threadsDigest

      // The checkpoint was never advanced by prepare
      expect(mockProvider.updateDescription).not.toHaveBeenCalled();
      expect(mockProvider.createNote).not.toHaveBeenCalled();
    });

    it('repeated prepare before publishing keeps target-code-changed status stable', async () => {
      const checkpointState = buildCheckpointState(targetRef, 'old-head', 'aaa', 'aaa', 'sha256:old-threads', 'v1');
      const descriptionWithState = patchDescriptionWithState('Test description', checkpointState);

      const targetWithState = { ...mockTarget, description: descriptionWithState };
      (mockProvider.getTargetSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(targetWithState);
      (mockProvider.findNoteByMarker as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });

      // Run prepare three times — all should report code changed
      const first = await orchestrator.prepare('!42', 'group/project');
      const second = await orchestrator.prepare('!42', 'group/project');
      const third = await orchestrator.prepare('!42', 'group/project');

      expect(first.targetCodeChanged).toBe(true);
      expect(second.targetCodeChanged).toBe(true);
      expect(third.targetCodeChanged).toBe(true);
    });

    it('incremental patch is generated from checkpoint head to current head', async () => {
      isAncestorSpy.mockResolvedValue(true);
      const checkpointState = buildCheckpointState(targetRef, 'old-head', 'aaa', 'aaa', null, 'v-old');
      const descriptionWithState = patchDescriptionWithState('Test description', checkpointState);

      const targetWithState = { ...mockTarget, description: descriptionWithState };
      (mockProvider.getTargetSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(targetWithState);
      (mockProvider.findNoteByMarker as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await orchestrator.prepare('!42', 'group/project');

      expect(diffForReviewSpy).toHaveBeenCalledWith('aaa', 'bbb');
      expect(diffSpy).toHaveBeenCalledWith('old-head', 'bbb');
    });

    it('writes an unavailable incremental patch when checkpoint head is not an ancestor', async () => {
      isAncestorSpy.mockResolvedValue(false);
      const checkpointState = buildCheckpointState(targetRef, 'old-head', 'aaa', 'aaa', null, 'v-old');
      const descriptionWithState = patchDescriptionWithState('Test description', checkpointState);

      const targetWithState = { ...mockTarget, description: descriptionWithState };
      (mockProvider.getTargetSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(targetWithState);
      (mockProvider.findNoteByMarker as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await orchestrator.prepare('!42', 'group/project');

      expect(diffSpy).not.toHaveBeenCalledWith('old-head', 'bbb');
      const incrementalPatch = await fs.readFile(path.join(tmpDir, '.revpack', 'diffs', 'incremental.patch'), 'utf-8');
      expect(incrementalPatch).toContain('previous review checkpoint is not an ancestor');
    });
  });

  // ─── Publish review tests ──────────────────────────────

  describe('publishReview', () => {
    it('creates visible comment when review content is non-empty', async () => {
      (mockProvider.findNoteByMarker as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      (mockProvider.createNote as ReturnType<typeof vi.fn>).mockResolvedValue('new-note-id');

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      // Need a bundle for resolveRef
      await orchestrator.prepare('!42', 'group/project');

      const result = await orchestrator.publishReview('## Review\nLooks good overall.', 'group/project');

      expect(result.created).toBe(true);
      expect(result.noteId).toBe('new-note-id');
      expect(mockProvider.createNote).toHaveBeenCalledWith(
        expect.objectContaining({ targetId: '42' }),
        expect.stringContaining('Looks good overall'),
      );

      // The visible note should NOT contain hidden checkpoint state
      const noteBody = (mockProvider.createNote as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(noteBody).not.toContain('<!-- revpack:state');
      expect(noteBody).toContain(REVIEW_NOTE_MARKER);
    });

    it('advances checkpoint via description state block', async () => {
      (mockProvider.findNoteByMarker as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      (mockProvider.createNote as ReturnType<typeof vi.fn>).mockResolvedValue('note-id');

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await orchestrator.prepare('!42', 'group/project');

      await orchestrator.publishReview('Review notes.', 'group/project');

      // updateDescription should have been called with the state block
      expect(mockProvider.updateDescription).toHaveBeenCalledWith(
        expect.objectContaining({ targetId: '42' }),
        expect.stringContaining('<!-- revpack:state'),
      );

      // Parse the description to verify the state
      const updatedDesc = (mockProvider.updateDescription as ReturnType<typeof vi.fn>).mock.calls[0][1];
      const state = parseDescriptionState(updatedDesc);
      expect(state).not.toBeNull();
      expect(state!.checkpoint.headSha).toBe('bbb');
      expect(state!.target.id).toBe('42');
    });

    it('with empty review.md publishes no visible comment but advances checkpoint', async () => {
      (mockProvider.findNoteByMarker as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await orchestrator.prepare('!42', 'group/project');

      const result = await orchestrator.publishReview('', 'group/project');

      expect(result.created).toBe(false);
      expect(result.noteId).toBeUndefined();
      // No visible comment created
      expect(mockProvider.createNote).not.toHaveBeenCalled();
      // But description state block was advanced
      expect(mockProvider.updateDescription).toHaveBeenCalledWith(
        expect.objectContaining({ targetId: '42' }),
        expect.stringContaining('<!-- revpack:state'),
      );
    });

    it('published review comments do not contain hidden state', async () => {
      (mockProvider.findNoteByMarker as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      (mockProvider.createNote as ReturnType<typeof vi.fn>).mockResolvedValue('new-note-id');

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await orchestrator.prepare('!42', 'group/project');

      await orchestrator.publishReview('Some review body text.', 'group/project');

      const noteBody = (mockProvider.createNote as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(noteBody).not.toContain('<!-- revpack:state');
      expect(noteBody).toContain('Some review body text.');
      expect(noteBody).toContain('Generated by ');
    });
  });

  // ─── State recovery tests ─────────────────────────────

  describe('state recovery', () => {
    it('reconstructs checkpoint from description state after deleting .revpack/', async () => {
      const checkpointState = buildCheckpointState(targetRef, 'old-head', 'aaa', 'aaa', 'sha256:old-threads', 'v1');
      const descriptionWithState = patchDescriptionWithState('Original description.', checkpointState);

      const targetWithState = { ...mockTarget, description: descriptionWithState };
      (mockProvider.getTargetSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(targetWithState);
      (mockProvider.findNoteByMarker as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });

      // First prepare — checkpoint is found
      const first = await orchestrator.prepare('!42', 'group/project');
      expect(first.hasCheckpoint).toBe(true);
      expect(first.targetCodeChanged).toBe(true); // old-head != bbb

      // Delete .revpack/
      await fs.rm(path.join(tmpDir, '.revpack'), { recursive: true, force: true });

      // Second prepare — reconstructs state from description
      const second = await orchestrator.prepare('!42', 'group/project');
      expect(second.hasCheckpoint).toBe(true);
      expect(second.targetCodeChanged).toBe(true); // still reports changes vs checkpoint
      expect(second.mode).toBe('fresh'); // no local bundle → fresh mode

      // Context should still reference the checkpoint
      const contextMd = await fs.readFile(path.join(tmpDir, '.revpack', 'CONTEXT.md'), 'utf-8');
      expect(contextMd).toContain('Review Checkpoint Summary');
      expect(contextMd).toContain('old-head');
    });
  });
});
