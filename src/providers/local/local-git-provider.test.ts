import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { ReviewOrchestrator } from '../../orchestration/orchestrator.js';
import { parseDescriptionState } from '../../workspace/checkpoint.js';
import { GitHelper } from '../../workspace/git-helper.js';
import type { BundleState } from '../../core/types.js';
import { LocalGitProvider } from './local-git-provider.js';

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd });
  return stdout.trim();
}

async function commitFile(cwd: string, filePath: string, content: string, message: string): Promise<void> {
  const resolved = path.join(cwd, filePath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, content, 'utf-8');
  await git(cwd, ['add', filePath]);
  await git(cwd, ['commit', '-m', message]);
}

interface MockGit {
  currentBranch(): Promise<string>;
  mergeBase(leftRef: string, rightRef: string): Promise<string>;
  revParse(ref: string): Promise<string>;
  refExists(ref: string): Promise<boolean>;
  deriveRepoSlug(remote?: string): Promise<string>;
  repositoryRoot(): Promise<string>;
  configValue(key: string): Promise<string | undefined>;
}

function createMockGit(overrides: Partial<MockGit> = {}): MockGit {
  return {
    currentBranch: () => Promise.resolve('feature/local-review'),
    mergeBase: (leftRef: string, rightRef: string) => Promise.resolve(`merge-base:${leftRef}:${rightRef}`),
    revParse: (ref: string) => {
      const shas: Record<string, string> = {
        HEAD: 'head-sha',
        main: 'base-sha',
        'feature/local-review': 'feature-sha',
      };
      return Promise.resolve(shas[ref] ?? `sha:${ref}`);
    },
    refExists: (ref: string) => Promise.resolve(ref === 'main'),
    deriveRepoSlug: () => Promise.resolve('owner/repo'),
    repositoryRoot: () => Promise.resolve(path.join('workspace', 'repo')),
    configValue: (key: string) => Promise.resolve(key === 'user.name' ? 'Local Tester' : undefined),
    ...overrides,
  };
}

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

describe('LocalGitProvider unit', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'revpack-local-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('computes and persists a target snapshot using an explicit local range', async () => {
    const provider = new LocalGitProvider(tmpDir, 'main..HEAD', { git: createMockGit() });

    const target = await provider.getTargetSnapshot(provider.resolveTarget('main..HEAD'));

    expect(target.provider).toBe('local');
    expect(target.repository).toBe('owner/repo');
    expect(target.targetType).toBe('local_review');
    expect(target.targetId).toBe('main...feature/local-review');
    expect(target.title).toBe('Local review: feature/local-review into main');
    expect(target.author).toBe('Local Tester');
    expect(target.sourceBranch).toBe('feature/local-review');
    expect(target.targetBranch).toBe('main');
    expect(target.diffRefs).toEqual({
      baseSha: 'base-sha',
      startSha: 'base-sha',
      headSha: 'head-sha',
    });
  });

  it('persists local threads, replies, resolution, description, and review notes', async () => {
    const provider = new LocalGitProvider(tmpDir, 'main', { git: createMockGit() });
    const ref = provider.resolveTarget('main');

    const threadId = await provider.createThread(ref, 'Local finding body', {
      oldPath: 'src/app.ts',
      newPath: 'src/app.ts',
      newLine: 1,
    });
    await provider.createThread(ref, 'Second finding');
    await provider.postReply(ref, threadId, 'Fixed locally.');
    await provider.resolveThread(ref, threadId);
    await provider.updateDescription(ref, 'Review description');
    const noteId = await provider.createNote(ref, '<!-- marker -->\nVisible review note');

    const allThreads = await provider.listAllThreads(ref);
    expect(allThreads.map((thread) => thread.threadId)).toEqual(['L-001', 'L-002']);
    expect(allThreads[0].comments.map((comment) => comment.body)).toEqual(['Local finding body', 'Fixed locally.']);
    expect(allThreads[0].resolved).toBe(true);
    expect(allThreads[0].resolvedBy).toBe('local');
    expect(allThreads[0].position).toMatchObject({
      filePath: 'src/app.ts',
      newLine: 1,
      baseSha: 'merge-base:main:HEAD',
      startSha: 'merge-base:main:HEAD',
      headSha: 'head-sha',
    });

    const unresolvedThreads = await provider.listUnresolvedThreads(ref);
    expect(unresolvedThreads.map((thread) => thread.threadId)).toEqual(['L-002']);

    const target = await provider.getTargetSnapshot(ref);
    expect(target.description).toBe('Review description');
    await expect(provider.findNoteByMarker(ref, '<!-- marker -->')).resolves.toEqual({
      id: noteId,
      body: '<!-- marker -->\nVisible review note',
    });
  });

  it('fails clearly instead of resetting malformed local state', async () => {
    await fs.mkdir(path.join(tmpDir, '.revpack', 'local'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, '.revpack', 'local', 'state.json'), '{ this is not json', 'utf-8');

    const provider = new LocalGitProvider(tmpDir, undefined, { git: createMockGit() });

    await expect(provider.getTargetSnapshot(provider.resolveTarget('local'))).rejects.toThrow(
      'Failed to load local review state',
    );

    const stateRaw = await fs.readFile(path.join(tmpDir, '.revpack', 'local', 'state.json'), 'utf-8');
    expect(stateRaw).toBe('{ this is not json');
  });
});

