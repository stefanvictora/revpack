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

async function readLocalState(workingDir: string): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(path.join(workingDir, '.revpack', 'local', 'state.json'), 'utf-8');
  return JSON.parse(raw) as Record<string, unknown>;
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
    const state = await readLocalState(tmpDir);
    expect(state.reviewNote).toEqual({ id: noteId, body: '<!-- marker -->\nVisible review note' });
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

  it('initializes with default state when no state file exists', async () => {
    const provider = new LocalGitProvider(tmpDir, 'main', { git: createMockGit() });
    // No .revpack/local/state.json exists → loadState falls through to ENOENT path
    const target = await provider.getTargetSnapshot(provider.resolveTarget('main'));
    // Should have proper structure (not an empty object)
    expect(target.description).toBe('');
    const threads = await provider.listAllThreads(provider.resolveTarget('main'));
    expect(threads).toEqual([]);
  });
});

describe('LocalGitProvider range parsing', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'revpack-local-range-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('resolves a triple-dot range (base...head) using merge-base', async () => {
    const provider = new LocalGitProvider(tmpDir, 'develop...feature/x', { git: createMockGit() });
    const target = await provider.getTargetSnapshot(provider.resolveTarget('develop...feature/x'));

    expect(target.targetId).toBe('develop...feature/local-review');
    expect(target.diffRefs.baseSha).toBe('merge-base:develop:feature/x');
    expect(target.diffRefs.headSha).toBe('sha:feature/x');
  });

  it('resolves a double-dot range (base..head) using rev-parse for both', async () => {
    const mockGit = createMockGit({
      revParse: (ref: string) => {
        const shas: Record<string, string> = {
          HEAD: 'head-sha',
          'release/1.0': 'release-sha',
          'feature/y': 'feature-y-sha',
        };
        return Promise.resolve(shas[ref] ?? `sha:${ref}`);
      },
    });
    const provider = new LocalGitProvider(tmpDir, 'release/1.0..feature/y', { git: mockGit });
    const target = await provider.getTargetSnapshot(provider.resolveTarget('release/1.0..feature/y'));

    // Double-dot uses rev-parse for baseSha (not merge-base)
    expect(target.diffRefs.baseSha).toBe('release-sha');
    expect(target.diffRefs.headSha).toBe('feature-y-sha');
  });

  it('resolves a single ref using merge-base against HEAD', async () => {
    const provider = new LocalGitProvider(tmpDir, 'main', { git: createMockGit() });
    const target = await provider.getTargetSnapshot(provider.resolveTarget('main'));

    expect(target.diffRefs.baseSha).toBe('merge-base:main:HEAD');
    expect(target.diffRefs.headSha).toBe('head-sha');
    expect(target.targetBranch).toBe('main');
  });

  it('auto-detects base from common refs when no explicit range given', async () => {
    const provider = new LocalGitProvider(tmpDir, undefined, { git: createMockGit() });
    const target = await provider.getTargetSnapshot(provider.resolveTarget(''));

    // 'main' is the first ref that refExists returns true for and whose sha differs from HEAD
    expect(target.targetBranch).toBe('main');
    expect(target.diffRefs.baseSha).toBe('merge-base:main:HEAD');
  });

  it('skips candidate base refs with same sha as HEAD', async () => {
    const mockGit = createMockGit({
      revParse: (ref: string) => {
        // Make 'main' resolve to same sha as HEAD
        if (ref === 'HEAD' || ref === 'main') return Promise.resolve('same-sha');
        return Promise.resolve(`sha:${ref}`);
      },
      refExists: (ref: string) => Promise.resolve(ref === 'main' || ref === 'origin/develop'),
      mergeBase: (_l: string, _r: string) => Promise.resolve('develop-merge-base'),
    });
    const provider = new LocalGitProvider(tmpDir, undefined, { git: mockGit });
    const target = await provider.getTargetSnapshot(provider.resolveTarget(''));

    // Should skip 'main' (same sha) and use 'origin/develop'
    expect(target.targetBranch).toBe('origin/develop');
  });

  it('throws when no common base ref is found', async () => {
    const mockGit = createMockGit({
      refExists: () => Promise.resolve(false),
    });
    const provider = new LocalGitProvider(tmpDir, undefined, { git: mockGit });

    await expect(provider.getTargetSnapshot(provider.resolveTarget(''))).rejects.toThrow(
      'Could not determine a base branch',
    );
  });

  it('reuses existing baseRef for subsequent calls without explicit range', async () => {
    const mockGit = createMockGit();
    const provider = new LocalGitProvider(tmpDir, undefined, { git: mockGit });

    // First call discovers 'main' as base
    await provider.getTargetSnapshot(provider.resolveTarget(''));

    // Second call should reuse existing.baseRef from saved state
    const target = await provider.getTargetSnapshot(provider.resolveTarget(''));
    expect(target.targetBranch).toBe('main');
  });

  it('trims whitespace from explicit range', async () => {
    const provider = new LocalGitProvider(tmpDir, '  main  ', { git: createMockGit() });
    const target = await provider.getTargetSnapshot(provider.resolveTarget(''));

    expect(target.targetBranch).toBe('main');
  });
});

