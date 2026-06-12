import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { __testing } from './publish.js';
import { createOrchestrator, getRepoFromGit } from '../helpers.js';
import { computeContentHash } from '../../workspace/thread-digest.js';

vi.mock('../helpers.js', () => ({
  createOrchestrator: vi.fn(),
  getRepoFromGit: vi.fn(),
  handleError: vi.fn(),
  outputJson: vi.fn(),
}));

describe('publish command internals', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'revpack-publish-test-'));
    vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    vi.mocked(getRepoFromGit).mockResolvedValue('group/project');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeBundleState(provider = 'gitlab', options?: { summaryHash?: string }): Promise<void> {
    await fs.mkdir(path.join(tmpDir, '.revpack'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, '.revpack', 'bundle.json'),
      JSON.stringify(
        {
          target: { provider, diffRefs: { headSha: 'head-sha' } },
          outputs: {
            review: { path: '.revpack/outputs/review.md' },
            summary: {
              path: '.revpack/outputs/summary.md',
              ...(options?.summaryHash ? { lastPublishedHash: options.summaryHash } : {}),
            },
          },
          publishedActions: [],
        },
        null,
        2,
      ),
      'utf-8',
    );
  }

  async function writeValidFindingBundle(): Promise<void> {
    await fs.mkdir(path.join(tmpDir, '.revpack', 'diffs'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, '.revpack', 'outputs'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, '.revpack', 'diffs', 'latest.patch'),
      [
        'diff --git a/src/app.ts b/src/app.ts',
        'index 1111111..2222222 100644',
        '--- a/src/app.ts',
        '+++ b/src/app.ts',
        '@@ -1 +1,2 @@',
        ' const value = read();',
        '+audit(value);',
        '',
      ].join('\n'),
      'utf-8',
    );
    await fs.writeFile(
      path.join(tmpDir, '.revpack', 'outputs', 'new-findings.json'),
      JSON.stringify([
        {
          oldPath: 'src/app.ts',
          newPath: 'src/app.ts',
          newLine: 2,
          body: 'Audit call can throw unexpectedly.',
          severity: 'medium',
          category: 'correctness',
        },
      ]),
      'utf-8',
    );
  }

  it('matches T-NNN reply refs case-insensitively', () => {
    const entries = [{ threadId: 'T-001', body: 'reply' }];

    expect(__testing.findReplyEntryIndex(entries, 't-001', 'thread-1')).toBe(0);
  });

  it('removes a single reply after posting even if resolve fails', async () => {
    const repliesPath = path.join(tmpDir, 'replies.json');
    await fs.writeFile(repliesPath, JSON.stringify([{ threadId: 'T-001', body: 'reply', resolve: true }]), 'utf-8');

    const orchestrator = {
      resolveThreadRef: vi.fn().mockResolvedValue('thread-1'),
      publishReply: vi.fn().mockResolvedValue(undefined),
      resolveThread: vi.fn().mockRejectedValue(new Error('resolve failed')),
    };
    vi.mocked(createOrchestrator).mockResolvedValue(orchestrator as never);

    await expect(__testing.publishReplies({ thread: 't-001', from: repliesPath })).rejects.toThrow('resolve failed');

    await expect(fs.readFile(repliesPath, 'utf-8').then(JSON.parse)).resolves.toEqual([]);
    expect(orchestrator.publishReply).toHaveBeenCalledTimes(1);
    expect(orchestrator.resolveThread).toHaveBeenCalledTimes(1);
  });

  it('keeps a reply when posting fails', async () => {
    const repliesPath = path.join(tmpDir, 'replies.json');
    const entries = [{ threadId: 'T-001', body: 'reply', resolve: true }];
    await fs.writeFile(repliesPath, JSON.stringify(entries), 'utf-8');

    const orchestrator = {
      publishReply: vi.fn().mockRejectedValue(new Error('post failed')),
      resolveThread: vi.fn(),
    };
    vi.mocked(createOrchestrator).mockResolvedValue(orchestrator as never);

    await expect(__testing.publishReplies({ from: repliesPath })).resolves.toBe(0);

    await expect(fs.readFile(repliesPath, 'utf-8').then(JSON.parse)).resolves.toEqual(entries);
    expect(orchestrator.resolveThread).not.toHaveBeenCalled();
  });

  it('skips empty summaries instead of publishing an empty description section', async () => {
    await fs.mkdir(path.join(tmpDir, '.revpack', 'outputs'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, '.revpack', 'outputs', 'summary.md'), ' \n\t', 'utf-8');

    await expect(__testing.publishDescription({})).rejects.toThrow('summary.md is empty');
    expect(createOrchestrator).not.toHaveBeenCalled();
  });

  it('rejects when the default summary is missing', async () => {
    await expect(__testing.publishDescription({})).rejects.toThrow('No summary found');
    expect(createOrchestrator).not.toHaveBeenCalled();
  });

  it('treats empty review notes from any source path as no review note to publish', () => {
    expect(__testing.isNoReviewNoteToPublishError(new Error('review.md is empty'))).toBe(true);
    expect(__testing.isNoReviewNoteToPublishError(new Error('custom-note.md is empty; nothing to publish'))).toBe(true);
    expect(__testing.isNoReviewNoteToPublishError(new Error('custom-note.md is empty'))).toBe(true);
    expect(__testing.isNoReviewNoteToPublishError(new Error('custom-note.md is missing'))).toBe(false);
  });

  it('allows publish all to skip an empty default review note', async () => {
    await fs.mkdir(path.join(tmpDir, '.revpack', 'outputs'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, '.revpack', 'outputs', 'review.md'), ' \n\t', 'utf-8');

    await expect(__testing.publishReviewCmd({ allowEmpty: true })).resolves.toBe(0);
    expect(createOrchestrator).not.toHaveBeenCalled();
  });

  it('keeps explicit review publishing strict for empty review notes', async () => {
    await fs.mkdir(path.join(tmpDir, '.revpack', 'outputs'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, '.revpack', 'outputs', 'review.md'), ' \n\t', 'utf-8');

    await expect(__testing.publishReviewCmd({})).rejects.toThrow('review.md is empty');
    expect(createOrchestrator).not.toHaveBeenCalled();
  });

  it('clears the default review note after publishing it', async () => {
    await fs.mkdir(path.join(tmpDir, '.revpack', 'outputs'), { recursive: true });
    await writeBundleState();
    const reviewPath = path.join(tmpDir, '.revpack', 'outputs', 'review.md');
    await fs.writeFile(reviewPath, 'Review body', 'utf-8');

    const orchestrator = {
      publishReview: vi.fn().mockResolvedValue({ created: true, noteId: 'note-1' }),
    };
    vi.mocked(createOrchestrator).mockResolvedValue(orchestrator as never);

    await expect(__testing.publishReviewCmd({})).resolves.toBe(1);

    await expect(fs.readFile(reviewPath, 'utf-8')).resolves.toBe('');
    const bundleState = JSON.parse(await fs.readFile(path.join(tmpDir, '.revpack', 'bundle.json'), 'utf-8'));
    expect(bundleState.outputs.review.lastPublishedHash).toBeUndefined();
    expect(bundleState.outputs.review.providerNoteId).toBeUndefined();
  });

  it('clears the default review note even when bundle state is unavailable', async () => {
    await fs.mkdir(path.join(tmpDir, '.revpack', 'outputs'), { recursive: true });
    const reviewPath = path.join(tmpDir, '.revpack', 'outputs', 'review.md');
    await fs.writeFile(reviewPath, 'Review body', 'utf-8');

    const orchestrator = {
      publishReview: vi.fn().mockResolvedValue({ created: true, noteId: 'note-1' }),
    };
    vi.mocked(createOrchestrator).mockResolvedValue(orchestrator as never);

    await expect(__testing.publishReviewCmd({})).resolves.toBe(1);

    await expect(fs.readFile(reviewPath, 'utf-8')).resolves.toBe('');
  });

  it('does not clear the default review note when publishing from a custom file', async () => {
    await fs.mkdir(path.join(tmpDir, '.revpack', 'outputs'), { recursive: true });
    await writeBundleState();
    const reviewPath = path.join(tmpDir, '.revpack', 'outputs', 'review.md');
    const customPath = path.join(tmpDir, 'custom-review.md');
    await fs.writeFile(reviewPath, 'Pending default review', 'utf-8');
    await fs.writeFile(customPath, 'Custom review body', 'utf-8');

    const orchestrator = {
      publishReview: vi.fn().mockResolvedValue({ created: true, noteId: 'note-1' }),
    };
    vi.mocked(createOrchestrator).mockResolvedValue(orchestrator as never);

    await expect(__testing.publishReviewCmd({ from: customPath })).resolves.toBe(1);

    await expect(fs.readFile(reviewPath, 'utf-8')).resolves.toBe('Pending default review');
    await expect(fs.readFile(customPath, 'utf-8')).resolves.toBe('Custom review body');
  });

  it('clears the default review note after including it in a GitHub review batch', async () => {
    await writeBundleState('github');
    await writeValidFindingBundle();
    const reviewPath = path.join(tmpDir, '.revpack', 'outputs', 'review.md');
    await fs.writeFile(reviewPath, 'Batch review body', 'utf-8');

    const orchestrator = {
      publishReviewBatch: vi.fn().mockResolvedValue({ created: true }),
    };
    vi.mocked(createOrchestrator).mockResolvedValue(orchestrator as never);

    await expect(__testing.publishFindingsAndReviewBatch('Batch review body')).resolves.toBe(1);

    await expect(fs.readFile(reviewPath, 'utf-8')).resolves.toBe('');
    await expect(fs.readFile(path.join(tmpDir, '.revpack', 'outputs', 'new-findings.json'), 'utf-8')).resolves.toBe(
      '[]',
    );
    const bundleState = JSON.parse(await fs.readFile(path.join(tmpDir, '.revpack', 'bundle.json'), 'utf-8'));
    expect(bundleState.outputs.review.lastPublishedHash).toBeUndefined();
  });

  it('uses summary.md as the default description source', async () => {
    await fs.mkdir(path.join(tmpDir, '.revpack', 'outputs'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, '.revpack', 'outputs', 'summary.md'), 'Generated summary', 'utf-8');

    const orchestrator = {
      open: vi.fn().mockResolvedValue({ description: 'Existing description' }),
      updateDescription: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(createOrchestrator).mockResolvedValue(orchestrator as never);

    await expect(__testing.publishDescription({})).resolves.toBe(1);

    expect(orchestrator.open).toHaveBeenCalledWith(undefined, 'group/project');
    expect(orchestrator.updateDescription).toHaveBeenCalledWith(
      undefined,
      expect.stringContaining('Generated summary'),
      'group/project',
    );
  });

  it('skips the default summary when it is already published', async () => {
    const summary = 'Generated summary';
    await writeBundleState('gitlab', { summaryHash: computeContentHash(summary) });
    await fs.mkdir(path.join(tmpDir, '.revpack', 'outputs'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, '.revpack', 'outputs', 'summary.md'), summary, 'utf-8');

    await expect(__testing.publishDescription({})).resolves.toBe(0);

    expect(createOrchestrator).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('summary already published'));
  });

  it('publishes a custom description file even when the default summary is already published', async () => {
    const summary = 'Generated summary';
    await writeBundleState('gitlab', { summaryHash: computeContentHash(summary) });
    await fs.mkdir(path.join(tmpDir, '.revpack', 'outputs'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, '.revpack', 'outputs', 'summary.md'), summary, 'utf-8');
    const customPath = path.join(tmpDir, 'custom-summary.md');
    await fs.writeFile(customPath, 'Custom summary', 'utf-8');

    const orchestrator = {
      open: vi.fn().mockResolvedValue({ description: 'Existing description' }),
      updateDescription: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(createOrchestrator).mockResolvedValue(orchestrator as never);

    await expect(__testing.publishDescription({ from: customPath })).resolves.toBe(1);

    expect(orchestrator.updateDescription).toHaveBeenCalledWith(
      undefined,
      expect.stringContaining('Custom summary'),
      'group/project',
    );
  });

  it('auto-refreshes after publish without mutating unrelated pending outputs', async () => {
    const orchestrator = {
      prepare: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(createOrchestrator).mockResolvedValue(orchestrator as never);

    await __testing.autoRefresh();

    expect(orchestrator.prepare).toHaveBeenCalledWith(undefined, 'group/project', {
      preservePendingOutputs: true,
    });
  });
});
