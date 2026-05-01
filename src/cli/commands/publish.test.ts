import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { __testing } from './publish.js';
import { createOrchestrator, getRepoFromGit } from '../helpers.js';

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
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'revkit-publish-test-'));
    vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    vi.mocked(getRepoFromGit).mockResolvedValue('group/project');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

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
    await fs.mkdir(path.join(tmpDir, '.revkit', 'outputs'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, '.revkit', 'outputs', 'summary.md'), ' \n\t', 'utf-8');

    await expect(__testing.publishDescription({ fromSummary: true })).rejects.toThrow('summary.md is empty');
    expect(createOrchestrator).not.toHaveBeenCalled();
  });
});
