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
import { AuthenticationError } from '../core/errors.js';
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
    createNote: vi.fn().mockResolvedValue('note-1'),
    updateNote: vi.fn().mockResolvedValue(undefined),
    getCloneUrl: vi.fn().mockReturnValue('https://gitlab.example.com/group/project.git'),
    getCheckoutFallbackRef: vi.fn().mockReturnValue({
      remoteRef: 'refs/merge-requests/42/head',
      localBranch: 'revpack/mr-42',
    }),
    getCheckoutFallbackBranch: vi.fn().mockImplementation((target: { id?: string; targetId?: string }) => {
      const targetId = target.targetId ?? target.id;
      return targetId ? `revpack/mr-${targetId}` : null;
    }),
    formatCheckoutFallbackError: vi
      .fn()
      .mockImplementation(
        (target: ReviewTarget, sourceError: unknown, fallbackError: unknown) =>
          new Error(
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
              `Source branch fetch failed: ${sourceError instanceof Error ? sourceError.message : String(sourceError)}`,
              `MR head ref fetch failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
            ].join('\n'),
          ),
      ),
  };
}

function createBitbucketMockProvider(overrides: Partial<ReviewProvider> = {}): ReviewProvider {
  const bitbucketRef: ReviewTargetRef = {
    provider: 'bitbucket-cloud',
    repository: 'workspace/repo',
    targetType: 'pull_request',
    targetId: '21',
  };
  const bitbucketTarget: ReviewTarget = {
    ...bitbucketRef,
    title: 'Bitbucket PR',
    description: 'PR body',
    author: 'alice',
    state: 'OPEN',
    sourceBranch: 'feature/bitbucket',
    targetBranch: 'main',
    webUrl: 'https://bitbucket.org/workspace/repo/pull-requests/21',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    labels: [],
    diffRefs: { baseSha: 'aaa', headSha: 'bbb', startSha: 'aaa' },
  };
  const bitbucketVersion: ReviewVersion = {
    provider: 'bitbucket-cloud',
    targetRef: bitbucketRef,
    versionId: 'bbb',
    headCommitSha: 'bbb',
    baseCommitSha: 'aaa',
    startCommitSha: 'aaa',
    createdAt: '2026-01-02T00:00:00Z',
  };

  return {
    providerType: 'bitbucket-cloud',
    supportsDirectCommitFetch: false,
    resolveTarget: vi.fn().mockReturnValue(bitbucketRef),
    listOpenReviewTargets: vi.fn().mockResolvedValue([bitbucketTarget]),
    findTargetByBranch: vi.fn().mockResolvedValue([bitbucketTarget]),
    getTargetSnapshot: vi.fn().mockResolvedValue(bitbucketTarget),
    listUnresolvedThreads: vi.fn().mockResolvedValue([]),
    listAllThreads: vi.fn().mockResolvedValue([]),
    getDiffVersions: vi.fn().mockResolvedValue([bitbucketVersion]),
    postReply: vi.fn().mockRejectedValue(new Error('unsupported')),
    resolveThread: vi.fn().mockRejectedValue(new Error('unsupported')),
    updateDescription: vi.fn().mockResolvedValue(undefined),
    createThread: vi.fn().mockRejectedValue(new Error('unsupported')),
    createNote: vi.fn().mockRejectedValue(new Error('unsupported')),
    updateNote: vi.fn().mockRejectedValue(new Error('unsupported')),
    getCloneUrl: vi.fn((repo: string) => `https://bitbucket.org/${repo}.git`),
    ...overrides,
  };
}

async function captureError<T>(promise: Promise<T>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw new Error('Expected promise to reject with an Error', { cause: error });
  }
  throw new Error('Expected promise to reject');
}

