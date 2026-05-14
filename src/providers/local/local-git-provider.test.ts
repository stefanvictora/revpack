import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { ReviewOrchestrator } from '../../orchestration/orchestrator.js';
import { parseDescriptionState } from '../../workspace/checkpoint.js';
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

describe('LocalGitProvider integration', () => {
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

  it('prepares, persists local threads, resolves replies, and advances a local checkpoint', async () => {
    const provider = new LocalGitProvider(tmpDir);
    const orchestrator = new ReviewOrchestrator({ provider, workingDir: tmpDir });

    const first = await orchestrator.prepare();
    expect(first.bundle.target.provider).toBe('local');
    expect(first.bundle.target.targetType).toBe('local_review');
    expect(first.bundle.target.sourceBranch).toBe('feature/local-review');
    expect(first.bundle.target.targetBranch).toBe('main');
    expect(first.bundle.diffs).toHaveLength(1);

    const createdThreadId = await orchestrator.publishFinding({
      oldPath: 'src/app.ts',
      newPath: 'src/app.ts',
      newLine: 1,
      body: 'Local finding body',
      severity: 'medium',
      category: 'correctness',
    });
    expect(createdThreadId).toBe('L-001');

    const second = await orchestrator.prepare();
    expect(second.bundle.threads.map((thread) => thread.threadId)).toEqual(['L-001']);
    await expect(fs.readFile(path.join(tmpDir, '.revpack', 'threads', 'T-001.md'), 'utf-8')).resolves.toContain(
      'Local finding body',
    );

    await orchestrator.publishReply(undefined, 'T-001', 'Fixed locally.');
    await orchestrator.resolveThread(undefined, 'T-001');
    const third = await orchestrator.prepare();
    expect(third.bundle.threads).toHaveLength(0);

    await orchestrator.publishReview('');
    const stateRaw = await fs.readFile(path.join(tmpDir, '.revpack', 'local', 'state.json'), 'utf-8');
    const state = JSON.parse(stateRaw) as { description: string };
    const checkpoint = parseDescriptionState(state.description);
    expect(checkpoint?.target.provider).toBe('local');
    expect(checkpoint?.checkpoint.headSha).toBe(first.bundle.target.diffRefs.headSha);
  }, 20000);

  it('writes an incremental patch from the local checkpoint when HEAD advances', async () => {
    const provider = new LocalGitProvider(tmpDir);
    const orchestrator = new ReviewOrchestrator({ provider, workingDir: tmpDir });

    await orchestrator.prepare();
    await orchestrator.publishReview('');
    await commitFile(tmpDir, 'src/app.ts', 'export const value = 3;\n', 'second feature change');

    const refreshed = await orchestrator.prepare();
    expect(refreshed.targetCodeChanged).toBe(true);

    const incrementalPatch = await fs.readFile(path.join(tmpDir, '.revpack', 'diffs', 'incremental.patch'), 'utf-8');
    expect(incrementalPatch).toContain('+export const value = 3;');
  }, 20000);

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

    await fs.mkdir(path.join(tmpDir, '.revpack'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, '.revpack', 'bundle.json'), JSON.stringify(staleBundle, null, 2), 'utf-8');

    const provider = new LocalGitProvider(tmpDir);
    const orchestrator = new ReviewOrchestrator({ provider, workingDir: tmpDir });
    const result = await orchestrator.prepare();

    expect(result.mode).toBe('fresh');
    expect(result.bundle.target.provider).toBe('local');
    expect(result.bundle.target.sourceBranch).toBe('feature/local-review');
    expect(result.bundleState.publishedActions).toEqual([]);
    expect(result.bundleState.outputs.summary.lastPublishedHash).toBeUndefined();
    expect(result.bundleState.outputs.review.lastPublishedHash).toBeUndefined();
  }, 20000);

  it('fails clearly instead of resetting malformed local state', async () => {
    await fs.mkdir(path.join(tmpDir, '.revpack', 'local'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, '.revpack', 'local', 'state.json'), '{ this is not json', 'utf-8');

    const provider = new LocalGitProvider(tmpDir);
    const orchestrator = new ReviewOrchestrator({ provider, workingDir: tmpDir });

    await expect(orchestrator.prepare()).rejects.toThrow('Failed to load local review state');

    const stateRaw = await fs.readFile(path.join(tmpDir, '.revpack', 'local', 'state.json'), 'utf-8');
    expect(stateRaw).toBe('{ this is not json');
  }, 20000);
});