describe('LocalGitProvider error paths', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'revpack-local-err-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('throws on detached HEAD', async () => {
    const mockGit = createMockGit({ currentBranch: () => Promise.resolve('HEAD') });
    const provider = new LocalGitProvider(tmpDir, 'main', { git: mockGit });

    await expect(provider.getTargetSnapshot(provider.resolveTarget('main'))).rejects.toThrow('detached HEAD');
  });

  it('throws when current branch differs from active review branch', async () => {
    // Seed an existing state with a different branch
    const stateDir = path.join(tmpDir, '.revpack', 'local');
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, 'state.json'),
      JSON.stringify({
        schemaVersion: 1,
        target: { branch: 'other-branch', baseRef: 'main' },
        description: '',
        nextThreadNumber: 1,
        threads: [],
      }),
      'utf-8',
    );

    const mockGit = createMockGit({ currentBranch: () => Promise.resolve('feature/new') });
    const provider = new LocalGitProvider(tmpDir, 'main', { git: mockGit });

    await expect(provider.getTargetSnapshot(provider.resolveTarget('main'))).rejects.toThrow(
      'differs from the active local review branch',
    );
  });

  it('throws when base ref differs from active review base', async () => {
    const stateDir = path.join(tmpDir, '.revpack', 'local');
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, 'state.json'),
      JSON.stringify({
        schemaVersion: 1,
        target: { branch: 'feature/local-review', baseRef: 'develop' },
        description: '',
        nextThreadNumber: 1,
        threads: [],
      }),
      'utf-8',
    );

    const provider = new LocalGitProvider(tmpDir, 'main', { git: createMockGit() });

    await expect(provider.getTargetSnapshot(provider.resolveTarget('main'))).rejects.toThrow('different base');
  });

  it('falls back to path.basename for repository slug when deriveRepoSlug fails', async () => {
    const mockGit = createMockGit({
      deriveRepoSlug: () => Promise.reject(new Error('no remote')),
      repositoryRoot: () => Promise.resolve(path.join('/workspaces', 'my-project')),
    });
    const provider = new LocalGitProvider(tmpDir, 'main', { git: mockGit });
    const target = await provider.getTargetSnapshot(provider.resolveTarget('main'));

    expect(target.repository).toBe('my-project');
  });
});