const describeRealGit = process.env.REVPACK_MUTATION_TEST === '1' ? describe.skip : describe;

describeRealGit('LocalGitProvider integration', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'revpack-local-'));
    await git(tmpDir, ['init']);
    await git(tmpDir, ['config', 'user.name', 'Local Tester']);
    await git(tmpDir, ['config', 'user.email', 'local@example.com']);
    await commitFile(tmpDir, 'src/app.ts', 'export const value = 1;\n', 'initial');
    await git(tmpDir, ['branch', '-M', 'main']);
    await git(tmpDir, ['switch', '-c', 'feature/local-review']);
    await commitFile(tmpDir, 'src/app.ts', 'export const value = 2;\n', 'feature change');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('prepares, advances a checkpoint, and refreshes after HEAD changes', async () => {
    const provider = new LocalGitProvider(tmpDir);
    const orchestrator = new ReviewOrchestrator({ provider, workingDir: tmpDir });

    const first = await orchestrator.prepare();
    expect(first.bundle.target.provider).toBe('local');
    expect(first.bundle.target.targetType).toBe('local_review');
    expect(first.bundle.target.sourceBranch).toBe('feature/local-review');
    expect(first.bundle.target.targetBranch).toBe('main');
    expect(first.bundle.diffs).toHaveLength(1);

    await orchestrator.publishReview('');
    const stateRaw = await fs.readFile(path.join(tmpDir, '.revpack', 'local', 'state.json'), 'utf-8');
    const state = JSON.parse(stateRaw) as { description: string };
    const checkpoint = parseDescriptionState(state.description);
    expect(checkpoint?.target.provider).toBe('local');
    expect(checkpoint?.checkpoint.headSha).toBe(first.bundle.target.diffRefs.headSha);

    await commitFile(tmpDir, 'src/app.ts', 'export const value = 3;\n', 'second feature change');

    const refreshed = await orchestrator.prepare();
    expect(refreshed.targetCodeChanged).toBe(true);

    const incrementalPatch = await fs.readFile(path.join(tmpDir, '.revpack', 'diffs', 'incremental.patch'), 'utf-8');
    expect(incrementalPatch).toContain('+export const value = 3;');
  }, 20000);
});

