import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadPublishMaterial } from '../workspace/publish-material.js';
import { executePublishPlan, selectAllPublishMaterial } from './publish-plan.js';

describe('shared publish plan', () => {
  let workingDir: string;

  async function writeFindings(findings: unknown[]): Promise<string> {
    const diffsDir = path.join(workingDir, '.revpack', 'diffs');
    await fs.mkdir(diffsDir, { recursive: true });
    await fs.writeFile(
      path.join(diffsDir, 'latest.patch'),
      [
        'diff --git a/src/app.ts b/src/app.ts',
        '--- a/src/app.ts',
        '+++ b/src/app.ts',
        '@@ -1 +1,2 @@',
        ' const value = read();',
        '+audit(value);',
        '',
      ].join('\n'),
      'utf-8',
    );
    const findingsPath = path.join(workingDir, '.revpack', 'outputs', 'new-findings.json');
    await fs.writeFile(findingsPath, JSON.stringify(findings), 'utf-8');
    return findingsPath;
  }

  beforeEach(async () => {
    workingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'revpack-publish-plan-'));
    await fs.mkdir(path.join(workingDir, '.revpack', 'outputs'), { recursive: true });
    await fs.writeFile(
      path.join(workingDir, '.revpack', 'bundle.json'),
      JSON.stringify({
        target: { provider: 'gitlab', diffRefs: { headSha: 'abc1234' } },
        prepare: {
          checkpoint: null,
          comparison: {
            targetCodeChangedSinceCheckpoint: null,
            threadsChangedSinceCheckpoint: null,
            descriptionChangedSinceCheckpoint: null,
          },
        },
        threads: { items: [] },
        outputs: {
          summary: { path: '.revpack/outputs/summary.md' },
          review: { path: '.revpack/outputs/note.md' },
        },
        publishedActions: [],
      }),
      'utf-8',
    );
  });

  afterEach(async () => {
    await fs.rm(workingDir, { recursive: true, force: true });
  });

  it('publishes only selected replies and preserves deferred entries in original order', async () => {
    const replies = [
      { threadId: 'T-001', body: 'First reply', resolve: false },
      { threadId: 'T-002', body: 'Selected reply', resolve: false },
      { threadId: 'T-003', body: 'Third reply', resolve: false },
    ];
    const repliesPath = path.join(workingDir, '.revpack', 'outputs', 'replies.json');
    await fs.writeFile(repliesPath, JSON.stringify(replies), 'utf-8');
    const material = await loadPublishMaterial(workingDir);
    const orchestrator = {
      workspace: { appendPublishedAction: vi.fn().mockResolvedValue(true) },
      publishReply: vi.fn().mockResolvedValue(undefined),
      resolveThread: vi.fn(),
    };

    const result = await executePublishPlan({
      material,
      selection: {
        replyIndexes: [1],
        findingIndexes: [],
        summary: false,
        note: false,
        checkpoint: false,
      },
      orchestrator: orchestrator as never,
      repository: 'group/project',
      refresh: false,
    });

    expect(orchestrator.publishReply).toHaveBeenCalledTimes(1);
    expect(orchestrator.publishReply).toHaveBeenCalledWith(undefined, 'T-002', 'Selected reply', 'group/project');
    await expect(fs.readFile(repliesPath, 'utf-8').then(JSON.parse)).resolves.toEqual([replies[0], replies[2]]);
    expect(result.failures).toEqual([]);
    expect(result.successes).toMatchObject([{ kind: 'reply', index: 1 }]);
    expect(result.remainingReplies).toBe(2);
  });

  it('records the checkpoint and refreshes only after every selected action succeeds', async () => {
    const repliesPath = path.join(workingDir, '.revpack', 'outputs', 'replies.json');
    await fs.writeFile(
      repliesPath,
      JSON.stringify([{ threadId: 'T-001', body: 'Selected reply', resolve: false }]),
      'utf-8',
    );
    const material = await loadPublishMaterial(workingDir);
    const orchestrator = {
      workspace: { appendPublishedAction: vi.fn().mockResolvedValue(true) },
      publishReply: vi.fn().mockResolvedValue(undefined),
      resolveThread: vi.fn(),
      publishCheckpoint: vi.fn().mockResolvedValue(undefined),
      prepare: vi.fn().mockResolvedValue(undefined),
    };

    const result = await executePublishPlan({
      material,
      selection: {
        replyIndexes: [0],
        findingIndexes: [],
        summary: false,
        note: false,
        checkpoint: true,
      },
      orchestrator: orchestrator as never,
      repository: 'group/project',
      refresh: true,
    });

    expect(orchestrator.publishCheckpoint).toHaveBeenCalledWith('group/project');
    expect(orchestrator.prepare).toHaveBeenCalledWith(undefined, 'group/project', { preservePendingOutputs: true });
    expect(orchestrator.publishReply.mock.invocationCallOrder[0]).toBeLessThan(
      orchestrator.publishCheckpoint.mock.invocationCallOrder[0],
    );
    expect(orchestrator.publishCheckpoint.mock.invocationCallOrder[0]).toBeLessThan(
      orchestrator.prepare.mock.invocationCallOrder[0],
    );
    expect(result).toMatchObject({ checkpoint: 'published', refresh: 'succeeded', failures: [] });
  });

  it('preserves a reply queue edited while a provider action is publishing', async () => {
    const replies = [
      { threadId: 'T-001', body: 'Selected reply', resolve: false },
      { threadId: 'T-002', body: 'Deferred reply', resolve: false },
    ];
    const repliesPath = path.join(workingDir, '.revpack', 'outputs', 'replies.json');
    await fs.writeFile(repliesPath, JSON.stringify(replies), 'utf-8');
    const material = await loadPublishMaterial(workingDir);
    const editedReplies = [{ ...replies[0], body: 'Edited while publishing' }, replies[1]];
    const orchestrator = {
      workspace: { appendPublishedAction: vi.fn() },
      publishReply: vi.fn().mockImplementation(async () => {
        await fs.writeFile(repliesPath, JSON.stringify(editedReplies), 'utf-8');
      }),
      publishCheckpoint: vi.fn(),
    };

    const result = await executePublishPlan({
      material,
      selection: {
        replyIndexes: [0],
        findingIndexes: [],
        summary: false,
        note: false,
        checkpoint: true,
      },
      orchestrator: orchestrator as never,
      repository: 'group/project',
      refresh: false,
    });

    await expect(fs.readFile(repliesPath, 'utf-8').then(JSON.parse)).resolves.toEqual(editedReplies);
    expect(result.failures).toMatchObject([{ kind: 'reply', index: 0, error: expect.stringContaining('changed') }]);
    expect(result.successes).not.toContainEqual(expect.objectContaining({ kind: 'reply', index: 0 }));
    expect(result).toMatchObject({ checkpoint: 'blocked', remainingReplies: 2 });
    expect(orchestrator.publishCheckpoint).not.toHaveBeenCalled();
  });

  it('stops before provider actions when selected material changed after preflight', async () => {
    const repliesPath = path.join(workingDir, '.revpack', 'outputs', 'replies.json');
    await fs.writeFile(
      repliesPath,
      JSON.stringify([{ threadId: 'T-001', body: 'Selected at preflight', resolve: false }]),
      'utf-8',
    );
    const material = await loadPublishMaterial(workingDir);
    const newerReplies = [{ threadId: 'T-001', body: 'Edited after preflight', resolve: false }];
    await fs.writeFile(repliesPath, JSON.stringify(newerReplies), 'utf-8');
    const orchestrator = {
      workspace: { appendPublishedAction: vi.fn() },
      publishReply: vi.fn(),
    };

    await expect(
      executePublishPlan({
        material,
        selection: {
          replyIndexes: [0],
          findingIndexes: [],
          summary: false,
          note: false,
          checkpoint: false,
        },
        orchestrator: orchestrator as never,
        repository: 'group/project',
        refresh: false,
      }),
    ).rejects.toThrow(/changed/i);

    expect(orchestrator.publishReply).not.toHaveBeenCalled();
    await expect(fs.readFile(repliesPath, 'utf-8').then(JSON.parse)).resolves.toEqual(newerReplies);
  });

  it('advances the expected reply queue after each successful selective cleanup', async () => {
    const replies = [
      { threadId: 'T-001', body: 'First selected reply', resolve: false },
      { threadId: 'T-002', body: 'Second selected reply', resolve: false },
      { threadId: 'T-003', body: 'Deferred reply', resolve: false },
    ];
    const repliesPath = path.join(workingDir, '.revpack', 'outputs', 'replies.json');
    await fs.writeFile(repliesPath, JSON.stringify(replies), 'utf-8');
    const material = await loadPublishMaterial(workingDir);
    const orchestrator = {
      workspace: { appendPublishedAction: vi.fn().mockResolvedValue(true) },
      publishReply: vi.fn().mockResolvedValue(undefined),
    };

    const result = await executePublishPlan({
      material,
      selection: {
        replyIndexes: [0, 1],
        findingIndexes: [],
        summary: false,
        note: false,
        checkpoint: false,
      },
      orchestrator: orchestrator as never,
      repository: 'group/project',
      refresh: false,
    });

    await expect(fs.readFile(repliesPath, 'utf-8').then(JSON.parse)).resolves.toEqual([replies[2]]);
    expect(result.successes).toMatchObject([
      { kind: 'reply', index: 0 },
      { kind: 'reply', index: 1 },
    ]);
    expect(result).toMatchObject({ failures: [], remainingReplies: 1 });
  });

  it('retains failed replies and blocks checkpoint and refresh after partial success', async () => {
    const replies = [
      { threadId: 'T-001', body: 'Fails', resolve: false },
      { threadId: 'T-002', body: 'Succeeds', resolve: false },
      { threadId: 'T-003', body: 'Deferred', resolve: false },
    ];
    const repliesPath = path.join(workingDir, '.revpack', 'outputs', 'replies.json');
    await fs.writeFile(repliesPath, JSON.stringify(replies), 'utf-8');
    const material = await loadPublishMaterial(workingDir);
    const orchestrator = {
      workspace: { appendPublishedAction: vi.fn().mockResolvedValue(true) },
      publishReply: vi
        .fn()
        .mockRejectedValueOnce(new Error('provider rejected reply'))
        .mockResolvedValueOnce(undefined),
      resolveThread: vi.fn(),
      publishCheckpoint: vi.fn(),
      prepare: vi.fn(),
    };

    const result = await executePublishPlan({
      material,
      selection: {
        replyIndexes: [0, 1],
        findingIndexes: [],
        summary: false,
        note: false,
        checkpoint: true,
      },
      orchestrator: orchestrator as never,
      repository: 'group/project',
      refresh: true,
    });

    await expect(fs.readFile(repliesPath, 'utf-8').then(JSON.parse)).resolves.toEqual([replies[0], replies[2]]);
    expect(result.failures).toMatchObject([{ kind: 'reply', index: 0, error: 'provider rejected reply' }]);
    expect(result).toMatchObject({ checkpoint: 'blocked', refresh: 'skipped', remainingReplies: 2 });
    expect(orchestrator.publishCheckpoint).not.toHaveBeenCalled();
    expect(orchestrator.prepare).not.toHaveBeenCalled();
  });

  it('removes a posted reply but blocks checkpoint when requested thread resolution fails', async () => {
    const repliesPath = path.join(workingDir, '.revpack', 'outputs', 'replies.json');
    await fs.writeFile(
      repliesPath,
      JSON.stringify([{ threadId: 'T-001', body: 'Posted reply', resolve: true }]),
      'utf-8',
    );
    const material = await loadPublishMaterial(workingDir);
    const orchestrator = {
      workspace: { appendPublishedAction: vi.fn().mockResolvedValue(true) },
      publishReply: vi.fn().mockResolvedValue(undefined),
      resolveThread: vi.fn().mockRejectedValue(new Error('resolve failed')),
      publishCheckpoint: vi.fn(),
    };

    const result = await executePublishPlan({
      material,
      selection: {
        replyIndexes: [0],
        findingIndexes: [],
        summary: false,
        note: false,
        checkpoint: true,
      },
      orchestrator: orchestrator as never,
      repository: 'group/project',
      refresh: false,
    });

    await expect(fs.access(repliesPath)).rejects.toThrow();
    expect(orchestrator.resolveThread).toHaveBeenCalledWith(undefined, 'T-001', 'group/project');
    expect(result.failures).toMatchObject([
      {
        kind: 'reply',
        index: 0,
        error: expect.stringContaining('resolve failed'),
      },
    ]);
    expect(result.failures[0].error).toContain('resolution will not be retried automatically');
    expect(result.successes).not.toContainEqual(expect.objectContaining({ kind: 'reply', index: 0 }));
    expect(result.checkpoint).toBe('blocked');
    expect(orchestrator.publishCheckpoint).not.toHaveBeenCalled();
  });

  it('does not report a reply as successful when resolution tracking fails', async () => {
    const repliesPath = path.join(workingDir, '.revpack', 'outputs', 'replies.json');
    await fs.writeFile(
      repliesPath,
      JSON.stringify([{ threadId: 'T-001', body: 'Posted reply', resolve: true }]),
      'utf-8',
    );
    const material = await loadPublishMaterial(workingDir);
    const orchestrator = {
      workspace: {
        appendPublishedAction: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
      },
      publishReply: vi.fn().mockResolvedValue(undefined),
      resolveThread: vi.fn().mockResolvedValue(undefined),
    };

    const result = await executePublishPlan({
      material,
      selection: {
        replyIndexes: [0],
        findingIndexes: [],
        summary: false,
        note: false,
        checkpoint: false,
      },
      orchestrator: orchestrator as never,
      repository: 'group/project',
      refresh: false,
    });

    await expect(fs.access(repliesPath)).rejects.toThrow();
    expect(result.failures).toMatchObject([
      { kind: 'reply', index: 0, error: expect.stringContaining('Could not record the resolved thread') },
    ]);
    expect(result.successes).not.toContainEqual(expect.objectContaining({ kind: 'reply', index: 0 }));
  });

  it('publishes only selected findings individually for non-GitHub providers', async () => {
    const findings = [
      {
        oldPath: 'src/app.ts',
        newPath: 'src/app.ts',
        newLine: 2,
        body: 'Deferred finding',
        severity: 'medium',
        category: 'correctness',
      },
      {
        oldPath: 'src/app.ts',
        newPath: 'src/app.ts',
        oldLine: 1,
        newLine: 1,
        body: 'Selected finding',
        severity: 'high',
        category: 'security',
      },
    ];
    const findingsPath = await writeFindings(findings);
    const material = await loadPublishMaterial(workingDir);
    const orchestrator = {
      workspace: { appendPublishedAction: vi.fn().mockResolvedValue(true) },
      publishFinding: vi.fn().mockResolvedValue('created-thread-1'),
    };

    const result = await executePublishPlan({
      material,
      selection: {
        replyIndexes: [],
        findingIndexes: [1],
        summary: false,
        note: false,
        checkpoint: false,
      },
      orchestrator: orchestrator as never,
      repository: 'group/project',
      refresh: false,
    });

    expect(orchestrator.publishFinding).toHaveBeenCalledTimes(1);
    expect(orchestrator.publishFinding).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('Selected finding') }),
      'group/project',
    );
    await expect(fs.readFile(findingsPath, 'utf-8').then(JSON.parse)).resolves.toEqual([findings[0]]);
    expect(result.successes).toMatchObject([{ kind: 'finding', index: 1 }]);
    expect(result.remainingFindings).toBe(1);
  });

  it('preserves a findings queue edited while an individual provider action is publishing', async () => {
    const findings = [
      {
        oldPath: 'src/app.ts',
        newPath: 'src/app.ts',
        newLine: 2,
        body: 'Selected finding',
        severity: 'high',
        category: 'correctness',
      },
      {
        oldPath: 'src/app.ts',
        newPath: 'src/app.ts',
        oldLine: 1,
        newLine: 1,
        body: 'Deferred finding',
        severity: 'medium',
        category: 'testing',
      },
    ];
    const findingsPath = await writeFindings(findings);
    const material = await loadPublishMaterial(workingDir);
    const editedFindings = [{ ...findings[0], body: 'Edited while publishing' }, findings[1]];
    const orchestrator = {
      workspace: { appendPublishedAction: vi.fn() },
      publishFinding: vi.fn().mockImplementation(async () => {
        await fs.writeFile(findingsPath, JSON.stringify(editedFindings), 'utf-8');
        return 'provider-thread-1';
      }),
    };

    const result = await executePublishPlan({
      material,
      selection: {
        replyIndexes: [],
        findingIndexes: [0],
        summary: false,
        note: false,
        checkpoint: false,
      },
      orchestrator: orchestrator as never,
      repository: 'group/project',
      refresh: false,
    });

    await expect(fs.readFile(findingsPath, 'utf-8').then(JSON.parse)).resolves.toEqual(editedFindings);
    expect(result.failures).toMatchObject([{ kind: 'finding', index: 0, error: expect.stringContaining('changed') }]);
    expect(result.successes).not.toContainEqual(expect.objectContaining({ kind: 'finding', index: 0 }));
    expect(result.remainingFindings).toBe(2);
  });

  it('advances the expected findings queue after each successful selective cleanup', async () => {
    const findings = [
      {
        oldPath: 'src/app.ts',
        newPath: 'src/app.ts',
        newLine: 2,
        body: 'First selected finding',
        severity: 'high',
        category: 'correctness',
      },
      {
        oldPath: 'src/app.ts',
        newPath: 'src/app.ts',
        oldLine: 1,
        newLine: 1,
        body: 'Second selected finding',
        severity: 'medium',
        category: 'testing',
      },
      {
        oldPath: 'src/app.ts',
        newPath: 'src/app.ts',
        newLine: 2,
        body: 'Deferred finding',
        severity: 'low',
        category: 'architecture',
      },
    ];
    const findingsPath = await writeFindings(findings);
    const material = await loadPublishMaterial(workingDir);
    const orchestrator = {
      workspace: { appendPublishedAction: vi.fn().mockResolvedValue(true) },
      publishFinding: vi.fn().mockResolvedValueOnce('provider-thread-1').mockResolvedValueOnce('provider-thread-2'),
    };

    const result = await executePublishPlan({
      material,
      selection: {
        replyIndexes: [],
        findingIndexes: [0, 1],
        summary: false,
        note: false,
        checkpoint: false,
      },
      orchestrator: orchestrator as never,
      repository: 'group/project',
      refresh: false,
    });

    await expect(fs.readFile(findingsPath, 'utf-8').then(JSON.parse)).resolves.toEqual([findings[2]]);
    expect(result.successes).toMatchObject([
      { kind: 'finding', index: 0 },
      { kind: 'finding', index: 1 },
    ]);
    expect(result).toMatchObject({ failures: [], remainingFindings: 1 });
  });

  it('batches only selected GitHub findings and the selected review note', async () => {
    const bundlePath = path.join(workingDir, '.revpack', 'bundle.json');
    const bundle = JSON.parse(await fs.readFile(bundlePath, 'utf-8'));
    bundle.target.provider = 'github';
    await fs.writeFile(bundlePath, JSON.stringify(bundle), 'utf-8');
    const findings = [
      {
        oldPath: 'src/app.ts',
        newPath: 'src/app.ts',
        newLine: 2,
        body: 'Selected first',
        severity: 'high',
        category: 'correctness',
      },
      {
        oldPath: 'src/app.ts',
        newPath: 'src/app.ts',
        oldLine: 1,
        newLine: 1,
        body: 'Deferred middle',
        severity: 'medium',
        category: 'testing',
      },
      {
        oldPath: 'src/app.ts',
        newPath: 'src/app.ts',
        newLine: 2,
        body: 'Selected last',
        severity: 'low',
        category: 'architecture',
      },
    ];
    const findingsPath = await writeFindings(findings);
    const notePath = path.join(workingDir, '.revpack', 'outputs', 'note.md');
    await fs.writeFile(notePath, 'Selected review note', 'utf-8');
    const material = await loadPublishMaterial(workingDir);
    const orchestrator = {
      workspace: { appendPublishedAction: vi.fn().mockResolvedValue(true) },
      publishReviewBatch: vi.fn().mockResolvedValue({
        created: true,
        threadIds: ['provider-thread-first', 'provider-thread-last'],
      }),
      publishReview: vi.fn(),
    };

    const result = await executePublishPlan({
      material,
      selection: {
        replyIndexes: [],
        findingIndexes: [0, 2],
        summary: false,
        note: true,
        checkpoint: false,
      },
      orchestrator: orchestrator as never,
      repository: 'group/project',
      refresh: false,
    });

    expect(orchestrator.publishReviewBatch).toHaveBeenCalledTimes(1);
    const [batchedFindings, reviewBody] = orchestrator.publishReviewBatch.mock.calls[0];
    expect(batchedFindings).toHaveLength(2);
    expect(batchedFindings.map((finding: { body: string }) => finding.body)).toEqual([
      expect.stringContaining('Selected first'),
      expect.stringContaining('Selected last'),
    ]);
    expect(reviewBody).toBe('Selected review note');
    expect(orchestrator.publishReview).not.toHaveBeenCalled();
    expect(orchestrator.workspace.appendPublishedAction).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ type: 'finding', providerThreadId: 'provider-thread-first' }),
    );
    expect(orchestrator.workspace.appendPublishedAction).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ type: 'finding', providerThreadId: 'provider-thread-last' }),
    );
    await expect(fs.readFile(findingsPath, 'utf-8').then(JSON.parse)).resolves.toEqual([findings[1]]);
    await expect(fs.access(notePath)).rejects.toThrow();
    expect(result.successes).toMatchObject([
      { kind: 'finding', index: 0 },
      { kind: 'finding', index: 2 },
      { kind: 'note' },
    ]);
    expect(result.remainingFindings).toBe(1);
  });

  it('publishes a GitHub note normally when no findings are selected', async () => {
    const bundlePath = path.join(workingDir, '.revpack', 'bundle.json');
    const bundle = JSON.parse(await fs.readFile(bundlePath, 'utf-8'));
    bundle.target.provider = 'github';
    await fs.writeFile(bundlePath, JSON.stringify(bundle), 'utf-8');
    const notePath = path.join(workingDir, '.revpack', 'outputs', 'note.md');
    await fs.writeFile(notePath, 'Note-only review', 'utf-8');
    const material = await loadPublishMaterial(workingDir);
    const orchestrator = {
      workspace: { appendPublishedAction: vi.fn().mockResolvedValue(true) },
      publishReviewBatch: vi.fn(),
      publishReview: vi.fn().mockResolvedValue({ created: true, noteId: 'note-1' }),
    };

    const result = await executePublishPlan({
      material,
      selection: {
        replyIndexes: [],
        findingIndexes: [],
        summary: false,
        note: true,
        checkpoint: false,
      },
      orchestrator: orchestrator as never,
      repository: 'group/project',
      refresh: false,
    });

    expect(orchestrator.publishReviewBatch).not.toHaveBeenCalled();
    expect(orchestrator.publishReview).toHaveBeenCalledWith('Note-only review', 'group/project');
    await expect(fs.access(notePath)).rejects.toThrow();
    expect(result.successes).toMatchObject([{ kind: 'note' }]);
  });

  it('clears a selected GitHub note even when finding action tracking fails after a successful batch', async () => {
    const bundlePath = path.join(workingDir, '.revpack', 'bundle.json');
    const bundle = JSON.parse(await fs.readFile(bundlePath, 'utf-8'));
    bundle.target.provider = 'github';
    await fs.writeFile(bundlePath, JSON.stringify(bundle), 'utf-8');
    const findingsPath = await writeFindings([
      {
        oldPath: 'src/app.ts',
        newPath: 'src/app.ts',
        newLine: 2,
        body: 'Published finding',
        severity: 'high',
        category: 'correctness',
      },
    ]);
    const notePath = path.join(workingDir, '.revpack', 'outputs', 'note.md');
    await fs.writeFile(notePath, 'Published review note', 'utf-8');
    const material = await loadPublishMaterial(workingDir);
    const orchestrator = {
      workspace: { appendPublishedAction: vi.fn().mockResolvedValue(false) },
      publishReviewBatch: vi.fn().mockResolvedValue({ created: true, threadIds: ['provider-thread-1'] }),
      publishReview: vi.fn(),
    };

    const result = await executePublishPlan({
      material,
      selection: {
        replyIndexes: [],
        findingIndexes: [0],
        summary: false,
        note: true,
        checkpoint: false,
      },
      orchestrator: orchestrator as never,
      repository: 'group/project',
      refresh: false,
    });

    await expect(fs.access(findingsPath)).rejects.toThrow();
    await expect(fs.access(notePath)).rejects.toThrow();
    expect(orchestrator.publishReview).not.toHaveBeenCalled();
    expect(result.failures).toMatchObject([{ kind: 'finding', index: 0 }]);
    expect(result.failures).not.toContainEqual(expect.objectContaining({ kind: 'note' }));
    expect(result.successes).toContainEqual(expect.objectContaining({ kind: 'note' }));
  });

  it('preserves a review note edited while a successful GitHub batch is publishing', async () => {
    const bundlePath = path.join(workingDir, '.revpack', 'bundle.json');
    const bundle = JSON.parse(await fs.readFile(bundlePath, 'utf-8'));
    bundle.target.provider = 'github';
    await fs.writeFile(bundlePath, JSON.stringify(bundle), 'utf-8');
    const findingsPath = await writeFindings([
      {
        oldPath: 'src/app.ts',
        newPath: 'src/app.ts',
        newLine: 2,
        body: 'Published finding',
        severity: 'high',
        category: 'correctness',
      },
    ]);
    const notePath = path.join(workingDir, '.revpack', 'outputs', 'note.md');
    await fs.writeFile(notePath, 'Original selected note', 'utf-8');
    const material = await loadPublishMaterial(workingDir);
    const orchestrator = {
      workspace: { appendPublishedAction: vi.fn().mockResolvedValue(true) },
      publishReviewBatch: vi.fn().mockImplementation(async () => {
        await fs.writeFile(notePath, 'Newer note written during publish', 'utf-8');
        return { created: true, threadIds: ['provider-thread-1'] };
      }),
      publishReview: vi.fn(),
    };

    const result = await executePublishPlan({
      material,
      selection: {
        replyIndexes: [],
        findingIndexes: [0],
        summary: false,
        note: true,
        checkpoint: false,
      },
      orchestrator: orchestrator as never,
      repository: 'group/project',
      refresh: false,
    });

    await expect(fs.access(findingsPath)).rejects.toThrow();
    await expect(fs.readFile(notePath, 'utf-8')).resolves.toBe('Newer note written during publish');
    expect(orchestrator.publishReviewBatch).toHaveBeenCalledTimes(1);
    expect(orchestrator.publishReview).not.toHaveBeenCalled();
    expect(result.failures).toContainEqual(expect.objectContaining({ kind: 'note' }));
    expect(result.successes).not.toContainEqual(expect.objectContaining({ kind: 'note' }));
  });

  it('submits selected GitHub findings with an empty body and preserves an unselected note', async () => {
    const bundlePath = path.join(workingDir, '.revpack', 'bundle.json');
    const bundle = JSON.parse(await fs.readFile(bundlePath, 'utf-8'));
    bundle.target.provider = 'github';
    await fs.writeFile(bundlePath, JSON.stringify(bundle), 'utf-8');
    const findingsPath = await writeFindings([
      {
        oldPath: 'src/app.ts',
        newPath: 'src/app.ts',
        newLine: 2,
        body: 'Selected finding',
        severity: 'high',
        category: 'correctness',
      },
    ]);
    const notePath = path.join(workingDir, '.revpack', 'outputs', 'note.md');
    await fs.writeFile(notePath, 'Deferred review note', 'utf-8');
    const material = await loadPublishMaterial(workingDir);
    const orchestrator = {
      workspace: { appendPublishedAction: vi.fn().mockResolvedValue(true) },
      publishReviewBatch: vi.fn().mockResolvedValue({ created: true }),
      publishReview: vi.fn(),
    };

    await executePublishPlan({
      material,
      selection: {
        replyIndexes: [],
        findingIndexes: [0],
        summary: false,
        note: false,
        checkpoint: false,
      },
      orchestrator: orchestrator as never,
      repository: 'group/project',
      refresh: false,
    });

    expect(orchestrator.publishReviewBatch).toHaveBeenCalledWith(
      [expect.objectContaining({ body: expect.stringContaining('Selected finding') })],
      '',
      'group/project',
    );
    expect(orchestrator.publishReview).not.toHaveBeenCalled();
    await expect(fs.access(findingsPath)).rejects.toThrow();
    await expect(fs.readFile(notePath, 'utf-8')).resolves.toBe('Deferred review note');
  });

  it('publishes and tracks a selected summary through the managed description section', async () => {
    await fs.writeFile(
      path.join(workingDir, '.revpack', 'outputs', 'summary.md'),
      'Complete selected summary',
      'utf-8',
    );
    const material = await loadPublishMaterial(workingDir);
    const orchestrator = {
      workspace: { updateOutputPublishState: vi.fn().mockResolvedValue(true) },
      open: vi.fn().mockResolvedValue({
        provider: 'gitlab',
        description: 'Existing target description',
        diffRefs: { headSha: 'live9876' },
      }),
      updateDescription: vi.fn().mockResolvedValue(undefined),
    };

    const result = await executePublishPlan({
      material,
      selection: {
        replyIndexes: [],
        findingIndexes: [],
        summary: true,
        note: false,
        checkpoint: false,
      },
      orchestrator: orchestrator as never,
      repository: 'group/project',
      refresh: false,
    });

    expect(orchestrator.open).toHaveBeenCalledWith(undefined, 'group/project');
    expect(orchestrator.updateDescription).toHaveBeenCalledWith(
      undefined,
      expect.stringContaining('Complete selected summary'),
      'group/project',
    );
    expect(orchestrator.workspace.updateOutputPublishState).toHaveBeenCalledWith(
      'summary',
      expect.any(String),
      'live9876',
    );
    expect(result.successes).toMatchObject([{ kind: 'summary' }]);
  });

  it('builds the non-interactive all plan from every pending material item', async () => {
    await fs.writeFile(
      path.join(workingDir, '.revpack', 'outputs', 'replies.json'),
      JSON.stringify([{ threadId: 'T-001', body: 'Pending reply', resolve: false }]),
      'utf-8',
    );
    await fs.writeFile(path.join(workingDir, '.revpack', 'outputs', 'summary.md'), 'Pending summary', 'utf-8');
    await fs.writeFile(path.join(workingDir, '.revpack', 'outputs', 'note.md'), 'Pending note', 'utf-8');
    const material = await loadPublishMaterial(workingDir);

    expect(selectAllPublishMaterial(material)).toEqual({
      replyIndexes: [0],
      findingIndexes: [],
      summary: true,
      note: true,
      checkpoint: true,
    });
  });

  it('retains selected GitHub findings and note and blocks checkpoint when the batch fails', async () => {
    const bundlePath = path.join(workingDir, '.revpack', 'bundle.json');
    const bundle = JSON.parse(await fs.readFile(bundlePath, 'utf-8'));
    bundle.target.provider = 'github';
    await fs.writeFile(bundlePath, JSON.stringify(bundle), 'utf-8');
    const findings = [
      {
        oldPath: 'src/app.ts',
        newPath: 'src/app.ts',
        newLine: 2,
        body: 'Batch finding',
        severity: 'high',
        category: 'correctness',
      },
    ];
    const findingsPath = await writeFindings(findings);
    const notePath = path.join(workingDir, '.revpack', 'outputs', 'note.md');
    await fs.writeFile(notePath, 'Batch note', 'utf-8');
    const material = await loadPublishMaterial(workingDir);
    const orchestrator = {
      workspace: { appendPublishedAction: vi.fn().mockResolvedValue(true) },
      publishReviewBatch: vi.fn().mockRejectedValue(new Error('batch rejected')),
      publishCheckpoint: vi.fn(),
      prepare: vi.fn(),
    };

    const result = await executePublishPlan({
      material,
      selection: {
        replyIndexes: [],
        findingIndexes: [0],
        summary: false,
        note: true,
        checkpoint: true,
      },
      orchestrator: orchestrator as never,
      repository: 'group/project',
      refresh: true,
    });

    await expect(fs.readFile(findingsPath, 'utf-8').then(JSON.parse)).resolves.toEqual(findings);
    await expect(fs.readFile(notePath, 'utf-8')).resolves.toBe('Batch note');
    expect(result.failures).toMatchObject([
      { kind: 'finding', index: 0, error: 'batch rejected' },
      { kind: 'note', error: 'batch rejected' },
    ]);
    expect(result).toMatchObject({ checkpoint: 'blocked', refresh: 'skipped', remainingFindings: 1 });
    expect(orchestrator.publishCheckpoint).not.toHaveBeenCalled();
    expect(orchestrator.prepare).not.toHaveBeenCalled();
  });

  it('blocks checkpoint and refresh when the selected summary fails', async () => {
    await fs.writeFile(path.join(workingDir, '.revpack', 'outputs', 'summary.md'), 'Pending summary', 'utf-8');
    const material = await loadPublishMaterial(workingDir);
    const orchestrator = {
      workspace: { updateOutputPublishState: vi.fn() },
      open: vi.fn().mockRejectedValue(new Error('summary unavailable')),
      updateDescription: vi.fn(),
      publishCheckpoint: vi.fn(),
      prepare: vi.fn(),
    };

    const result = await executePublishPlan({
      material,
      selection: {
        replyIndexes: [],
        findingIndexes: [],
        summary: true,
        note: false,
        checkpoint: true,
      },
      orchestrator: orchestrator as never,
      repository: 'group/project',
      refresh: true,
    });

    expect(result.failures).toMatchObject([{ kind: 'summary', error: 'summary unavailable' }]);
    expect(result).toMatchObject({ checkpoint: 'blocked', refresh: 'skipped' });
    expect(orchestrator.publishCheckpoint).not.toHaveBeenCalled();
    expect(orchestrator.prepare).not.toHaveBeenCalled();
  });

  it('keeps a failed selected note and blocks checkpoint and refresh', async () => {
    const notePath = path.join(workingDir, '.revpack', 'outputs', 'note.md');
    await fs.writeFile(notePath, 'Pending review note', 'utf-8');
    const material = await loadPublishMaterial(workingDir);
    const orchestrator = {
      workspace: { appendPublishedAction: vi.fn() },
      publishReview: vi.fn().mockRejectedValue(new Error('note rejected')),
      publishCheckpoint: vi.fn(),
      prepare: vi.fn(),
    };

    const result = await executePublishPlan({
      material,
      selection: {
        replyIndexes: [],
        findingIndexes: [],
        summary: false,
        note: true,
        checkpoint: true,
      },
      orchestrator: orchestrator as never,
      repository: 'group/project',
      refresh: true,
    });

    await expect(fs.readFile(notePath, 'utf-8')).resolves.toBe('Pending review note');
    expect(result.failures).toMatchObject([{ kind: 'note', error: 'note rejected' }]);
    expect(result).toMatchObject({ checkpoint: 'blocked', refresh: 'skipped' });
    expect(orchestrator.publishCheckpoint).not.toHaveBeenCalled();
    expect(orchestrator.prepare).not.toHaveBeenCalled();
  });

  it('removes successful findings but retains failed and deferred findings after partial failure', async () => {
    const findings = [
      {
        oldPath: 'src/app.ts',
        newPath: 'src/app.ts',
        newLine: 2,
        body: 'Fails',
        severity: 'high',
        category: 'correctness',
      },
      {
        oldPath: 'src/app.ts',
        newPath: 'src/app.ts',
        oldLine: 1,
        newLine: 1,
        body: 'Succeeds',
        severity: 'medium',
        category: 'testing',
      },
      {
        oldPath: 'src/app.ts',
        newPath: 'src/app.ts',
        newLine: 2,
        body: 'Deferred',
        severity: 'low',
        category: 'architecture',
      },
    ];
    const findingsPath = await writeFindings(findings);
    const material = await loadPublishMaterial(workingDir);
    const orchestrator = {
      workspace: { appendPublishedAction: vi.fn().mockResolvedValue(true) },
      publishFinding: vi.fn().mockRejectedValueOnce(new Error('finding rejected')).mockResolvedValueOnce('thread-2'),
      publishCheckpoint: vi.fn(),
      prepare: vi.fn(),
    };

    const result = await executePublishPlan({
      material,
      selection: {
        replyIndexes: [],
        findingIndexes: [0, 1],
        summary: false,
        note: false,
        checkpoint: true,
      },
      orchestrator: orchestrator as never,
      repository: 'group/project',
      refresh: true,
    });

    await expect(fs.readFile(findingsPath, 'utf-8').then(JSON.parse)).resolves.toEqual([findings[0], findings[2]]);
    expect(result.failures).toMatchObject([{ kind: 'finding', index: 0, error: 'finding rejected' }]);
    expect(result.successes).toMatchObject([{ kind: 'finding', index: 1 }]);
    expect(result).toMatchObject({ checkpoint: 'blocked', refresh: 'skipped', remainingFindings: 2 });
    expect(orchestrator.publishCheckpoint).not.toHaveBeenCalled();
    expect(orchestrator.prepare).not.toHaveBeenCalled();
  });

  it('reports refresh failure separately after successful provider publication', async () => {
    const repliesPath = path.join(workingDir, '.revpack', 'outputs', 'replies.json');
    await fs.writeFile(
      repliesPath,
      JSON.stringify([{ threadId: 'T-001', body: 'Published reply', resolve: false }]),
      'utf-8',
    );
    const material = await loadPublishMaterial(workingDir);
    const orchestrator = {
      workspace: { appendPublishedAction: vi.fn().mockResolvedValue(true) },
      publishReply: vi.fn().mockResolvedValue(undefined),
      prepare: vi.fn().mockRejectedValue(new Error('refresh unavailable')),
    };

    const result = await executePublishPlan({
      material,
      selection: {
        replyIndexes: [0],
        findingIndexes: [],
        summary: false,
        note: false,
        checkpoint: false,
      },
      orchestrator: orchestrator as never,
      repository: 'group/project',
      refresh: true,
    });

    await expect(fs.access(repliesPath)).rejects.toThrow();
    expect(result.successes).toMatchObject([{ kind: 'reply', index: 0 }]);
    expect(result).toMatchObject({ failures: [], refresh: 'failed', refreshError: 'refresh unavailable' });
  });

  it('blocks checkpoint when queue cleanup fails after a provider action succeeds', async () => {
    const repliesPath = path.join(workingDir, '.revpack', 'outputs', 'replies.json');
    await fs.writeFile(
      repliesPath,
      JSON.stringify([{ threadId: 'T-001', body: 'Provider accepts this', resolve: false }]),
      'utf-8',
    );
    const material = await loadPublishMaterial(workingDir);
    const orchestrator = {
      workspace: { appendPublishedAction: vi.fn() },
      publishReply: vi.fn().mockImplementation(async () => {
        await fs.rm(repliesPath);
        await fs.mkdir(repliesPath);
      }),
      publishCheckpoint: vi.fn(),
    };

    const result = await executePublishPlan({
      material,
      selection: {
        replyIndexes: [0],
        findingIndexes: [],
        summary: false,
        note: false,
        checkpoint: true,
      },
      orchestrator: orchestrator as never,
      repository: 'group/project',
      refresh: false,
    });

    expect(orchestrator.publishReply).toHaveBeenCalledTimes(1);
    expect(result.failures).toMatchObject([{ kind: 'reply', index: 0 }]);
    expect(result).toMatchObject({ checkpoint: 'blocked', remainingReplies: 1 });
    expect(orchestrator.publishCheckpoint).not.toHaveBeenCalled();
  });
});