describe('LocalGitProvider note and thread operations', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'revpack-local-ops-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('createNote uses existing note id when state already has a note', async () => {
    const provider = new LocalGitProvider(tmpDir, 'main', { git: createMockGit() });
    const ref = provider.resolveTarget('main');

    const firstId = await provider.createNote(ref, 'First');
    const secondId = await provider.createNote(ref, 'Second');
    expect(secondId).toBe(firstId);
  });

  it('createNote uses default id when no existing note', async () => {
    const provider = new LocalGitProvider(tmpDir, 'main', { git: createMockGit() });
    const ref = provider.resolveTarget('main');

    const id = await provider.createNote(ref, 'Body');
    expect(id).toBe('local-review-note');
  });

  it('updateNote persists the new body', async () => {
    const provider = new LocalGitProvider(tmpDir, 'main', { git: createMockGit() });
    const ref = provider.resolveTarget('main');

    const noteId = await provider.createNote(ref, 'Old body');
    await provider.updateNote(ref, noteId, '<!-- marker -->\nNew body');

    const secondId = await provider.createNote(ref, 'Replacement body');
    expect(secondId).toBe(noteId);

    const state = await readLocalState(tmpDir);
    expect(state.reviewNote).toEqual({ id: noteId, body: 'Replacement body' });
  });

  it('postReply throws when thread does not exist', async () => {
    const provider = new LocalGitProvider(tmpDir, 'main', { git: createMockGit() });
    const ref = provider.resolveTarget('main');

    await expect(provider.postReply(ref, 'nonexistent', 'body')).rejects.toThrow('Local thread not found');
  });

  it('resolveThread throws when thread does not exist', async () => {
    const provider = new LocalGitProvider(tmpDir, 'main', { git: createMockGit() });
    const ref = provider.resolveTarget('main');

    await expect(provider.resolveThread(ref, 'nonexistent')).rejects.toThrow('Local thread not found');
  });

  it('createThread without position creates a positional-less thread', async () => {
    const provider = new LocalGitProvider(tmpDir, 'main', { git: createMockGit() });
    const ref = provider.resolveTarget('main');

    const threadId = await provider.createThread(ref, 'Finding without position');
    const threads = await provider.listAllThreads(ref);
    const thread = threads.find((t) => t.threadId === threadId)!;

    expect(thread.position).toBeUndefined();
    expect(thread.comments[0].body).toBe('Finding without position');
    expect(thread.resolved).toBe(false);
    expect(thread.resolvable).toBe(true);
  });

  it('createThread with position sets oldPath as fallback for filePath', async () => {
    const provider = new LocalGitProvider(tmpDir, 'main', { git: createMockGit() });
    const ref = provider.resolveTarget('main');

    const threadId = await provider.createThread(ref, 'Body', {
      oldPath: 'old/file.ts',
      newPath: undefined as unknown as string,
      oldLine: 10,
    });
    const threads = await provider.listAllThreads(ref);
    const thread = threads.find((t) => t.threadId === threadId)!;

    expect(thread.position?.filePath).toBe('old/file.ts');
  });

  it('getDiffVersions returns a single version based on current target', async () => {
    const provider = new LocalGitProvider(tmpDir, 'main', { git: createMockGit() });
    const ref = provider.resolveTarget('main');

    const versions = await provider.getDiffVersions(ref);
    expect(versions).toHaveLength(1);
    expect(versions[0].provider).toBe('local');
    expect(versions[0].headCommitSha).toBe('head-sha');
    expect(versions[0].baseCommitSha).toBe('merge-base:main:HEAD');
  });

  it('listOpenReviewTargets returns a single target', async () => {
    const provider = new LocalGitProvider(tmpDir, 'main', { git: createMockGit() });
    const targets = await provider.listOpenReviewTargets('');
    expect(targets).toHaveLength(1);
    expect(targets[0].provider).toBe('local');
  });

  it('findTargetByBranch returns a single target', async () => {
    const provider = new LocalGitProvider(tmpDir, 'main', { git: createMockGit() });
    const targets = await provider.findTargetByBranch('', '');
    expect(targets).toHaveLength(1);
    expect(targets[0].provider).toBe('local');
  });

  it('getCloneUrl returns the repo string unchanged', () => {
    const provider = new LocalGitProvider(tmpDir, 'main', { git: createMockGit() });
    expect(provider.getCloneUrl('my/repo')).toBe('my/repo');
  });

  it('resolveTarget returns correct field values', () => {
    const provider = new LocalGitProvider(tmpDir, 'main', { git: createMockGit() });
    const ref = provider.resolveTarget('some-ref');

    expect(ref.provider).toBe('local');
    expect(ref.repository).toBe('');
    expect(ref.targetType).toBe('local_review');
    expect(ref.targetId).toBe('some-ref');
  });

  it('resolveTarget uses "local" for empty ref', () => {
    const provider = new LocalGitProvider(tmpDir, 'main', { git: createMockGit() });
    const ref = provider.resolveTarget('');
    expect(ref.targetId).toBe('local');
  });

  it('getTargetSnapshot returns full target with expected field values', async () => {
    const provider = new LocalGitProvider(tmpDir, 'main', { git: createMockGit() });
    const target = await provider.getTargetSnapshot(provider.resolveTarget('main'));

    expect(target.state).toBe('opened');
    expect(target.webUrl).toBe('');
    expect(target.labels).toEqual([]);
    expect(target.targetType).toBe('local_review');
    expect(target.title).toBe('Local review: feature/local-review into main');
    expect(target.author).toBe('Local Tester');
    expect(target.sourceBranch).toBe('feature/local-review');
    expect(target.repository).toBe('owner/repo');
  });

  it('uses email as author fallback when user.name is not set', async () => {
    const mockGit = createMockGit({
      configValue: (key: string) => Promise.resolve(key === 'user.email' ? 'user@example.com' : undefined),
    });
    const provider = new LocalGitProvider(tmpDir, 'main', { git: mockGit });
    const target = await provider.getTargetSnapshot(provider.resolveTarget('main'));

    expect(target.author).toBe('user@example.com');
  });

  it('uses "local" as author fallback when neither user.name nor email is set', async () => {
    const mockGit = createMockGit({
      configValue: () => Promise.resolve(undefined),
    });
    const provider = new LocalGitProvider(tmpDir, 'main', { git: mockGit });
    const target = await provider.getTargetSnapshot(provider.resolveTarget('main'));

    expect(target.author).toBe('local');
  });

  it('preserves createdAt from existing state on subsequent calls', async () => {
    const mockGit = createMockGit();
    const provider = new LocalGitProvider(tmpDir, 'main', { git: mockGit });

    // Seed state with a distinct createdAt in the past
    const stateDir = path.join(tmpDir, '.revpack', 'local');
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, 'state.json'),
      JSON.stringify({
        schemaVersion: 1,
        target: {
          branch: 'feature/local-review',
          baseRef: 'main',
          baseSha: 'old-base',
          headSha: 'old-head',
          targetId: 'main...feature/local-review',
          title: 'old',
          author: 'old',
          repository: 'owner/repo',
          createdAt: '2020-01-01T00:00:00.000Z',
          updatedAt: '2020-01-01T00:00:00.000Z',
        },
        description: '',
        nextThreadNumber: 1,
        threads: [],
      }),
      'utf-8',
    );

    const target = await provider.getTargetSnapshot(provider.resolveTarget(''));
    // createdAt should be preserved from existing state, not replaced with current time
    expect(target.createdAt).toBe('2020-01-01T00:00:00.000Z');
    // updatedAt should be current (different from the old one)
    expect(target.updatedAt).not.toBe('2020-01-01T00:00:00.000Z');
  });

  it('postReply generates sequential comment IDs', async () => {
    const provider = new LocalGitProvider(tmpDir, 'main', { git: createMockGit() });
    const ref = provider.resolveTarget('main');

    const threadId = await provider.createThread(ref, 'Initial');
    await provider.postReply(ref, threadId, 'Reply 1');
    await provider.postReply(ref, threadId, 'Reply 2');

    const threads = await provider.listAllThreads(ref);
    const thread = threads.find((t) => t.threadId === threadId)!;
    expect(thread.comments).toHaveLength(3);
    expect(thread.comments[0].id).toBe(`${threadId}-C001`);
    expect(thread.comments[1].id).toBe(`${threadId}-C002`);
    expect(thread.comments[2].id).toBe(`${threadId}-C003`);
    // Verify comment fields
    expect(thread.comments[1].author).toBe('agent');
    expect(thread.comments[1].origin).toBe('bot');
    expect(thread.comments[1].system).toBe(false);
    expect(thread.comments[1].body).toBe('Reply 1');
  });

  it('createThread generates sequential thread IDs', async () => {
    const provider = new LocalGitProvider(tmpDir, 'main', { git: createMockGit() });
    const ref = provider.resolveTarget('main');

    const id1 = await provider.createThread(ref, 'First');
    const id2 = await provider.createThread(ref, 'Second');
    const id3 = await provider.createThread(ref, 'Third');

    expect(id1).toBe('L-001');
    expect(id2).toBe('L-002');
    expect(id3).toBe('L-003');
  });

  it('updateDescription persists the description', async () => {
    const provider = new LocalGitProvider(tmpDir, 'main', { git: createMockGit() });
    const ref = provider.resolveTarget('main');

    await provider.updateDescription(ref, 'New description');
    const target = await provider.getTargetSnapshot(ref);
    expect(target.description).toBe('New description');
  });

  it('loadState handles nextThreadNumber of 0 by defaulting to 1', async () => {
    const stateDir = path.join(tmpDir, '.revpack', 'local');
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, 'state.json'),
      JSON.stringify({ schemaVersion: 1, description: '', nextThreadNumber: 0, threads: [] }),
      'utf-8',
    );

    const provider = new LocalGitProvider(tmpDir, 'main', { git: createMockGit() });
    const ref = provider.resolveTarget('main');
    const threadId = await provider.createThread(ref, 'Body');
    // If nextThreadNumber was 0, it defaults to 1, so first thread should be L-001
    expect(threadId).toBe('L-001');
  });

  it('createThread sets correct comment fields', async () => {
    const provider = new LocalGitProvider(tmpDir, 'main', { git: createMockGit() });
    const ref = provider.resolveTarget('main');

    await provider.createThread(ref, 'Finding body');
    const threads = await provider.listAllThreads(ref);
    const comment = threads[0].comments[0];

    expect(comment.author).toBe('agent');
    expect(comment.origin).toBe('bot');
    expect(comment.system).toBe(false);
    expect(comment.body).toBe('Finding body');
    expect(comment.createdAt).toBeTruthy();
    expect(comment.updatedAt).toBeTruthy();
  });

  it('normalizeThreadRef sets provider to local', async () => {
    const provider = new LocalGitProvider(tmpDir, 'main', { git: createMockGit() });
    const ref = provider.resolveTarget('main');

    await provider.createThread(ref, 'Body');
    const threads = await provider.listAllThreads(ref);

    expect(threads[0].provider).toBe('local');
    expect(threads[0].targetRef).toEqual(ref);
  });

  it('resolveThread sets resolvedBy to local', async () => {
    const provider = new LocalGitProvider(tmpDir, 'main', { git: createMockGit() });
    const ref = provider.resolveTarget('main');

    const threadId = await provider.createThread(ref, 'Body');
    await provider.resolveThread(ref, threadId);

    const threads = await provider.listAllThreads(ref);
    expect(threads[0].resolved).toBe(true);
    expect(threads[0].resolvedBy).toBe('local');
    expect(threads[0].resolvedAt).toBeTruthy();
  });
});