describe('ReviewOrchestrator', () => {
  let mockProvider: ReviewProvider;
  let tmpDir: string;
  let headShaSpy: MockInstance<(...args: any[]) => any>;
  let currentBranchSpy: MockInstance<(...args: any[]) => any>;
  let repositoryRootSpy: MockInstance<(...args: any[]) => any>;
  let isAncestorSpy: MockInstance<(...args: any[]) => any>;
  let hasCommitSpy: MockInstance<(...args: any[]) => any>;
  let fetchCommitSpy: MockInstance<(...args: any[]) => any>;
  let fetchSpy: MockInstance<(...args: any[]) => any>;
  let fetchBranchSpy: MockInstance<(...args: any[]) => any>;
  let fetchBranchFromUrlSpy: MockInstance<(...args: any[]) => any>;
  let fetchRefSpy: MockInstance<(...args: any[]) => any>;
  let isGitRepoSpy: MockInstance<(...args: any[]) => any>;
  let switchBranchSpy: MockInstance<(...args: any[]) => any>;
  let diffForReviewSpy: MockInstance<(...args: any[]) => any>;
  let diffSpy: MockInstance<(...args: any[]) => any>;

  beforeEach(async () => {
    mockProvider = createMockProvider();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-orch-test-'));
    // Mock git operations so tests work in non-git temp dirs
    headShaSpy = vi.spyOn(GitHelper.prototype, 'headSha').mockResolvedValue('bbb');
    currentBranchSpy = vi.spyOn(GitHelper.prototype, 'currentBranch').mockResolvedValue('feature/test');
    repositoryRootSpy = vi.spyOn(GitHelper.prototype, 'repositoryRoot').mockResolvedValue(tmpDir);
    isAncestorSpy = vi.spyOn(GitHelper.prototype, 'isAncestor').mockResolvedValue(false);
    hasCommitSpy = vi.spyOn(GitHelper.prototype, 'hasCommit').mockResolvedValue(true);
    fetchCommitSpy = vi.spyOn(GitHelper.prototype, 'fetchCommit').mockResolvedValue(undefined);
    fetchSpy = vi.spyOn(GitHelper.prototype, 'fetch').mockResolvedValue(undefined);
    fetchBranchSpy = vi.spyOn(GitHelper.prototype, 'fetchBranch').mockResolvedValue(undefined);
    fetchBranchFromUrlSpy = vi.spyOn(GitHelper.prototype, 'fetchBranchFromUrl').mockResolvedValue(undefined);
    fetchRefSpy = vi.spyOn(GitHelper.prototype, 'fetchRef').mockResolvedValue(undefined);
    isGitRepoSpy = vi.spyOn(GitHelper.prototype, 'isGitRepo').mockResolvedValue(true);
    switchBranchSpy = vi.spyOn(GitHelper.prototype, 'switchBranch').mockResolvedValue(undefined);
    diffForReviewSpy = vi.spyOn(GitHelper.prototype, 'diffForReview').mockResolvedValue(localPatch());
    diffSpy = vi.spyOn(GitHelper.prototype, 'diff').mockResolvedValue(localPatch());
  });

  afterEach(async () => {
    headShaSpy.mockRestore();
    currentBranchSpy.mockRestore();
    repositoryRootSpy.mockRestore();
    isAncestorSpy.mockRestore();
    hasCommitSpy.mockRestore();
    fetchCommitSpy.mockRestore();
    fetchSpy.mockRestore();
    fetchBranchSpy.mockRestore();
    fetchBranchFromUrlSpy.mockRestore();
    fetchRefSpy.mockRestore();
    isGitRepoSpy.mockRestore();
    switchBranchSpy.mockRestore();
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

  describe('checkout', () => {
    it('checks out a GitLab MR through the normal source branch path', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });

      const result = await orchestrator.checkout('!42', 'group/project');

      expect(result.branch).toBe('feature/test');
      expect(fetchBranchSpy).toHaveBeenCalledWith('feature/test');
      expect(fetchRefSpy).not.toHaveBeenCalled();
      expect(switchBranchSpy).toHaveBeenCalledWith('feature/test');
    });

    it('falls back to the GitLab MR head ref when the source branch fetch fails', async () => {
      fetchBranchSpy.mockRejectedValueOnce(new Error('could not find remote ref feature/test'));
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });

      const result = await orchestrator.checkout('!42', 'group/project');

      expect(result.branch).toBe('revpack/mr-42');
      expect(fetchBranchSpy).toHaveBeenCalledWith('feature/test');
      expect(fetchRefSpy).toHaveBeenCalledWith('origin', 'refs/merge-requests/42/head', 'revpack/mr-42');
      expect(switchBranchSpy).toHaveBeenCalledWith('revpack/mr-42');
    });

    it('fetches the fallback ref from the base repository when source branch fetch from fork fails', async () => {
      (mockProvider.getTargetSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...mockTarget,
        headRepository: 'alice/project',
      });
      (mockProvider.getCloneUrl as ReturnType<typeof vi.fn>).mockImplementation(
        (repo: string) => `https://gitlab.example.com/${repo}.git`,
      );
      fetchBranchFromUrlSpy.mockRejectedValueOnce(new Error('could not find remote ref feature/test'));
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });

      const result = await orchestrator.checkout('!42', 'group/project');

      expect(result.branch).toBe('revpack/mr-42');
      expect(fetchBranchFromUrlSpy).toHaveBeenCalledWith(
        'https://gitlab.example.com/alice/project.git',
        'feature/test',
      );
      expect(fetchRefSpy).toHaveBeenCalledWith(
        'https://gitlab.example.com/group/project.git',
        'refs/merge-requests/42/head',
        'revpack/mr-42',
      );
      expect(switchBranchSpy).toHaveBeenCalledWith('revpack/mr-42');
    });

    it('fails with a GitLab-specific message when source branch and MR head ref fetches fail', async () => {
      fetchBranchSpy.mockRejectedValueOnce(new Error('could not find remote ref feature/test'));
      fetchRefSpy.mockRejectedValueOnce(new Error('could not find remote ref refs/merge-requests/42/head'));
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });

      const error = await captureError(orchestrator.checkout('!42', 'group/project'));

      expect(error.message).toContain('Could not check out GitLab merge request !42.');
      expect(error.message).toContain('The source branch "feature/test" may have been deleted.');
      expect(error.message).toContain('refs/merge-requests/42/head');
      expect(error.message).toContain('GitLab 16.6 and newer');
      expect(error.message).toContain('14 days after merge or close');
      expect(error.message).toContain('unless the source branch or head commit is still reachable');
      expect(switchBranchSpy).not.toHaveBeenCalled();
    });

    it('keeps GitHub checkout on the provider source refspec path', async () => {
      const githubRef: ReviewTargetRef = {
        provider: 'github',
        repository: 'owner/project',
        targetType: 'pull_request',
        targetId: '58',
      };
      const githubTarget: ReviewTarget = {
        ...githubRef,
        title: 'Test PR',
        description: 'Test',
        author: 'alice',
        state: 'open',
        sourceBranch: 'feature/github',
        targetBranch: 'main',
        webUrl: 'https://github.com/owner/project/pull/58',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        labels: [],
        diffRefs: { baseSha: 'aaa', headSha: 'bbb', startSha: 'aaa' },
      };
      const githubProvider: ReviewProvider = {
        ...mockProvider,
        providerType: 'github',
        resolveTarget: vi.fn().mockResolvedValue(githubRef),
        getTargetSnapshot: vi.fn().mockResolvedValue(githubTarget),
        getCloneUrl: vi.fn().mockReturnValue('https://github.com/owner/project.git'),
        getSourceRefspec: vi.fn().mockReturnValue('refs/pull/58/head'),
      };
      const orchestrator = new ReviewOrchestrator({ provider: githubProvider, workingDir: tmpDir });

      const result = await orchestrator.checkout('58', 'owner/project');

      expect(result.branch).toBe('feature/github');
      expect(fetchRefSpy).toHaveBeenCalledWith('origin', 'refs/pull/58/head', 'feature/github');
      expect(fetchBranchSpy).not.toHaveBeenCalled();
      expect(fetchBranchFromUrlSpy).not.toHaveBeenCalled();
      expect(switchBranchSpy).toHaveBeenCalledWith('feature/github');
    });

    it('checks out a same-repository Bitbucket Cloud pull request from its source branch', async () => {
      const bitbucketProvider = createBitbucketMockProvider();
      const orchestrator = new ReviewOrchestrator({ provider: bitbucketProvider, workingDir: tmpDir });

      const result = await orchestrator.checkout('21', 'workspace/repo');

      expect(result.branch).toBe('feature/bitbucket');
      expect(fetchBranchSpy).toHaveBeenCalledWith('feature/bitbucket');
      expect(fetchRefSpy).not.toHaveBeenCalled();
      expect(fetchBranchFromUrlSpy).not.toHaveBeenCalled();
      expect(switchBranchSpy).toHaveBeenCalledWith('feature/bitbucket');
    });

    it('checks out a fork Bitbucket Cloud pull request from the source repository URL', async () => {
      const forkRef: ReviewTargetRef = {
        provider: 'bitbucket-cloud',
        repository: 'workspace/repo',
        targetType: 'pull_request',
        targetId: '21',
      };
      const forkTarget = {
        ...(await createBitbucketMockProvider().getTargetSnapshot(forkRef)),
        headRepository: 'contributor/repo',
      };
      const bitbucketProvider = createBitbucketMockProvider({
        getTargetSnapshot: vi.fn().mockResolvedValue(forkTarget),
      });
      const orchestrator = new ReviewOrchestrator({ provider: bitbucketProvider, workingDir: tmpDir });

      const result = await orchestrator.checkout('21', 'workspace/repo');

      expect(result.branch).toBe('feature/bitbucket');
      expect(fetchBranchFromUrlSpy).toHaveBeenCalledWith(
        'https://bitbucket.org/contributor/repo.git',
        'feature/bitbucket',
      );
      expect(fetchRefSpy).not.toHaveBeenCalled();
      expect(fetchBranchSpy).not.toHaveBeenCalled();
      expect(switchBranchSpy).toHaveBeenCalledWith('feature/bitbucket');
    });

    it('explains unreachable Bitbucket Cloud source branches without using a permanent PR refspec', async () => {
      fetchBranchSpy.mockRejectedValueOnce(new Error('could not find remote ref feature/bitbucket'));
      const bitbucketProvider = createBitbucketMockProvider();
      const orchestrator = new ReviewOrchestrator({ provider: bitbucketProvider, workingDir: tmpDir });

      const error = await captureError(orchestrator.checkout('21', 'workspace/repo'));

      expect(error.message).toContain('The source branch "feature/bitbucket" is no longer reachable.');
      expect(error.message).toContain('This provider did not expose a checkout fallback ref');
      expect(error.message).toContain('Source branch fetch failed: could not find remote ref feature/bitbucket');
      expect(fetchRefSpy).not.toHaveBeenCalled();
      expect(switchBranchSpy).not.toHaveBeenCalled();
    });

    it('shallow-clones a Bitbucket Cloud pull request source branch outside a git repo', async () => {
      isGitRepoSpy.mockResolvedValueOnce(false);
      const clonedTo = path.join(tmpDir, 'repo-feature-bitbucket');
      const cloneSpy = vi.spyOn(GitHelper, 'clone').mockResolvedValue(clonedTo);
      const bitbucketProvider = createBitbucketMockProvider();
      const orchestrator = new ReviewOrchestrator({ provider: bitbucketProvider, workingDir: tmpDir });

      try {
        const result = await orchestrator.checkout('21', 'workspace/repo');

        expect(result).toMatchObject({ branch: 'feature/bitbucket', clonedTo });
        expect(cloneSpy).toHaveBeenCalledWith('https://bitbucket.org/workspace/repo.git', 'feature/bitbucket', tmpDir);
        expect(fetchRefSpy).not.toHaveBeenCalled();
      } finally {
        cloneSpy.mockRestore();
      }
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

    it('prepares Bitbucket Cloud pull requests from local git diff artifacts', async () => {
      currentBranchSpy.mockResolvedValue('feature/bitbucket');
      const bitbucketProvider = createBitbucketMockProvider();
      const orchestrator = new ReviewOrchestrator({ provider: bitbucketProvider, workingDir: tmpDir });

      const result = await orchestrator.prepare('21', 'workspace/repo');

      expect(diffForReviewSpy).toHaveBeenCalledWith('aaa', 'bbb');
      expect(result.bundle.target.provider).toBe('bitbucket-cloud');
      expect(result.bundle.versions[0]).toMatchObject({
        versionId: 'bbb',
        headCommitSha: 'bbb',
        baseCommitSha: 'aaa',
        startCommitSha: 'aaa',
      });
      expect(result.bundleState.local).toMatchObject({
        branch: 'feature/bitbucket',
        headSha: 'bbb',
        matchesTargetSourceBranch: true,
        matchesTargetHead: true,
      });

      const diffsDir = path.join(tmpDir, '.revpack', 'diffs');
      const latestPatch = await fs.readFile(path.join(diffsDir, 'latest.patch'), 'utf-8');
      const filesJson = JSON.parse(await fs.readFile(path.join(diffsDir, 'files.json'), 'utf-8')) as {
        files: Array<{ newPath: string; oldPath: string; patchFile: string }>;
      };
      const lineMap = await fs.readFile(path.join(diffsDir, 'line-map.ndjson'), 'utf-8');
      const changeBlocks = JSON.parse(await fs.readFile(path.join(diffsDir, 'change-blocks.json'), 'utf-8')) as {
        blocks: unknown[];
      };
      const perFilePatch = await fs.readFile(path.join(diffsDir, filesJson.files[0].patchFile), 'utf-8');

      expect(latestPatch).toBe(localPatch());
      expect(filesJson.files[0]).toMatchObject({ oldPath: 'src/app.ts', newPath: 'src/app.ts' });
      expect(filesJson.files[0].patchFile).toMatch(/patches\/by-file\/F001-/);
      expect(lineMap).toContain('"fileId":"F001"');
      expect(changeBlocks.blocks).toHaveLength(1);
      expect(perFilePatch).toBe(localPatch());
    });

    it('accepts Bitbucket Cloud abbreviated head hashes when local HEAD expands them', async () => {
      const shortHeadSha = 'fb0aebbd3d5b';
      const fullHeadSha = 'fb0aebbd3d5b858c6024745659c9f4211d186589';
      currentBranchSpy.mockResolvedValue('feature/bitbucket');
      headShaSpy.mockResolvedValue(fullHeadSha);
      const bitbucketProvider = createBitbucketMockProvider({
        getTargetSnapshot: vi.fn().mockResolvedValue({
          ...(await createBitbucketMockProvider().getTargetSnapshot({
            provider: 'bitbucket-cloud',
            repository: 'workspace/repo',
            targetType: 'pull_request',
            targetId: '21',
          })),
          diffRefs: { baseSha: 'aaa', headSha: shortHeadSha, startSha: 'aaa' },
        }),
        getDiffVersions: vi.fn().mockResolvedValue([
          {
            provider: 'bitbucket-cloud',
            targetRef: {
              provider: 'bitbucket-cloud',
              repository: 'workspace/repo',
              targetType: 'pull_request',
              targetId: '21',
            },
            versionId: shortHeadSha,
            headCommitSha: shortHeadSha,
            baseCommitSha: 'aaa',
            startCommitSha: 'aaa',
            createdAt: '2026-01-02T00:00:00Z',
          },
        ]),
      });
      const orchestrator = new ReviewOrchestrator({ provider: bitbucketProvider, workingDir: tmpDir });

      const result = await orchestrator.prepare('21', 'workspace/repo');

      expect(result.bundleState.local).toMatchObject({
        headSha: fullHeadSha,
        matchesTargetHead: true,
      });
      expect(result.bundleState.prepare.current.targetHeadSha).toBe(shortHeadSha);
      expect(diffForReviewSpy).toHaveBeenCalledWith('aaa', shortHeadSha);
    });

    it('fetches target branches instead of Bitbucket Cloud commit hashes', async () => {
      const fullBaseSha = '0731551ad42031e97ee04a34c7fe40e3bd906833';
      const fullHeadSha = 'fb0aebbd3d5b858c6024745659c9f4211d186589';
      currentBranchSpy.mockResolvedValue('feature/bitbucket');
      headShaSpy.mockResolvedValue(fullHeadSha);
      hasCommitSpy
        .mockResolvedValueOnce(false) // initial check baseSha
        .mockResolvedValueOnce(true) // initial check headSha
        .mockResolvedValueOnce(true) // after fetchBranch(targetBranch): baseSha resolved
        .mockResolvedValueOnce(true); // after fetchBranch(targetBranch): headSha ok

      const bitbucketProvider = createBitbucketMockProvider({
        getTargetSnapshot: vi.fn().mockResolvedValue({
          ...(await createBitbucketMockProvider().getTargetSnapshot({
            provider: 'bitbucket-cloud',
            repository: 'workspace/repo',
            targetType: 'pull_request',
            targetId: '21',
          })),
          diffRefs: { baseSha: fullBaseSha, headSha: fullHeadSha, startSha: fullBaseSha },
        }),
        getDiffVersions: vi.fn().mockResolvedValue([
          {
            provider: 'bitbucket-cloud',
            targetRef: {
              provider: 'bitbucket-cloud',
              repository: 'workspace/repo',
              targetType: 'pull_request',
              targetId: '21',
            },
            versionId: fullHeadSha,
            headCommitSha: fullHeadSha,
            baseCommitSha: fullBaseSha,
            startCommitSha: fullBaseSha,
            createdAt: '2026-01-02T00:00:00Z',
          },
        ]),
      });
      const orchestrator = new ReviewOrchestrator({ provider: bitbucketProvider, workingDir: tmpDir });

      await orchestrator.prepare('21', 'workspace/repo', { onProgress: vi.fn() });

      expect(fetchCommitSpy).not.toHaveBeenCalled();
      expect(fetchBranchSpy).toHaveBeenCalledWith('main', 'origin', { depth: 1, noTags: true, progress: true });
      expect(diffForReviewSpy).toHaveBeenCalledWith(fullBaseSha, fullHeadSha);
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

    it('falls through to fetchBranch(targetBranch) when fetchCommit does not resolve', async () => {
      // Both commits missing initially; fetchCommit for each fails to resolve them;
      // re-check still missing; then fetchBranch(targetBranch) resolves them.
      hasCommitSpy
        .mockResolvedValueOnce(false) // initial check baseSha
        .mockResolvedValueOnce(false) // initial check headSha
        .mockResolvedValueOnce(false) // after fetchCommit: baseSha still missing
        .mockResolvedValueOnce(false) // after fetchCommit: headSha still missing
        .mockResolvedValueOnce(true) // after fetchBranch(targetBranch): baseSha resolved
        .mockResolvedValueOnce(true); // after fetchBranch(targetBranch): headSha resolved
      const onProgress = vi.fn();

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await orchestrator.prepare('!42', 'group/project', { onProgress });

      expect(fetchCommitSpy).toHaveBeenCalledTimes(2);
      expect(fetchBranchSpy).toHaveBeenCalledWith('main', 'origin', { depth: 1, noTags: true, progress: true });
    });

    it('fetches missing fork pull request base commits from the base repository', async () => {
      const forkTarget = { ...mockTarget, headRepository: 'alice/project' };
      (mockProvider.getTargetSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(forkTarget);
      (mockProvider.getCloneUrl as ReturnType<typeof vi.fn>).mockImplementation(
        (repo: string) => `https://gitlab.example.com/${repo}.git`,
      );
      hasCommitSpy
        .mockResolvedValueOnce(false) // initial check baseSha
        .mockResolvedValueOnce(true) // initial check headSha
        .mockResolvedValueOnce(false) // after fetchCommit from origin: baseSha still missing
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false) // after fetchCommit from base repo: baseSha still missing
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false) // after fetchBranch(targetBranch) from origin: still missing
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true) // after fetchBranch(targetBranch) from base repo: resolved
        .mockResolvedValueOnce(true);

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await orchestrator.prepare('!42', 'group/project', { onProgress: vi.fn() });

      expect(fetchCommitSpy).toHaveBeenCalledWith('aaa', 'origin', { depth: 1, noTags: true, progress: true });
      expect(fetchCommitSpy).toHaveBeenCalledWith('aaa', 'https://gitlab.example.com/group/project.git', {
        depth: 1,
        noTags: true,
        progress: true,
      });
      expect(fetchBranchSpy).toHaveBeenCalledWith('main', 'origin', {
        depth: 1,
        noTags: true,
        progress: true,
      });
      expect(fetchBranchSpy).toHaveBeenCalledWith('main', 'https://gitlab.example.com/group/project.git', {
        depth: 1,
        noTags: true,
        progress: true,
      });
    });

    it('falls through to shallow remote fetch when branch fetches do not resolve commits', async () => {
      // All individual fetches fail; shallow remote fetch resolves.
      hasCommitSpy
        .mockResolvedValueOnce(false) // initial: baseSha missing
        .mockResolvedValueOnce(true) // initial: headSha ok
        .mockResolvedValueOnce(false) // after fetchCommit: still missing
        .mockResolvedValueOnce(true) // after fetchCommit: headSha ok
        .mockResolvedValueOnce(false) // after fetchBranch(target): still missing
        .mockResolvedValueOnce(true) // after fetchBranch(target): headSha ok
        .mockResolvedValueOnce(false) // after fetchBranch(source): still missing
        .mockResolvedValueOnce(true) // after fetchBranch(source): headSha ok
        .mockResolvedValueOnce(true) // after shallow remote fetch: baseSha resolved
        .mockResolvedValueOnce(true); // after shallow remote fetch: headSha ok
      const onProgress = vi.fn();

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await orchestrator.prepare('!42', 'group/project', { onProgress });

      expect(fetchSpy).toHaveBeenCalledWith('origin', { depth: 1, noTags: true, progress: true });
    });

    it('throws with fetch error details when all fetch attempts fail', async () => {
      hasCommitSpy.mockResolvedValue(false); // never resolves
      fetchCommitSpy.mockRejectedValue(new Error('fetch commit failed'));
      fetchBranchSpy.mockRejectedValue(new Error('fetch branch failed'));
      fetchSpy.mockRejectedValue(new Error('fetch origin failed'));

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      const err = await captureError(orchestrator.prepare('!42', 'group/project', { onProgress: vi.fn() }));

      expect(err.message).toContain('could not generate the review patch');
      expect(err.message).toContain('Fetch attempts:');
      expect(err.message).toContain('fetch commit failed');
      expect(err.message).toContain('fetch origin failed');
    });

    it('throws without fetch details when all fetches succeed but commits still missing', async () => {
      // All fetches succeed (no errors pushed), but commits remain unavailable
      hasCommitSpy.mockResolvedValue(false);
      fetchCommitSpy.mockResolvedValue(undefined);
      fetchBranchSpy.mockResolvedValue(undefined);
      fetchSpy.mockResolvedValue(undefined);

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      const err = await captureError(orchestrator.prepare('!42', 'group/project', { onProgress: vi.fn() }));

      expect(err.message).toContain('could not generate the review patch');
      expect(err.message).toContain('Required commit(s) not available locally');
      expect(err.message).not.toContain('Fetch attempts:');
    });

    it('skips sourceBranch fetch when sourceBranch equals targetBranch', async () => {
      const targetSameBranches = { ...mockTarget, sourceBranch: 'main', targetBranch: 'main' };
      (mockProvider.getTargetSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(targetSameBranches);
      currentBranchSpy.mockResolvedValue('main');

      // Commit missing: fetchCommit fails, fetchBranch(target) fails, then shallow remote fetch resolves
      hasCommitSpy
        .mockResolvedValueOnce(false) // initial: base missing
        .mockResolvedValueOnce(true) // initial: head ok
        .mockResolvedValueOnce(false) // after fetchCommit: still missing
        .mockResolvedValueOnce(true) // after fetchCommit: head ok
        .mockResolvedValueOnce(false) // after fetchBranch(target): still missing
        .mockResolvedValueOnce(true) // after fetchBranch(target): head ok
        // No sourceBranch fetch since source === target
        .mockResolvedValueOnce(true) // after shallow remote fetch: resolved
        .mockResolvedValueOnce(true); // after shallow remote fetch: head ok

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await orchestrator.prepare('!42', 'group/project', { onProgress: vi.fn() });

      // fetchBranch called once for targetBranch, NOT for sourceBranch (same branch)
      expect(fetchBranchSpy).toHaveBeenCalledTimes(1);
      expect(fetchBranchSpy).toHaveBeenCalledWith('main', 'origin', expect.anything());
    });

    it('fails prepare when local git patch generation fails', async () => {
      diffForReviewSpy.mockRejectedValue(new Error('local diff failed'));

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await expect(orchestrator.prepare('!42', 'group/project')).rejects.toThrow(
        'could not generate the review patch from local Git',
      );
      await expect(fs.access(path.join(tmpDir, '.revpack', 'diffs', 'latest.patch'))).rejects.toThrow();
    });

    it('fails with descriptive error when baseSha is missing from diffRefs', async () => {
      const targetMissingBase = { ...mockTarget, diffRefs: { baseSha: '', headSha: 'bbb', startSha: 'aaa' } };
      (mockProvider.getTargetSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(targetMissingBase);

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      const err = await captureError(orchestrator.prepare('!42', 'group/project'));

      expect(err.message).toContain('could not generate the review patch');
      expect(err.message).toContain('<missing>');
      expect(err.message).toContain('base_sha or diff_refs.head_sha is missing');
    });

    it('fails with descriptive error when headSha is missing from diffRefs', async () => {
      const targetMissingHead = { ...mockTarget, diffRefs: { baseSha: 'aaa', headSha: '', startSha: 'aaa' } };
      (mockProvider.getTargetSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(targetMissingHead);
      headShaSpy.mockResolvedValue(''); // local HEAD matches the empty mrHeadSha

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      const err = await captureError(orchestrator.prepare('!42', 'group/project'));

      expect(err.message).toContain('could not generate the review patch');
      expect(err.message).toContain('head: <missing>');
      expect(err.message).toContain('base: aaa');
    });

    it('uses commit-to-commit local diff without fetching when commits are available', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      const result = await orchestrator.prepare('!42', 'group/project');

      expect(result.bundleState.local.headSha).toBe('bbb');
      expect(fetchCommitSpy).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(fetchBranchSpy).not.toHaveBeenCalled();
      expect(diffForReviewSpy).toHaveBeenCalledWith('aaa', 'bbb');
    });

    it('creates bundle files and persists expected bundle metadata', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      const result = await orchestrator.prepare('!42', 'group/project');

      expect(result.bundle.target.title).toBe('Test MR');
      expect(result.bundle.threads).toHaveLength(1);
      expect(result.bundle.diffs).toHaveLength(1);
      expect(result.contextPath).toContain('CONTEXT.md');
      expect(result.mode).toBe('fresh');

      const bundlePath = path.join(tmpDir, '.revpack', 'bundle.json');
      const bundleState = JSON.parse(await fs.readFile(bundlePath, 'utf-8'));
      expect(bundleState.schemaVersion).toBe(2);
      expect(bundleState.target.id).toBe('42');
      expect(bundleState.target.provider).toBe('gitlab');
      expect(bundleState.threads.items.map((i: { providerThreadId: string }) => i.providerThreadId)).toContain(
        'thread-1',
      );
      expect(bundleState.outputs.summary.path).toBe('.revpack/outputs/summary.md');
      expect(bundleState.outputs.review.path).toBe('.revpack/outputs/review.md');
      expect(bundleState.prepare.mode).toBe('fresh');

      const contextMd = await fs.readFile(path.join(tmpDir, '.revpack', 'CONTEXT.md'), 'utf-8');
      expect(contextMd).toContain('Test MR');

      // First-time prepare (no checkpoint) must NOT write an incremental patch
      const incrementalPath = path.join(tmpDir, '.revpack', 'diffs', 'incremental.patch');
      await expect(fs.access(incrementalPath)).rejects.toThrow();
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

    it('--fresh does not carry over previous publishedActions', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });

      // First run
      await orchestrator.prepare('!42', 'group/project');

      // Simulate publishing
      const ws = new WorkspaceManager(tmpDir);
      await ws.appendPublishedAction({
        type: 'reply',
        providerThreadId: 'thread-1',
        title: 'Fixed!',
        publishedAt: '2026-01-01T12:00:00Z',
      });

      // Fresh run should NOT carry over actions
      const fresh = await orchestrator.prepare('!42', 'group/project', { fresh: true });
      expect(fresh.publishedActionCount).toBe(0);
    });

    it('--fresh removes the existing bundle before resolving ref', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });

      // First run creates bundle
      await orchestrator.prepare('!42', 'group/project');

      // Verify bundle exists
      const ws = new WorkspaceManager(tmpDir);
      const bundleBefore = await ws.loadBundleState();
      expect(bundleBefore).not.toBeNull();

      // Fresh run removes the old bundle and creates a new one
      const fresh = await orchestrator.prepare('!42', 'group/project', { fresh: true });
      expect(fresh.bundle.target.targetId).toBe('42');
      // The mode should be 'fresh' since the old bundle was removed
      expect(fresh.bundleState.prepare.mode).toBe('fresh');
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

    it('keeps review note comments in the bundle context', async () => {
      // A thread that wraps the revpack review note is treated like any other visible comment.
      const reviewNoteThread: ReviewThread = {
        provider: 'gitlab',
        targetRef,
        threadId: 'review-note-thread',
        resolved: false,
        resolvable: false,
        comments: [
          {
            id: 'review-note-123',
            body: `${REVIEW_NOTE_MARKER}\n## Review\nLooks good.`,
            author: 'revpack-bot',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            origin: 'bot',
            system: false,
          },
        ],
      };

      (mockProvider.listAllThreads as ReturnType<typeof vi.fn>).mockResolvedValue([mockThread, reviewNoteThread]);

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      const result = await orchestrator.prepare('!42', 'group/project');

      expect(result.bundle.threads).toHaveLength(2);
      expect(result.bundle.threads.map((thread) => thread.threadId)).toEqual(['thread-1', 'review-note-thread']);
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

  describe('resolveRef explicit ref repository population', () => {
    it('uses defaultRepo when resolveTarget returns empty repository', async () => {
      const refWithNoRepo = { ...targetRef, repository: '' };
      (mockProvider.resolveTarget as ReturnType<typeof vi.fn>).mockReturnValue(refWithNoRepo);

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      const target = await orchestrator.open('!42', 'group/project');

      expect(mockProvider.getTargetSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({ repository: 'group/project' }),
      );
      expect(target.title).toBe('Test MR');
    });

    it('does not overwrite repository from resolveTarget with defaultRepo', async () => {
      const refWithRepo = { ...targetRef, repository: 'original/repo' };
      (mockProvider.resolveTarget as ReturnType<typeof vi.fn>).mockReturnValue(refWithRepo);

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await orchestrator.open('!42', 'different/default');

      // The original repository from resolveTarget should be preserved
      expect(mockProvider.getTargetSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({ repository: 'original/repo' }),
      );
    });

    it('derives repo slug from git when resolveTarget returns empty repository and no defaultRepo', async () => {
      const refWithNoRepo = { ...targetRef, repository: '' };
      (mockProvider.resolveTarget as ReturnType<typeof vi.fn>).mockReturnValue(refWithNoRepo);
      const deriveSlugSpy = vi.spyOn(GitHelper.prototype, 'deriveRepoSlug').mockResolvedValue('derived/repo');
      (mockProvider.getTargetSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...mockTarget,
        repository: 'derived/repo',
      });

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await orchestrator.open('!42');

      expect(deriveSlugSpy).toHaveBeenCalled();
      expect(mockProvider.getTargetSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({ repository: 'derived/repo' }),
      );
      deriveSlugSpy.mockRestore();
    });

    it('skips deriveRepoSlug for local provider even when repository is empty', async () => {
      const localProvider = {
        ...createMockProvider(),
        providerType: 'local' as const,
        resolveTarget: vi.fn().mockReturnValue({
          provider: 'local',
          repository: '',
          targetType: 'local_review',
          targetId: 'main...HEAD',
        }),
        getTargetSnapshot: vi.fn().mockResolvedValue({
          ...mockTarget,
          provider: 'local',
          repository: '',
          targetType: 'local_review',
          targetId: 'main...HEAD',
        }),
      };
      const deriveSlugSpy = vi.spyOn(GitHelper.prototype, 'deriveRepoSlug').mockResolvedValue('group/project');

      const orchestrator = new ReviewOrchestrator({ provider: localProvider, workingDir: tmpDir });
      await orchestrator.open('main...HEAD');

      expect(deriveSlugSpy).not.toHaveBeenCalled();
      deriveSlugSpy.mockRestore();
    });
  });

  describe('resolveRef local provider auto-detect', () => {
    it('auto-detects target from branch for local provider without explicit ref', async () => {
      const localTarget = {
        ...mockTarget,
        provider: 'local' as const,
        repository: '',
        targetType: 'local_review' as const,
        targetId: 'main...feature/test',
      };
      const localProvider = {
        ...createMockProvider(),
        providerType: 'local' as const,
        findTargetByBranch: vi.fn().mockResolvedValue([localTarget]),
        getTargetSnapshot: vi.fn().mockResolvedValue(localTarget),
        getDiffVersions: vi.fn().mockResolvedValue([
          {
            ...mockVersion,
            provider: 'local',
            targetRef: {
              provider: 'local',
              repository: '',
              targetType: 'local_review',
              targetId: 'main...feature/test',
            },
          },
        ]),
      };

      const orchestrator = new ReviewOrchestrator({ provider: localProvider, workingDir: tmpDir });
      const result = await orchestrator.prepare(undefined);

      expect(localProvider.findTargetByBranch).toHaveBeenCalledWith('', 'feature/test');
      expect(result.bundle.target.targetId).toBe('main...feature/test');
    });

    it('skips local auto-detect on detached HEAD', async () => {
      currentBranchSpy.mockResolvedValue('HEAD');
      const localProvider = {
        ...createMockProvider(),
        providerType: 'local' as const,
        findTargetByBranch: vi.fn().mockResolvedValue([]),
      };

      const orchestrator = new ReviewOrchestrator({ provider: localProvider, workingDir: tmpDir });
      // No bundle, no branch → falls through to error
      await expect(orchestrator.prepare(undefined)).rejects.toThrow('Could not determine');
      expect(localProvider.findTargetByBranch).not.toHaveBeenCalled();
    });
  });

  describe('resolveRef auto-detect from branch', () => {
    let deriveSlugSpy: MockInstance<(...args: any[]) => any>;

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

    it('throws descriptive error when multiple GitHub PRs match the branch', async () => {
      deriveSlugSpy = vi.spyOn(GitHelper.prototype, 'deriveRepoSlug').mockResolvedValue('group/project');

      const firstTarget: ReviewTarget = {
        ...mockTarget,
        provider: 'github',
        targetType: 'pull_request',
        targetId: '42',
      };
      const secondTarget: ReviewTarget = { ...firstTarget, targetId: '99' };
      mockProvider = {
        ...mockProvider,
        providerType: 'github',
        findTargetByBranch: vi.fn().mockResolvedValue([firstTarget, secondTarget]),
      };

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await expect(orchestrator.prepare(undefined, undefined)).rejects.toThrow(
        'Multiple open PRs found for branch "feature/test": #42, #99',
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

    it('surfaces provider authentication errors from branch auto-detection', async () => {
      deriveSlugSpy = vi.spyOn(GitHelper.prototype, 'deriveRepoSlug').mockResolvedValue('group/project');
      (mockProvider.findTargetByBranch as ReturnType<typeof vi.fn>).mockRejectedValue(
        new AuthenticationError('GitLab authentication failed (401)', 'gitlab'),
      );

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await expect(orchestrator.prepare(undefined, undefined)).rejects.toThrow('GitLab authentication failed (401)');
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

    it('resumes from bundle on detached HEAD without throwing', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });

      // First run creates bundle
      await orchestrator.prepare('!42', 'group/project');

      // Second run on detached HEAD — the bundle path should not throw
      // because `currentBranch !== 'HEAD'` is false, so the mismatch check is skipped
      currentBranchSpy.mockResolvedValue('HEAD');
      const result = await orchestrator.prepare(undefined, 'group/project');
      expect(result.bundle.target.targetId).toBe('42');
    });

    it('throws branch mismatch when resolveRef detects wrong branch from bundle', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });

      // First run creates bundle (sourceBranch = 'feature/test')
      await orchestrator.prepare('!42', 'group/project');

      // resolveRef's currentBranch call returns a different branch than the bundle's
      // The FIRST call is in resolveRef (before git check at L172)
      currentBranchSpy.mockResolvedValueOnce('wrong-branch'); // resolveRef → mismatch
      // The second call (git check) never happens because resolveRef throws first

      await expect(orchestrator.prepare(undefined, 'group/project')).rejects.toThrow(
        'Branch mismatch: current branch "wrong-branch" does not match',
      );
    });

    it('resumes from bundle when currentBranch throws in resolveRef', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });

      // First run creates bundle
      await orchestrator.prepare('!42', 'group/project');

      // resolveRef is called BEFORE the git consistency check.
      // First call (inside resolveRef) throws → error is swallowed, bundle is used.
      // Second call (git check at L172) returns normally.
      currentBranchSpy.mockRejectedValueOnce(new Error('git error'));
      currentBranchSpy.mockResolvedValueOnce('feature/test');

      const result = await orchestrator.prepare(undefined, 'group/project');
      expect(result.bundle.target.targetId).toBe('42');
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

    it('returns null on the GitLab MR head fallback branch', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await orchestrator.prepare('!42', 'group/project');

      currentBranchSpy.mockResolvedValue('revpack/mr-42');
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

    it('returns null on detached HEAD even with bundle', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await orchestrator.prepare('!42', 'group/project');

      currentBranchSpy.mockResolvedValue('HEAD');
      const result = await orchestrator.checkBranchMismatch();
      expect(result).toBeNull();
    });

    it('returns null when currentBranch returns empty string', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await orchestrator.prepare('!42', 'group/project');

      currentBranchSpy.mockResolvedValue('');
      const result = await orchestrator.checkBranchMismatch();
      expect(result).toBeNull();
    });
  });

  describe('branch mismatch in resolveRef', () => {
    it('throws when resuming bundle on wrong branch', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await orchestrator.prepare('!42', 'group/project');

      currentBranchSpy.mockResolvedValue('wrong-branch');

      await expect(orchestrator.prepare(undefined, 'group/project')).rejects.toThrow(/Branch mismatch|does not match/);
    });

    it('resumes bundle on the provider fallback branch', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await orchestrator.prepare('!42', 'group/project');
      (mockProvider.getTargetSnapshot as ReturnType<typeof vi.fn>).mockClear();

      currentBranchSpy.mockResolvedValue('revpack/mr-42');

      await orchestrator.open(undefined, 'group/project');

      expect(mockProvider.getTargetSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({ targetId: '42', repository: 'group/project' }),
      );
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

    it('allows prepare on the GitLab MR head fallback branch when HEAD matches', async () => {
      currentBranchSpy.mockResolvedValue('revpack/mr-42');

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      const result = await orchestrator.prepare('!42', 'group/project');

      expect(result.bundleState.local.branch).toBe('revpack/mr-42');
      expect(result.bundleState.local.matchesTargetHead).toBe(true);
      expect(result.bundleState.local.matchesTargetSourceBranch).toBe(false);
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
    });

    it('succeeds on detached HEAD with matchesTargetSourceBranch false', async () => {
      currentBranchSpy.mockResolvedValue('HEAD');

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      const result = await orchestrator.prepare('!42', 'group/project');

      expect(result.bundleState.local.branch).toBe('HEAD');
      expect(result.bundleState.local.matchesTargetSourceBranch).toBe(false);
      expect(result.bundleState.local.matchesTargetHead).toBe(true);
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

    it('uses checkpoint threadDigests to identify per-thread changes', async () => {
      // Build a checkpoint where thread-1 has a stale digest
      const checkpointState = buildCheckpointState(
        targetRef,
        'bbb', // same head — no code change
        'aaa',
        'aaa',
        'sha256:stale-aggregate', // different from current → triggers threadsChanged
        'v1',
        undefined,
        { 'thread-1': 'sha256:stale-thread-digest' },
      );
      const descriptionWithState = patchDescriptionWithState('Test description', checkpointState);

      const targetWithState = { ...mockTarget, description: descriptionWithState };
      (mockProvider.getTargetSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(targetWithState);

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      const result = await orchestrator.prepare('!42', 'group/project');

      expect(result.threadsChanged).toBe(true);
      // CONTEXT.md should identify thread-1 as changed
      const contextMd = await fs.readFile(path.join(tmpDir, '.revpack', 'CONTEXT.md'), 'utf-8');
      expect(contextMd).toContain('Changed Threads Since Last Checkpoint');
    });

    it('does not report per-thread changes when checkpoint has empty threadDigests', async () => {
      // Checkpoint with empty threadDigests — falls back to computing from current
      const checkpointState = buildCheckpointState(
        targetRef,
        'bbb',
        'aaa',
        'aaa',
        'sha256:stale-aggregate',
        'v1',
        undefined,
        {}, // empty threadDigests
      );
      const descriptionWithState = patchDescriptionWithState('Test description', checkpointState);

      const targetWithState = { ...mockTarget, description: descriptionWithState };
      (mockProvider.getTargetSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(targetWithState);

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      const result = await orchestrator.prepare('!42', 'group/project');

      expect(result.threadsChanged).toBe(true);
      // Without per-thread digests in checkpoint, no individual thread changes can be detected
      // because the baseline is the current state itself (fallback)
      const contextMd = await fs.readFile(path.join(tmpDir, '.revpack', 'CONTEXT.md'), 'utf-8');
      expect(contextMd).not.toContain('Changed Threads Since Last Checkpoint');
    });
  });

  // ─── Prepare comparison fields ─────────────────────────

  describe('prepare comparison fields', () => {
    it('uses checkpoint-based comparison fields and tracks current digests', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      const result = await orchestrator.prepare('!42', 'group/project');

      const ps = result.bundleState.prepare;
      expect(ps).toHaveProperty('comparison');
      expect(ps.comparison).toHaveProperty('targetCodeChangedSinceCheckpoint');
      expect(ps.comparison).toHaveProperty('threadsChangedSinceCheckpoint');
      expect(ps.comparison).toHaveProperty('descriptionChangedSinceCheckpoint');
      expect(result.bundleState.prepare.current.threadsDigest).toBeTruthy();
      expect(result.bundleState.prepare.current.localHeadSha).toBe('bbb');
      expect(result.bundleState.prepare.current.targetHeadSha).toBe('bbb');
    });

    it('sets providerVersionId from first version when versions exist', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      const result = await orchestrator.prepare('!42', 'group/project');

      expect(result.bundleState.prepare.current.providerVersionId).toBe('v1');
    });

    it('sets providerVersionId to undefined when versions array is empty', async () => {
      (mockProvider.getDiffVersions as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      const result = await orchestrator.prepare('!42', 'group/project');

      expect(result.bundleState.prepare.current.providerVersionId).toBeUndefined();
    });

    it('reports descriptionChanged when checkpoint has a descriptionDigest', async () => {
      const checkpointState = buildCheckpointState(
        targetRef,
        'bbb', // same head
        'aaa',
        'aaa',
        null,
        'v1',
        'sha256:old-desc-digest', // stale description digest
      );
      const descriptionWithState = patchDescriptionWithState('Test description', checkpointState);

      const targetWithState = { ...mockTarget, description: descriptionWithState };
      (mockProvider.getTargetSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(targetWithState);

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      const result = await orchestrator.prepare('!42', 'group/project');

      // Description was modified since checkpoint (digest mismatch)
      expect(result.descriptionChanged).toBe(true);
    });

    it('reports descriptionChanged=false when description matches checkpoint digest', async () => {
      // We need to compute the actual digest that matches

      // First prepare without checkpoint to get the description digest
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      const firstResult = await orchestrator.prepare('!42', 'group/project');
      const currentDescDigest = firstResult.bundleState.prepare.current.descriptionDigest;

      // Now use that digest in a checkpoint
      await fs.rm(path.join(tmpDir, '.revpack'), { recursive: true, force: true });
      const checkpointState = buildCheckpointState(targetRef, 'bbb', 'aaa', 'aaa', null, 'v1', currentDescDigest);
      const descriptionWithState = patchDescriptionWithState('Test', checkpointState);
      const targetWithState = { ...mockTarget, description: descriptionWithState };
      (mockProvider.getTargetSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(targetWithState);

      const result = await orchestrator.prepare('!42', 'group/project');
      expect(result.descriptionChanged).toBe(false);
    });
  });

  // ─── Output publish state ──────────────────────────────

  describe('output publish state', () => {
    it('tracks summary publish hashes and review note pending state separately', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await orchestrator.prepare('!42', 'group/project');
      const ws = new WorkspaceManager(tmpDir);

      const summaryPath = path.join(tmpDir, '.revpack', 'outputs', 'summary.md');
      const reviewPath = path.join(tmpDir, '.revpack', 'outputs', 'review.md');

      expect(await ws.getOutputState('summary')).toBe('empty');
      expect(await ws.getPendingOutputState('review')).toBe('empty');

      const summary = '# Summary\nThis is a test';
      await fs.writeFile(summaryPath, summary, 'utf-8');
      expect(await ws.getOutputState('summary')).toBe('pending');

      await ws.updateOutputPublishState('summary', computeContentHash(summary), 'bbb');
      expect(await ws.getOutputState('summary')).toBe('published');

      await fs.writeFile(summaryPath, '# Summary\nEdited', 'utf-8');
      expect(await ws.getOutputState('summary')).toBe('modified since publish');

      const review = '## Notes\nReview notes';
      await fs.writeFile(reviewPath, review, 'utf-8');
      expect(await ws.getPendingOutputState('review')).toBe('pending');
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

    it('can refresh while preserving pending outputs', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await orchestrator.prepare('!42', 'group/project');

      const repliesPath = path.join(tmpDir, '.revpack', 'outputs', 'replies.json');
      const pendingReplies = [{ threadId: 'T-001', body: 'Still pending.', resolve: false }];
      await fs.writeFile(repliesPath, JSON.stringify(pendingReplies, null, 2), 'utf-8');

      (mockProvider.listAllThreads as ReturnType<typeof vi.fn>).mockResolvedValue([{ ...mockThread, resolved: true }]);

      const refreshed = await orchestrator.prepare('!42', 'group/project', { preservePendingOutputs: true });

      expect(refreshed.prunedReplies).toBe(0);
      await expect(fs.readFile(repliesPath, 'utf-8').then(JSON.parse)).resolves.toEqual(pendingReplies);
    });
  });

  // ─── Thread items in bundle.json ───────────────────────

  describe('thread items in bundle', () => {
    it('includes thread items and aggregate digest', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      const result = await orchestrator.prepare('!42', 'group/project');

      expect(result.bundleState.threads.items).toHaveLength(1);
      expect(result.bundleState.threads.items[0].providerThreadId).toBe('thread-1');
      expect(result.bundleState.threads.items[0].digest).toBeTruthy();
      expect(result.bundleState.threads.items[0].shortId).toBe('T-001');
      expect(result.bundleState.threads.digest).toBeTruthy();
      expect(result.bundleState.threads.digestVersion).toBe(3);
    });
  });

  // ─── Remote checkpoint tests ───────────────────────────

  describe('remote checkpoint behavior', () => {
    it('prepare with no checkpoint generates fresh review context', async () => {
      // No managed review note exists

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

      // The "no code change" incremental patch should be written
      const incrementalPatch = await fs.readFile(path.join(tmpDir, '.revpack', 'diffs', 'incremental.patch'), 'utf-8');
      expect(incrementalPatch).toContain('No code changes since last review checkpoint');
    });

    it('repeated prepare before publishing keeps target-code-changed status stable', async () => {
      const checkpointState = buildCheckpointState(targetRef, 'old-head', 'aaa', 'aaa', 'sha256:old-threads', 'v1');
      const descriptionWithState = patchDescriptionWithState('Test description', checkpointState);

      const targetWithState = { ...mockTarget, description: descriptionWithState };
      (mockProvider.getTargetSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(targetWithState);

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

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await orchestrator.prepare('!42', 'group/project');

      expect(diffSpy).not.toHaveBeenCalledWith('old-head', 'bbb');
      const incrementalPatch = await fs.readFile(path.join(tmpDir, '.revpack', 'diffs', 'incremental.patch'), 'utf-8');
      expect(incrementalPatch).toContain('previous review checkpoint is not an ancestor');
    });
  });

  // ─── Publish review tests ──────────────────────────────

  describe('publishReview', () => {
    it('creates visible comment without advancing checkpoint when review content is non-empty', async () => {
      (mockProvider.createNote as ReturnType<typeof vi.fn>).mockResolvedValue('new-note-id');

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
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

      expect(mockProvider.updateDescription).not.toHaveBeenCalled();
    });

    it('with empty review.md publishes no visible comment and does not advance checkpoint', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await orchestrator.prepare('!42', 'group/project');

      const result = await orchestrator.publishReview('', 'group/project');

      expect(result.created).toBe(false);
      expect(result.noteId).toBeUndefined();
      expect(mockProvider.createNote).not.toHaveBeenCalled();
      expect(mockProvider.updateDescription).not.toHaveBeenCalled();
    });

    it('with whitespace-only content publishes no visible comment', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await orchestrator.prepare('!42', 'group/project');

      const result = await orchestrator.publishReview('   \n\t  \n  ', 'group/project');

      expect(result.created).toBe(false);
      expect(mockProvider.createNote).not.toHaveBeenCalled();
    });

    it('advanceCheckpoint sets providerVersionId to undefined when no versions exist', async () => {
      (mockProvider.getDiffVersions as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await orchestrator.prepare('!42', 'group/project');

      await orchestrator.publishCheckpoint('group/project');

      // Description state was written — parse it and check versionId is absent
      const updatedDesc = (mockProvider.updateDescription as ReturnType<typeof vi.fn>).mock.calls[0][1];
      const state = parseDescriptionState(updatedDesc);
      expect(state).not.toBeNull();
      expect(state!.checkpoint.providerVersionId).toBeUndefined();
    });
  });

  // ─── Publish review batch tests ────────────────────────

  describe('publishReviewBatch', () => {
    it('submits findings and review body via submitReview', async () => {
      const submitReviewMock = vi.fn().mockResolvedValue(undefined);
      mockProvider = { ...createMockProvider(), submitReview: submitReviewMock };

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await orchestrator.prepare('!42', 'group/project');

      const findings = [
        {
          oldPath: 'src/app.ts',
          newPath: 'src/app.ts',
          newLine: 10,
          body: 'Fix this',
          severity: 'medium' as const,
          category: 'correctness' as const,
        },
      ];
      const result = await orchestrator.publishReviewBatch(findings, '## Summary\nGood work.', 'group/project');

      expect(result.created).toBe(true);
      expect(submitReviewMock).toHaveBeenCalledWith(
        expect.objectContaining({ targetId: '42' }),
        expect.arrayContaining([expect.objectContaining({ path: 'src/app.ts', line: 10, side: 'RIGHT' })]),
        expect.stringContaining('Good work.'),
        'COMMENT',
      );
    });

    it('returns created=false with empty findings and whitespace-only reviewBody', async () => {
      const submitReviewMock = vi.fn().mockResolvedValue(undefined);
      mockProvider = { ...createMockProvider(), submitReview: submitReviewMock };

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await orchestrator.prepare('!42', 'group/project');

      const result = await orchestrator.publishReviewBatch([], '  \n  ', 'group/project');

      expect(result.created).toBe(false);
      // submitReview still called (with empty body) — it's the provider's responsibility
      expect(submitReviewMock).toHaveBeenCalledWith(
        expect.objectContaining({ targetId: '42' }),
        [],
        '', // whitespace-only body becomes empty string
        'COMMENT',
      );
    });

    it('sets LEFT side for findings with oldLine only', async () => {
      const submitReviewMock = vi.fn().mockResolvedValue(undefined);
      mockProvider = { ...createMockProvider(), submitReview: submitReviewMock };

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await orchestrator.prepare('!42', 'group/project');

      const findings = [
        {
          oldPath: 'src/old.ts',
          newPath: 'src/new.ts',
          oldLine: 5,
          body: 'Removed code issue',
          severity: 'low' as const,
          category: 'correctness' as const,
        },
      ];
      const result = await orchestrator.publishReviewBatch(findings, '', 'group/project');

      expect(result.created).toBe(true);
      expect(submitReviewMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.arrayContaining([expect.objectContaining({ path: 'src/old.ts', line: 5, side: 'LEFT' })]),
        '',
        'COMMENT',
      );
    });

    it('sets RIGHT side when both oldLine and newLine are present', async () => {
      const submitReviewMock = vi.fn().mockResolvedValue(undefined);
      mockProvider = { ...createMockProvider(), submitReview: submitReviewMock };

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await orchestrator.prepare('!42', 'group/project');

      const findings = [
        {
          oldPath: 'src/app.ts',
          newPath: 'src/app.ts',
          oldLine: 10,
          newLine: 12,
          body: 'Changed line',
          severity: 'low' as const,
          category: 'correctness' as const,
        },
      ];
      const result = await orchestrator.publishReviewBatch(findings, '', 'group/project');

      expect(result.created).toBe(true);
      expect(submitReviewMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.arrayContaining([expect.objectContaining({ path: 'src/app.ts', line: 12, side: 'RIGHT' })]),
        '',
        'COMMENT',
      );
    });
  });

  // ─── reviewDiffsFromPatch status flags ──────────────────

  describe('reviewDiffsFromPatch status flags', () => {
    function addedFilePatch(): string {
      return [
        'diff --git a/src/new.ts b/src/new.ts',
        'new file mode 100644',
        'index 0000000..aaaaaaa',
        '--- /dev/null',
        '+++ b/src/new.ts',
        '@@ -0,0 +1 @@',
        '+console.log("hello");',
        '',
      ].join('\n');
    }

    function renamedFilePatch(): string {
      return [
        'diff --git a/src/old-name.ts b/src/new-name.ts',
        'similarity index 100%',
        'rename from src/old-name.ts',
        'rename to src/new-name.ts',
        '',
      ].join('\n');
    }

    function deletedFilePatch(): string {
      return [
        'diff --git a/src/removed.ts b/src/removed.ts',
        'deleted file mode 100644',
        'index bbbbbbb..0000000',
        '--- a/src/removed.ts',
        '+++ /dev/null',
        '@@ -1 +0,0 @@',
        '-old content',
        '',
      ].join('\n');
    }

    it('marks newFile=true for added files', async () => {
      diffForReviewSpy.mockResolvedValue(addedFilePatch());

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      const result = await orchestrator.prepare('!42', 'group/project');

      expect(result.bundle.diffs).toHaveLength(1);
      expect(result.bundle.diffs[0].newFile).toBe(true);
      expect(result.bundle.diffs[0].renamedFile).toBe(false);
      expect(result.bundle.diffs[0].deletedFile).toBe(false);
    });

    it('marks renamedFile=true for renamed files', async () => {
      diffForReviewSpy.mockResolvedValue(renamedFilePatch());

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      const result = await orchestrator.prepare('!42', 'group/project');

      expect(result.bundle.diffs).toHaveLength(1);
      expect(result.bundle.diffs[0].renamedFile).toBe(true);
      expect(result.bundle.diffs[0].newFile).toBe(false);
      expect(result.bundle.diffs[0].deletedFile).toBe(false);
    });

    it('marks deletedFile=true for deleted files', async () => {
      diffForReviewSpy.mockResolvedValue(deletedFilePatch());

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      const result = await orchestrator.prepare('!42', 'group/project');

      expect(result.bundle.diffs).toHaveLength(1);
      expect(result.bundle.diffs[0].deletedFile).toBe(true);
      expect(result.bundle.diffs[0].newFile).toBe(false);
      expect(result.bundle.diffs[0].renamedFile).toBe(false);
    });

    it('strips git diff header down to --- line for normal diffs', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      const result = await orchestrator.prepare('!42', 'group/project');

      // localPatch() starts with "diff --git..." then "index..." then "--- "
      expect(result.bundle.diffs[0].diff).toMatch(/^--- /);
      expect(result.bundle.diffs[0].diff).not.toContain('diff --git');
    });

    it('strips git diff header to @@ line when --- is absent', async () => {
      const patchWithNoMinusLine = [
        'diff --git a/src/empty.ts b/src/empty.ts',
        'index 1111111..2222222 100644',
        '@@ -1 +1 @@',
        '-old',
        '+new',
        '',
      ].join('\n');
      diffForReviewSpy.mockResolvedValue(patchWithNoMinusLine);

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      const result = await orchestrator.prepare('!42', 'group/project');

      expect(result.bundle.diffs[0].diff).toMatch(/^@@ /);
    });

    it('strips git diff header to Binary files line for binary diffs', async () => {
      const binaryPatch = [
        'diff --git a/image.png b/image.png',
        'index 1111111..2222222 100644',
        'Binary files a/image.png and b/image.png differ',
        '',
      ].join('\n');
      diffForReviewSpy.mockResolvedValue(binaryPatch);

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      const result = await orchestrator.prepare('!42', 'group/project');

      expect(result.bundle.diffs[0].diff).toMatch(/^Binary files /);
    });
  });

  // ─── State recovery tests ─────────────────────────────

  describe('state recovery', () => {
    it('reconstructs checkpoint from description state after deleting .revpack/', async () => {
      const checkpointState = buildCheckpointState(targetRef, 'old-head', 'aaa', 'aaa', 'sha256:old-threads', 'v1');
      const descriptionWithState = patchDescriptionWithState('Original description.', checkpointState);

      const targetWithState = { ...mockTarget, description: descriptionWithState };
      (mockProvider.getTargetSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(targetWithState);

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

  // ─── Input validation ──────────────────────────────────

  describe('input validation', () => {
    it('publishReply throws when threadId is undefined', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await expect(orchestrator.publishReply('!42', undefined, 'body', 'group/project')).rejects.toThrow(
        'threadId is required',
      );
    });

    it('publishReply throws when body is undefined', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await expect(orchestrator.publishReply('!42', 'thread-1', undefined, 'group/project')).rejects.toThrow(
        'reply body is required',
      );
    });

    it('resolveThread throws when threadId is undefined', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await expect(orchestrator.resolveThread('!42', undefined, 'group/project')).rejects.toThrow(
        'threadId is required',
      );
    });

    it('updateDescription throws when body is undefined', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await expect(orchestrator.updateDescription('!42', undefined, 'group/project')).rejects.toThrow(
        'description body is required',
      );
    });
  });

  // ─── Prune stale replies ───────────────────────────────

  describe('prune stale replies on refresh', () => {
    it('calls pruneStaleReplies with active thread IDs on refresh', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      // First prepare creates the bundle
      await orchestrator.prepare('!42', 'group/project');

      // Write a stale reply targeting a now-resolved thread
      const repliesPath = path.join(tmpDir, '.revpack', 'outputs', 'replies.json');
      const staleReplies = [{ threadId: 'T-999', body: 'Stale reply.', resolve: false }];
      await fs.writeFile(repliesPath, JSON.stringify(staleReplies, null, 2), 'utf-8');

      // Refresh — the only active thread is 'thread-1', so T-999 reply is stale
      const result = await orchestrator.prepare('!42', 'group/project');

      // pruneStaleReplies should have been called and removed the stale reply
      expect(result.prunedReplies).toBe(1);
      const remaining = JSON.parse(await fs.readFile(repliesPath, 'utf-8'));
      expect(remaining).toHaveLength(0);
    });
  });

  // ─── publishReviewBatch edge cases ─────────────────────

  describe('publishReviewBatch edge cases', () => {
    it('skips submitReview when provider does not implement it', async () => {
      // Provider WITHOUT submitReview
      const providerWithoutSubmit = createMockProvider();

      const orchestrator = new ReviewOrchestrator({ provider: providerWithoutSubmit, workingDir: tmpDir });
      await orchestrator.prepare('!42', 'group/project');

      // Should not throw even though submitReview is not available
      const result = await orchestrator.publishReviewBatch(
        [
          {
            oldPath: 'a.ts',
            newPath: 'a.ts',
            newLine: 1,
            body: 'test',
            severity: 'low' as const,
            category: 'correctness' as const,
          },
        ],
        'Review body',
        'group/project',
      );

      expect(result.created).toBe(true);
      expect(providerWithoutSubmit.updateDescription).not.toHaveBeenCalled();
    });

    it('trims whitespace from reviewBody in submitted review', async () => {
      const submitReviewMock = vi.fn().mockResolvedValue(undefined);
      mockProvider = { ...createMockProvider(), submitReview: submitReviewMock };

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await orchestrator.prepare('!42', 'group/project');

      await orchestrator.publishReviewBatch(
        [
          {
            oldPath: 'a.ts',
            newPath: 'a.ts',
            newLine: 5,
            body: 'Issue',
            severity: 'medium' as const,
            category: 'correctness' as const,
          },
        ],
        '  Summary with spaces  ',
        'group/project',
      );

      const calledBody = submitReviewMock.mock.calls[0][2];
      // Body should be trimmed (no leading/trailing spaces) but have footer appended
      expect(calledBody).toMatch(/^Summary with spaces/);
      expect(calledBody).not.toMatch(/^\s/);
    });

    it('uses RIGHT side and newPath for file-level findings without line info', async () => {
      const submitReviewMock = vi.fn().mockResolvedValue(undefined);
      mockProvider = { ...createMockProvider(), submitReview: submitReviewMock };

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await orchestrator.prepare('!42', 'group/project');

      const findings = [
        {
          oldPath: 'src/old.ts',
          newPath: 'src/new.ts',
          body: 'File-level issue',
          severity: 'low' as const,
          category: 'correctness' as const,
        },
      ];
      await orchestrator.publishReviewBatch(findings, '', 'group/project');

      expect(submitReviewMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.arrayContaining([expect.objectContaining({ path: 'src/new.ts', side: 'RIGHT' })]),
        expect.anything(),
        'COMMENT',
      );
    });
  });

  // ─── Progress messages in fetch flow ───────────────────

  describe('progress messages in fetch flow', () => {
    it('includes abbreviated commit SHAs in progress messages', async () => {
      const longBaseSha = 'abcdef1234567890abcdef1234567890abcdef12';
      const longHeadSha = '1234567890abcdef1234567890abcdef12345678';
      (mockProvider.getTargetSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...mockTarget,
        diffRefs: { baseSha: longBaseSha, headSha: longHeadSha, startSha: 'aaa' },
      });
      headShaSpy.mockResolvedValue(longHeadSha);
      // baseSha missing initially, resolved after fetchCommit
      hasCommitSpy
        .mockResolvedValueOnce(false) // baseSha missing
        .mockResolvedValueOnce(true) // headSha present
        .mockResolvedValueOnce(true) // after fetch: baseSha resolved
        .mockResolvedValueOnce(true); // after fetch: headSha
      const onProgress = vi.fn();

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await orchestrator.prepare('!42', 'group/project', { onProgress });

      // Progress message should contain abbreviated SHA (8 chars), not full 40-char SHA
      const progressMsg = onProgress.mock.calls.find((c: string[]) => c[0].includes('Fetching'))?.[0];
      expect(progressMsg).toBeDefined();
      expect(progressMsg).toContain('abcdef12');
      expect(progressMsg).not.toContain(longBaseSha);
    });
  });

  // ─── target_changed mode ───────────────────────────────

  describe('target_changed mode', () => {
    it('sets mode to target_changed when target ID differs from bundle', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      // First prepare targets MR 42
      await orchestrator.prepare('!42', 'group/project');

      // Second prepare targets MR 99 (different ID) — simulated by changing resolveTarget
      const newTargetRef = { ...targetRef, targetId: '99' };
      const newTarget = {
        ...mockTarget,
        ...newTargetRef,
        diffRefs: { baseSha: 'aaa', headSha: 'bbb', startSha: 'aaa' },
      };
      (mockProvider.resolveTarget as ReturnType<typeof vi.fn>).mockResolvedValue(newTargetRef);
      (mockProvider.getTargetSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(newTarget);

      const result = await orchestrator.prepare('!99', 'group/project');

      expect(result.mode).toBe('target_changed');
    });
  });

  // ─── pruneStaleReplies keeps active replies ────────────

  describe('pruneStaleReplies preserves active replies', () => {
    it('does not prune replies for threads that are still active', async () => {
      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await orchestrator.prepare('!42', 'group/project');

      // Write replies: one for active thread 'thread-1' (should be kept) and one stale
      const repliesPath = path.join(tmpDir, '.revpack', 'outputs', 'replies.json');
      const replies = [
        { threadId: 'T-001', body: 'Active reply.', resolve: false },
        { threadId: 'T-999', body: 'Stale reply.', resolve: false },
      ];
      await fs.writeFile(repliesPath, JSON.stringify(replies, null, 2), 'utf-8');

      // Refresh — thread-1 (T-001) is active, T-999 is stale
      const result = await orchestrator.prepare('!42', 'group/project');

      expect(result.prunedReplies).toBe(1);
      const remaining = JSON.parse(await fs.readFile(repliesPath, 'utf-8'));
      expect(remaining).toHaveLength(1);
      expect(remaining[0].threadId).toBe('T-001');
    });
  });

  // ─── fetch without progress callback ──────────────────

  describe('fetch without progress callback', () => {
    it('does not crash when commits are missing but no progress callback is provided', async () => {
      hasCommitSpy
        .mockResolvedValueOnce(false) // baseSha missing
        .mockResolvedValueOnce(true) // headSha present
        .mockResolvedValueOnce(true) // after fetch: resolved
        .mockResolvedValueOnce(true);

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      // Call without onProgress — should still work
      const result = await orchestrator.prepare('!42', 'group/project');

      expect(fetchCommitSpy).toHaveBeenCalled();
      expect(result.bundle.diffs).toBeDefined();
    });

    it('does not attempt source branch fetch when targetBranch fetch resolves commits', async () => {
      hasCommitSpy
        .mockResolvedValueOnce(false) // initial: baseSha missing
        .mockResolvedValueOnce(true) // initial: headSha ok
        .mockResolvedValueOnce(false) // after fetchCommit: still missing
        .mockResolvedValueOnce(true) // after fetchCommit: headSha ok
        .mockResolvedValueOnce(true) // after fetchBranch(target): resolved!
        .mockResolvedValueOnce(true);

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await orchestrator.prepare('!42', 'group/project', { onProgress: vi.fn() });

      expect(fetchBranchSpy).toHaveBeenCalledTimes(1);
      expect(fetchBranchSpy).toHaveBeenCalledWith('main', 'origin', expect.anything());
      // Source branch fetch should NOT have been called
      expect(fetchBranchSpy).not.toHaveBeenCalledWith('feature/test', 'origin', expect.anything());
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  // ─── advanceCheckpoint description handling ────────────

  describe('advanceCheckpoint description handling', () => {
    it('includes actual description content in checkpoint digest', async () => {
      const descriptionWithContent = 'This MR adds authentication support.\n\nFixes #123.';
      (mockProvider.getTargetSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...mockTarget,
        description: descriptionWithContent,
      });

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await orchestrator.prepare('!42', 'group/project');
      await orchestrator.publishCheckpoint('group/project');

      const updatedDesc = (mockProvider.updateDescription as ReturnType<typeof vi.fn>).mock.calls[0][1];
      const state = parseDescriptionState(updatedDesc);
      expect(state).not.toBeNull();
      // Digest should NOT be the hash of empty string
      const emptyHash = computeContentHash('');
      expect(state!.checkpoint.descriptionDigest).not.toBe(emptyHash);
      expect(state!.checkpoint.descriptionDigest).toBeTruthy();
    });

    it('sets providerVersionId from latest version in advanceCheckpoint', async () => {
      (mockProvider.getDiffVersions as ReturnType<typeof vi.fn>).mockResolvedValue([
        { ...mockVersion, versionId: 'version-42' },
      ]);

      const orchestrator = new ReviewOrchestrator({ provider: mockProvider, workingDir: tmpDir });
      await orchestrator.prepare('!42', 'group/project');
      await orchestrator.publishCheckpoint('group/project');

      const updatedDesc = (mockProvider.updateDescription as ReturnType<typeof vi.fn>).mock.calls[0][1];
      const state = parseDescriptionState(updatedDesc);
      expect(state).not.toBeNull();
      expect(state!.checkpoint.providerVersionId).toBe('version-42');
    });
  });
});
