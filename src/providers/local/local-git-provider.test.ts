import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { ReviewOrchestrator } from '../../orchestration/orchestrator.js';
import { parseDescriptionState } from '../../workspace/checkpoint.js';
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
  });

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
  });
});
