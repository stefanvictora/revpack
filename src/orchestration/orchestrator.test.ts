import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ReviewOrchestrator } from '../orchestration/orchestrator.js';
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
    getTargetSnapshot: vi.fn().mockResolvedValue(mockTarget),
    listUnresolvedThreads: vi.fn().mockResolvedValue([mockThread]),
    listAllThreads: vi.fn().mockResolvedValue([mockThread]),
    getLatestDiff: vi.fn().mockResolvedValue([mockDiff]),
    getDiffVersions: vi.fn().mockResolvedValue([mockVersion]),
    getIncrementalDiff: vi.fn().mockResolvedValue([mockDiff]),
    postReply: vi.fn().mockResolvedValue(undefined),
    resolveThread: vi.fn().mockResolvedValue(undefined),
    updateDescription: vi.fn().mockResolvedValue(undefined),
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
        .rejects.toThrow('No MR/PR reference provided');
    });
  });
});