describe('LocalGitProvider range parsing edge cases', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'revpack-local-regex-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('trims whitespace from triple-dot capture groups', async () => {
    const mockGit = createMockGit({
      mergeBase: (left: string, _right: string) => Promise.resolve(`mb:${left}`),
      revParse: (ref: string) => Promise.resolve(`sha:${ref}`),
    });
    // Spaces around the refs inside the triple-dot notation
    const provider = new LocalGitProvider(tmpDir, 'main ... feature/x', { git: mockGit });
    const target = await provider.getTargetSnapshot(provider.resolveTarget(''));

    // .trim() on the groups removes internal spaces
    expect(target.diffRefs.baseSha).toBe('mb:main');
    expect(target.diffRefs.headSha).toBe('sha:feature/x');
  });

  it('trims whitespace from double-dot capture groups', async () => {
    const mockGit = createMockGit({
      revParse: (ref: string) => Promise.resolve(`sha:${ref}`),
    });
    const provider = new LocalGitProvider(tmpDir, 'main .. feature/y', { git: mockGit });
    const target = await provider.getTargetSnapshot(provider.resolveTarget(''));

    expect(target.diffRefs.baseSha).toBe('sha:main');
    expect(target.diffRefs.headSha).toBe('sha:feature/y');
  });

  it('constructs targetId correctly for single-ref range', async () => {
    const provider = new LocalGitProvider(tmpDir, 'develop', { git: createMockGit() });
    const target = await provider.getTargetSnapshot(provider.resolveTarget(''));

    expect(target.targetId).toBe('develop...feature/local-review');
    expect(target.title).toContain('develop');
  });

  it('constructs targetId correctly for auto-detected base', async () => {
    const provider = new LocalGitProvider(tmpDir, undefined, { git: createMockGit() });
    const target = await provider.getTargetSnapshot(provider.resolveTarget(''));

    expect(target.targetId).toBe('main...feature/local-review');
  });

  it('computes targetId from existing baseRef on subsequent runs', async () => {
    // Use a non-common ref (not in COMMON_BASE_REFS) so auto-detection won't find it
    const mockGit = createMockGit({
      refExists: (ref: string) => Promise.resolve(ref === 'release/v2'),
      mergeBase: (_l: string, _r: string) => Promise.resolve('release-merge-base'),
    });

    // First run with explicit ref establishes state
    const provider = new LocalGitProvider(tmpDir, 'release/v2', { git: mockGit });
    await provider.getTargetSnapshot(provider.resolveTarget(''));

    // Second run with no explicit range should reuse existing.baseRef
    const provider2 = new LocalGitProvider(tmpDir, undefined, { git: mockGit });
    const target = await provider2.getTargetSnapshot(provider2.resolveTarget(''));
    expect(target.targetId).toBe('release/v2...feature/local-review');
    expect(target.targetBranch).toBe('release/v2');
  });

  it('error message for detached HEAD mentions detached HEAD', async () => {
    const mockGit = createMockGit({ currentBranch: () => Promise.resolve('HEAD') });
    const provider = new LocalGitProvider(tmpDir, 'main', { git: mockGit });

    await expect(provider.getTargetSnapshot(provider.resolveTarget(''))).rejects.toThrow(
      'Cannot prepare a local review from a detached HEAD checkout.',
    );
  });

  it('error message for branch mismatch includes both branch names', async () => {
    const stateDir = path.join(tmpDir, '.revpack', 'local');
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, 'state.json'),
      JSON.stringify({
        schemaVersion: 1,
        target: { branch: 'old-branch', baseRef: 'main' },
        description: '',
        nextThreadNumber: 1,
        threads: [],
      }),
      'utf-8',
    );

    const mockGit = createMockGit({ currentBranch: () => Promise.resolve('new-branch') });
    const provider = new LocalGitProvider(tmpDir, 'main', { git: mockGit });

    await expect(provider.getTargetSnapshot(provider.resolveTarget(''))).rejects.toThrow('new-branch');
  });

  it('error message for no base branch includes usage instructions', async () => {
    const mockGit = createMockGit({ refExists: () => Promise.resolve(false) });
    const provider = new LocalGitProvider(tmpDir, undefined, { git: mockGit });

    await expect(provider.getTargetSnapshot(provider.resolveTarget(''))).rejects.toThrow(
      'revpack prepare --local <base>',
    );
  });

  it('loadState error message includes file path', async () => {
    const stateDir = path.join(tmpDir, '.revpack', 'local');
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(path.join(stateDir, 'state.json'), 'corrupt', 'utf-8');

    const provider = new LocalGitProvider(tmpDir, undefined, { git: createMockGit() });
    await expect(provider.getTargetSnapshot(provider.resolveTarget(''))).rejects.toThrow(
      path.join(tmpDir, '.revpack', 'local', 'state.json'),
    );
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

    await orchestrator.publishCheckpoint();
    const state = await readLocalState(tmpDir);
    const checkpoint = parseDescriptionState(state.description as string);
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
      schemaVersion: 3,
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
        contract: '.revpack/CONTEXT.md',
        instructions: '.revpack/INSTRUCTIONS.md',
        instructionsDir: '.revpack/instructions/',
        description: '.revpack/description.md',
        latestPatch: '.revpack/diffs/latest.patch',
        incrementalPatch: null,
        filesJson: '.revpack/diffs/files.json',
        anchorMapsDir: '.revpack/diffs/anchor-maps/',
        outputs: '.revpack/outputs',
      },
    };

    vi.spyOn(GitHelper.prototype, 'currentBranch').mockResolvedValue('feature/local-review');
    vi.spyOn(GitHelper.prototype, 'headSha').mockResolvedValue('head-sha');
    vi.spyOn(GitHelper.prototype, 'repositoryRoot').mockResolvedValue(tmpDir);
    vi.spyOn(GitHelper.prototype, 'hasCommit').mockResolvedValue(true);
    vi.spyOn(GitHelper.prototype, 'diffForReview').mockResolvedValue(localPatch());
    vi.spyOn(GitHelper.prototype, 'listReviewCommits').mockResolvedValue([
      {
        sha: '1111111111111111111111111111111111111111',
        shortSha: '1111111',
        authorName: 'Local Tester',
        authorDate: '2026-07-07',
        message: 'Local review change',
      },
    ]);

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
    expect(result.bundleState.outputs.review).toEqual({ path: '.revpack/outputs/review.md' });
    expect(result.bundleState.paths.commits).toBe('.revpack/commits.md');
  });
});
