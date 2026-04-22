import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ReviewOrchestrator } from '../orchestration/orchestrator.js';
import { WorkspaceManager } from '../workspace/workspace-manager.js';
import { GitHelper } from '../workspace/git-helper.js';
import type { ReviewProvider } from '../providers/provider.js';
import type { ReviewTarget, ReviewThread, ReviewDiff, ReviewVersion, ReviewTargetRef } from '../core/types.js';

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

const mockDiff: ReviewDiff = {
  oldPath: 'src/app.ts',
  newPath: 'src/app.ts',
  diff: '+added line',
  newFile: false,
  renamedFile: false,
  deletedFile: false,
};

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
    getLatestDiff: vi.fn().mockResolvedValue([mockDiff]),
    getDiffVersions: vi.fn().mockResolvedValue([mockVersion]),
    getIncrementalDiff: vi.fn().mockResolvedValue([mockDiff]),
    postReply: vi.fn().mockResolvedValue(undefined),
    resolveThread: vi.fn().mockResolvedValue(undefined),
    updateDescription: vi.fn().mockResolvedValue(undefined),
    createThread: vi.fn().mockResolvedValue('new-thread-id'),
    findNoteByMarker: vi.fn().mockResolvedValue(null),
    createNote: vi.fn().mockResolvedValue('note-1'),
    updateNote: vi.fn().mockResolvedValue(undefined),
  };
}