describe('LocalGitProvider orchestrator boundary', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'revpack-local-mocked-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('ignores a stale remote bundle when preparing a local review', async () => {
    const staleBundle: BundleState = {
      schemaVersion: 2,
      preparedAt: '2026-01-01T00:00:00.000Z',
      tool: { name: 'revpack', version: '0.2.0' },
      target: {
        provider: 'github',
        repository: 'owner/repo',
        type: 'pull_request',
        id: '42',
        title: 'Old PR',
        descriptionPath: '.revpack/description.md',
        author: 'alice',
        state: 'opened',
        sourceBranch: 'old-remote-branch',
        targetBranch: 'main',
        webUrl: 'https://github.com/owner/repo/pull/42',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        labels: [],
        diffRefs: { baseSha: 'old-base', startSha: 'old-base', headSha: 'old-head' },
      },
      local: {
        repositoryRoot: tmpDir,
        branch: 'old-remote-branch',
        headSha: 'old-head',
        matchesTargetSourceBranch: true,
        matchesTargetHead: true,
        workingTreeClean: true,
        checkedAt: '2026-01-01T00:00:00.000Z',
      },
      prepare: {
        mode: 'fresh',
        checkpoint: null,
        current: {
          targetHeadSha: 'old-head',
          localHeadSha: 'old-head',
          threadsDigest: null,
          descriptionDigest: null,
        },
        comparison: {
          targetCodeChangedSinceCheckpoint: null,
          threadsChangedSinceCheckpoint: null,
          descriptionChangedSinceCheckpoint: null,
        },
      },
      threads: { digestVersion: 2, digest: null, items: [] },
      outputs: {
        summary: {
          path: '.revpack/outputs/summary.md',
          lastPublishedHash: 'sha256:old-summary',
        },
        review: {
          path: '.revpack/outputs/review.md',
          lastPublishedHash: 'sha256:old-review',
        },
      },
      publishedActions: [
        {
          type: 'finding',
          providerThreadId: 'remote-thread',
          title: 'Old remote action',
          publishedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      paths: {
        context: '.revpack/CONTEXT.md',
        contract: '.revpack/AGENT_CONTRACT.md',
        instructions: '.revpack/INSTRUCTIONS.md',
        instructionsDir: '.revpack/instructions/',
        description: '.revpack/description.md',
        latestPatch: '.revpack/diffs/latest.patch',
        incrementalPatch: null,
        filesJson: '.revpack/diffs/files.json',
        lineMapNdjson: '.revpack/diffs/line-map.ndjson',
        changeBlocks: '.revpack/diffs/change-blocks.json',
        outputs: '.revpack/outputs',
      },
    };

    vi.spyOn(GitHelper.prototype, 'currentBranch').mockResolvedValue('feature/local-review');
    vi.spyOn(GitHelper.prototype, 'headSha').mockResolvedValue('head-sha');
    vi.spyOn(GitHelper.prototype, 'repositoryRoot').mockResolvedValue(tmpDir);
    vi.spyOn(GitHelper.prototype, 'isClean').mockResolvedValue(true);
    vi.spyOn(GitHelper.prototype, 'hasCommit').mockResolvedValue(true);
    vi.spyOn(GitHelper.prototype, 'diffForReview').mockResolvedValue(localPatch());

    await fs.mkdir(path.join(tmpDir, '.revpack'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, '.revpack', 'bundle.json'), JSON.stringify(staleBundle, null, 2), 'utf-8');

    const provider = new LocalGitProvider(tmpDir, undefined, { git: createMockGit() });
    const orchestrator = new ReviewOrchestrator({ provider, workingDir: tmpDir });
    const result = await orchestrator.prepare();

    expect(result.mode).toBe('fresh');
    expect(result.bundle.target.provider).toBe('local');
    expect(result.bundle.target.sourceBranch).toBe('feature/local-review');
    expect(result.bundle.target.diffRefs.headSha).toBe('head-sha');
    expect(result.bundleState.publishedActions).toEqual([]);
    expect(result.bundleState.outputs.summary.lastPublishedHash).toBeUndefined();
    expect(result.bundleState.outputs.review.lastPublishedHash).toBeUndefined();
  });
});