describe('ReviewOrchestrator', () => {
  let mockProvider: ReviewProvider;
  let tmpDir: string;

  beforeEach(async () => {
    mockProvider = createMockProvider();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-orch-test-'));
  });

  afterEach(async () => {
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

  describe('classifyThreads', () => {
    it('classifies threads into findings', () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      const findings = orchestrator.classifyThreads([mockThread], mockTarget);

      expect(findings).toHaveLength(1);
      expect(findings[0].type).toBe('finding');
      expect(findings[0].severity).toBe('blocker'); // "security vulnerability"
      expect(findings[0].category).toBe('security');
      expect(findings[0].status).toBe('unreviewed');
    });
  });

  describe('publishReply', () => {
    it('calls provider.postReply', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await orchestrator.publishReply('!42', 'thread-1', 'Thanks, fixed!', 'group/project');

      expect(mockProvider.postReply).toHaveBeenCalledWith(targetRef, 'thread-1', 'Thanks, fixed!');
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

  describe('review', () => {
    it('creates bundle, summary, findings, and CONTEXT.md', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      const result = await orchestrator.review('!42', 'group/project');

      expect(result.bundle.target.title).toBe('Test MR');
      expect(result.bundle.threads).toHaveLength(1);
      expect(result.bundle.diffs).toHaveLength(1);
      expect(result.findings).toHaveLength(1);
      expect(result.summaryMarkdown).toContain('## Summary');
      expect(result.contextPath).toContain('CONTEXT.md');
      expect(result.incremental).toBe(false);
    });

    it('writes outputs to disk', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await orchestrator.review('!42', 'group/project');

      const bundleDir = path.join(tmpDir, '.review-assist');
      const contextMd = await fs.readFile(path.join(bundleDir, 'CONTEXT.md'), 'utf-8');
      const summaryMd = await fs.readFile(path.join(bundleDir, 'outputs', 'summary.md'), 'utf-8');
      const findingsJson = await fs.readFile(path.join(bundleDir, 'outputs', 'findings.json'), 'utf-8');

      expect(contextMd).toContain('Test MR');
      expect(summaryMd).toContain('## Summary');
      expect(JSON.parse(findingsJson)).toHaveLength(1);
    });

    it('saves session for future incremental runs', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await orchestrator.review('!42', 'group/project');

      const sessionPath = path.join(tmpDir, '.review-assist', 'session.json');
      const session = JSON.parse(await fs.readFile(sessionPath, 'utf-8'));
      expect(session.targetRef.targetId).toBe('42');
      expect(session.lastReviewedVersionId).toBe('v1');
      expect(session.knownThreadIds).toContain('thread-1');
    });

    it('detects incremental mode from existing session', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });

      // First run creates session
      const first = await orchestrator.review('!42', 'group/project');
      expect(first.incremental).toBe(false);

      // Second run detects session and goes incremental
      const second = await orchestrator.review('!42', 'group/project');
      expect(second.incremental).toBe(true);
    });

    it('--full clears session and starts fresh', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });

      // First run creates session
      await orchestrator.review('!42', 'group/project');

      // Second run with --full should not be incremental
      const result = await orchestrator.review('!42', 'group/project', { full: true });
      expect(result.incremental).toBe(false);
    });

    it('attempts incremental diff when session exists', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });

      // First run
      await orchestrator.review('!42', 'group/project');

      // Second run should call getIncrementalDiff
      await orchestrator.review('!42', 'group/project');

      expect(mockProvider.getIncrementalDiff).toHaveBeenCalled();
    });

    it('resumes from session when no ref is provided', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });

      // First run establishes session
      await orchestrator.review('!42', 'group/project');

      // Second run without ref should use session
      const result = await orchestrator.review(undefined, 'group/project');
      expect(result.bundle.target.targetId).toBe('42');
    });

    it('throws when no ref and no session', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });

      await expect(orchestrator.review(undefined, 'group/project'))
        .rejects.toThrow('Could not determine which MR to review');
    });

    it('returns incremental stats on second run', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });

      // First run
      const first = await orchestrator.review('!42', 'group/project');
      expect(first.prunedReplies).toBe(0);
      expect(first.resolvedSinceLastReview).toBe(0);
      expect(first.newThreadCount).toBe(0);
      expect(first.publishedActionCount).toBe(0);

      // Add a new thread for second run
      const newThread: ReviewThread = {
        ...mockThread,
        threadId: 'thread-new',
      };
      (mockProvider.listAllThreads as ReturnType<typeof vi.fn>)
        .mockResolvedValue([mockThread, newThread]);

      const second = await orchestrator.review('!42', 'group/project');
      expect(second.incremental).toBe(true);
      expect(second.newThreadCount).toBe(1);
    });

    it('preserves publishedActions across review runs', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });

      // First run
      await orchestrator.review('!42', 'group/project');

      // Simulate publishing a reply (write directly to session)
      const ws = new WorkspaceManager(tmpDir);
      await ws.appendPublishedAction({
        type: 'reply',
        threadId: 'T-001',
        detail: 'Fixed!',
        publishedAt: '2026-01-01T12:00:00Z',
      });

      // Second run should carry over the action
      const second = await orchestrator.review('!42', 'group/project');
      expect(second.publishedActionCount).toBe(1);

      // Session should still have the action
      const session = await ws.loadSession();
      expect(session!.publishedActions).toHaveLength(1);
      expect(session!.publishedActions![0].type).toBe('reply');
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
      (mockProvider.listAllThreads as ReturnType<typeof vi.fn>)
        .mockResolvedValue([systemThread, mockThread, generalComment]);

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      const result = await orchestrator.review('!42', 'group/project');

      // Bundle should have 2 threads: mockThread + generalComment (not system)
      expect(result.bundle.threads).toHaveLength(2);
      expect(result.bundle.threads.map((t) => t.threadId)).toEqual(['thread-1', 'general-comment-1']);

      // Thread files: T-001 = mockThread (index 0 after filtering), T-002 = generalComment
      const threadDir = path.join(tmpDir, '.review-assist', 'threads');
      const files = (await fs.readdir(threadDir)).filter(f => f.endsWith('.json')).sort();
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

      // Need a session for resolveRef to work without explicit ref
      await orchestrator.review('!42', 'group/project');

      const finding = {
        filePath: 'src/app.ts',
        line: 42,
        body: 'Potential null dereference here',
        severity: 'high' as const,
        category: 'correctness',
      };

      const threadId = await orchestrator.publishFinding(finding, 'group/project');
      expect(threadId).toBe('new-thread-id');
      expect(mockProvider.createThread).toHaveBeenCalledWith(
        expect.objectContaining({ targetId: '42' }),
        'Potential null dereference here',
        { filePath: 'src/app.ts', newLine: 42 },
      );
    });
  });

  describe('resolveRef auto-detect from branch', () => {
    let deriveSlugSpy: ReturnType<typeof vi.spyOn>;
    let currentBranchSpy: ReturnType<typeof vi.spyOn>;

    afterEach(() => {
      deriveSlugSpy?.mockRestore();
      currentBranchSpy?.mockRestore();
    });

    it('auto-detects MR when a single open MR matches the current branch', async () => {
      deriveSlugSpy = vi.spyOn(GitHelper.prototype, 'deriveRepoSlug').mockResolvedValue('group/project');
      currentBranchSpy = vi.spyOn(GitHelper.prototype, 'currentBranch').mockResolvedValue('feature/test');
      (mockProvider.findTargetByBranch as ReturnType<typeof vi.fn>).mockResolvedValue([mockTarget]);

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      const result = await orchestrator.review(undefined, undefined);

      expect(mockProvider.findTargetByBranch).toHaveBeenCalledWith('group/project', 'feature/test');
      expect(result.bundle.target.targetId).toBe('42');
    });

    it('throws descriptive error when multiple MRs match the branch', async () => {
      deriveSlugSpy = vi.spyOn(GitHelper.prototype, 'deriveRepoSlug').mockResolvedValue('group/project');
      currentBranchSpy = vi.spyOn(GitHelper.prototype, 'currentBranch').mockResolvedValue('feature/test');

      const secondTarget: ReviewTarget = { ...mockTarget, targetId: '99' };
      (mockProvider.findTargetByBranch as ReturnType<typeof vi.fn>).mockResolvedValue([mockTarget, secondTarget]);

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await expect(orchestrator.review(undefined, undefined))
        .rejects.toThrow('Multiple open MRs found for branch "feature/test": !42, !99');
    });

    it('throws when no MR found for the current branch', async () => {
      deriveSlugSpy = vi.spyOn(GitHelper.prototype, 'deriveRepoSlug').mockResolvedValue('group/project');
      currentBranchSpy = vi.spyOn(GitHelper.prototype, 'currentBranch').mockResolvedValue('feature/orphan');
      (mockProvider.findTargetByBranch as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await expect(orchestrator.review(undefined, undefined))
        .rejects.toThrow('Could not determine which MR to review');
    });

    it('falls through to error on detached HEAD', async () => {
      deriveSlugSpy = vi.spyOn(GitHelper.prototype, 'deriveRepoSlug').mockResolvedValue('group/project');
      currentBranchSpy = vi.spyOn(GitHelper.prototype, 'currentBranch').mockResolvedValue('HEAD');

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await expect(orchestrator.review(undefined, undefined))
        .rejects.toThrow('Could not determine which MR to review');
      expect(mockProvider.findTargetByBranch).not.toHaveBeenCalled();
    });

    it('uses defaultRepo when deriveRepoSlug fails', async () => {
      deriveSlugSpy = vi.spyOn(GitHelper.prototype, 'deriveRepoSlug').mockRejectedValue(new Error('not a git repo'));
      currentBranchSpy = vi.spyOn(GitHelper.prototype, 'currentBranch').mockResolvedValue('feature/test');
      (mockProvider.findTargetByBranch as ReturnType<typeof vi.fn>).mockResolvedValue([mockTarget]);

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      const result = await orchestrator.review(undefined, 'group/project');

      expect(mockProvider.findTargetByBranch).toHaveBeenCalledWith('group/project', 'feature/test');
      expect(result.bundle.target.targetId).toBe('42');
    });

    it('prefers session over auto-detect', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });

      // First run creates session
      await orchestrator.review('!42', 'group/project');

      // Spy after session is created — should not be called
      deriveSlugSpy = vi.spyOn(GitHelper.prototype, 'deriveRepoSlug');
      currentBranchSpy = vi.spyOn(GitHelper.prototype, 'currentBranch');

      // Second run should use session, not auto-detect
      const result = await orchestrator.review(undefined, 'group/project');
      expect(result.bundle.target.targetId).toBe('42');
      expect(mockProvider.findTargetByBranch).not.toHaveBeenCalled();
    });
  });
});
