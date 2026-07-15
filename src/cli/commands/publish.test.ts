import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Command } from 'commander';
import { __testing, registerPublishCommand } from './publish.js';
import { createOrchestrator, getRepoFromGit, handleError } from '../helpers.js';
import { computeContentHash } from '../../workspace/thread-digest.js';
import { loadPublishMaterial } from '../../workspace/publish-material.js';

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
          prepare: {
            checkpoint: null,
            comparison: {
              targetCodeChangedSinceCheckpoint: null,
              threadsChangedSinceCheckpoint: null,
              descriptionChangedSinceCheckpoint: null,
            },
          },
          outputs: {
            review: { path: '.revpack/outputs/note.md' },
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

  function makeTerminal(interactive = true) {
    return {
      interactive,
      dimensions: () => ({ columns: 120, rows: 40 }),
      start: vi.fn(),
      stop: vi.fn(),
      readKey: vi.fn(),
      writeFrame: vi.fn(),
    };
  }

  it('presents bare publish as guided while retaining every automation-friendly subcommand', () => {
    const program = new Command();
    registerPublishCommand(program);
    const publish = program.commands.find((command) => command.name() === 'publish');

    expect(publish?.description()).toContain('Preview and select');
    expect(publish?.options.map((option) => option.long)).toContain('--no-refresh');
    expect(publish?.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(['all', 'replies', 'findings', 'summary', 'description', 'note', 'review', 'checkpoint']),
    );
  });

  it('routes bare publish through the interactive TTY guard', async () => {
    const program = new Command();
    registerPublishCommand(program);

    await program.parseAsync(['publish'], { from: 'user' });

    expect(handleError).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          'Interactive publishing requires a terminal.\n' +
          'Use `revpack publish all` or a specific `revpack publish <command>` in scripts.',
      }),
    );
    expect(createOrchestrator).not.toHaveBeenCalled();
  });

  it('matches T-NNN reply refs case-insensitively', () => {
    const entries = [{ threadId: 'T-001', body: 'reply', resolve: false }];

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

  it('treats a missing default replies queue as empty', async () => {
    await expect(__testing.publishReplies({})).resolves.toBe(0);
    expect(createOrchestrator).toHaveBeenCalledTimes(1);
  });

  it('rejects a missing custom replies queue path', async () => {
    const repliesPath = path.join(tmpDir, 'missing-replies.json');

    await expect(__testing.publishReplies({ from: repliesPath })).rejects.toThrow('No replies file found');
  });

  it('keeps explicit custom reply files compatible when resolve is omitted', async () => {
    const repliesPath = path.join(tmpDir, 'replies.json');
    await fs.writeFile(
      repliesPath,
      JSON.stringify([{ threadId: 'T-001', body: 'Leave the thread unresolved' }]),
      'utf-8',
    );
    const orchestrator = {
      publishReply: vi.fn().mockResolvedValue(undefined),
      resolveThread: vi.fn(),
    };
    vi.mocked(createOrchestrator).mockResolvedValue(orchestrator as never);

    await expect(__testing.publishReplies({ from: repliesPath })).resolves.toBe(1);
    expect(orchestrator.publishReply).toHaveBeenCalledWith(
      undefined,
      'T-001',
      'Leave the thread unresolved',
      'group/project',
    );
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

  it('treats a missing default findings queue as empty', async () => {
    await expect(__testing.publishFindings({})).resolves.toBe(0);
    expect(createOrchestrator).not.toHaveBeenCalled();
  });

  it('rejects a missing custom findings queue path', async () => {
    const findingsPath = path.join(tmpDir, 'missing-findings.json');

    await expect(__testing.publishFindings({ from: findingsPath })).rejects.toThrow('No findings file found');
  });

  it('treats empty review notes from any source path as no review note to publish', () => {
    expect(__testing.isNoReviewNoteToPublishError(new Error('note.md is empty'))).toBe(true);
    expect(__testing.isNoReviewNoteToPublishError(new Error('custom-note.md is empty; nothing to publish'))).toBe(true);
    expect(__testing.isNoReviewNoteToPublishError(new Error('custom-note.md is empty'))).toBe(true);
    expect(__testing.isNoReviewNoteToPublishError(new Error('custom-note.md is missing'))).toBe(false);
  });

  it('allows publish all to skip an empty default review note', async () => {
    await fs.mkdir(path.join(tmpDir, '.revpack', 'outputs'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, '.revpack', 'outputs', 'note.md'), ' \n\t', 'utf-8');

    await expect(__testing.publishReviewCmd({ allowEmpty: true })).resolves.toBe(0);
    expect(createOrchestrator).not.toHaveBeenCalled();
  });

  it('keeps explicit review publishing strict for empty review notes', async () => {
    await fs.mkdir(path.join(tmpDir, '.revpack', 'outputs'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, '.revpack', 'outputs', 'note.md'), ' \n\t', 'utf-8');

    await expect(__testing.publishReviewCmd({})).rejects.toThrow('note.md is empty');
    expect(createOrchestrator).not.toHaveBeenCalled();
  });

  it('removes the default review note after publishing it', async () => {
    await fs.mkdir(path.join(tmpDir, '.revpack', 'outputs'), { recursive: true });
    await writeBundleState();
    const reviewPath = path.join(tmpDir, '.revpack', 'outputs', 'note.md');
    await fs.writeFile(reviewPath, 'Review body', 'utf-8');

    const orchestrator = {
      publishReview: vi.fn().mockResolvedValue({ created: true, noteId: 'note-1' }),
    };
    vi.mocked(createOrchestrator).mockResolvedValue(orchestrator as never);

    await expect(__testing.publishReviewCmd({})).resolves.toBe(1);

    await expect(fs.access(reviewPath)).rejects.toThrow();
    const bundleState = JSON.parse(await fs.readFile(path.join(tmpDir, '.revpack', 'bundle.json'), 'utf-8'));
    expect(bundleState.outputs.review.lastPublishedHash).toBeUndefined();
  });

  it('removes the default review note even when bundle state is unavailable', async () => {
    await fs.mkdir(path.join(tmpDir, '.revpack', 'outputs'), { recursive: true });
    const reviewPath = path.join(tmpDir, '.revpack', 'outputs', 'note.md');
    await fs.writeFile(reviewPath, 'Review body', 'utf-8');

    const orchestrator = {
      publishReview: vi.fn().mockResolvedValue({ created: true, noteId: 'note-1' }),
    };
    vi.mocked(createOrchestrator).mockResolvedValue(orchestrator as never);

    await expect(__testing.publishReviewCmd({})).resolves.toBe(1);

    await expect(fs.access(reviewPath)).rejects.toThrow();
  });

  it('keeps the default review note when no review note is created', async () => {
    await fs.mkdir(path.join(tmpDir, '.revpack', 'outputs'), { recursive: true });
    await writeBundleState();
    const reviewPath = path.join(tmpDir, '.revpack', 'outputs', 'note.md');
    await fs.writeFile(reviewPath, 'Review body', 'utf-8');

    const orchestrator = {
      publishReview: vi.fn().mockResolvedValue({ created: false }),
    };
    vi.mocked(createOrchestrator).mockResolvedValue(orchestrator as never);

    await expect(__testing.publishReviewCmd({})).resolves.toBe(0);

    await expect(fs.readFile(reviewPath, 'utf-8')).resolves.toBe('Review body');
    const bundleState = JSON.parse(await fs.readFile(path.join(tmpDir, '.revpack', 'bundle.json'), 'utf-8'));
    expect(bundleState.outputs.review.lastPublishedHash).toBeUndefined();
  });

  it('does not clear the default review note when publishing from a custom file', async () => {
    await fs.mkdir(path.join(tmpDir, '.revpack', 'outputs'), { recursive: true });
    await writeBundleState();
    const reviewPath = path.join(tmpDir, '.revpack', 'outputs', 'note.md');
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

  it('does not publish review.md when note.md is absent', async () => {
    await fs.mkdir(path.join(tmpDir, '.revpack', 'outputs'), { recursive: true });
    await writeBundleState();
    const legacyPath = path.join(tmpDir, '.revpack', 'outputs', 'review.md');
    await fs.writeFile(legacyPath, 'Legacy review body', 'utf-8');

    await expect(__testing.publishReviewCmd({})).rejects.toThrow('.revpack/outputs/note.md is empty');
    expect(createOrchestrator).not.toHaveBeenCalled();
    await expect(fs.readFile(legacyPath, 'utf-8')).resolves.toBe('Legacy review body');
  });

  it('rejects guided publishing without interactive input and output', () => {
    expect(() => __testing.requireInteractiveTerminal({ interactive: false })).toThrow(
      'Interactive publishing requires a terminal.\n' +
        'Use `revpack publish all` or a specific `revpack publish <command>` in scripts.',
    );
  });

  it('checks terminal interactivity before reading the active bundle', async () => {
    const loadMaterial = vi.fn();

    await expect(
      __testing.guidedPublish(
        {},
        {
          terminal: makeTerminal(false),
          loadMaterial,
        },
      ),
    ).rejects.toThrow('Interactive publishing requires a terminal.');
    expect(loadMaterial).not.toHaveBeenCalled();
  });

  it('classifies matching and changed target heads without treating errors as current', async () => {
    const orchestrator = {
      open: vi
        .fn()
        .mockResolvedValueOnce({ diffRefs: { headSha: 'abcdef123456' } })
        .mockResolvedValueOnce({ diffRefs: { headSha: 'fedcba654321' } }),
    };

    await expect(
      __testing.determineBundleFreshness(orchestrator as never, 'group/project', 'abcdef123456'),
    ).resolves.toBe('current');
    await expect(
      __testing.determineBundleFreshness(orchestrator as never, 'group/project', 'abcdef123456'),
    ).resolves.toBe('stale');
  });

  it('blocks guided publishing when freshness cannot be determined', async () => {
    const orchestrator = { open: vi.fn().mockRejectedValue(new Error('provider unavailable')) };

    await expect(
      __testing.determineBundleFreshness(orchestrator as never, 'group/project', 'head-sha'),
    ).rejects.toThrow('Could not determine whether the active review bundle is current. Nothing was published.');
  });

  it('blocks guided publishing when the provider returns no current target head', async () => {
    const orchestrator = { open: vi.fn().mockResolvedValue({ diffRefs: { headSha: '' } }) };

    await expect(
      __testing.determineBundleFreshness(orchestrator as never, 'group/project', 'head-sha'),
    ).rejects.toThrow('Could not determine the current review-target head. Nothing was published.');
  });

  it('builds the complete selector model with stable queue indexes and document content', async () => {
    await writeBundleState('gitlab');
    await writeValidFindingBundle();
    const outputsDir = path.join(tmpDir, '.revpack', 'outputs');
    await fs.writeFile(
      path.join(outputsDir, 'replies.json'),
      JSON.stringify([{ threadId: 'T-001', body: 'Complete reply', resolve: true }]),
      'utf-8',
    );
    await fs.writeFile(path.join(outputsDir, 'summary.md'), 'Complete summary', 'utf-8');
    await fs.writeFile(path.join(outputsDir, 'note.md'), 'Complete note', 'utf-8');

    const model = __testing.toGuidedPublishModel(await loadPublishMaterial(tmpDir));

    expect(model).toMatchObject({
      provider: 'gitlab',
      findings: [{ index: 0, value: expect.objectContaining({ body: 'Audit call can throw unexpectedly.' }) }],
      replies: [{ index: 0, value: { threadId: 'T-001', body: 'Complete reply', resolve: true } }],
      summary: { state: 'pending', content: 'Complete summary' },
      note: { content: 'Complete note' },
      checkpoint: { state: 'none', targetHeadSha: 'head-sha' },
    });
    expect(model.findingContexts.get(0)).toContain('audit(value); ◀');
  });

  it('opens the selector when any one publish category is pending and skips only the fully current state', async () => {
    await writeBundleState('gitlab');
    const bundlePath = path.join(tmpDir, '.revpack', 'bundle.json');
    const bundle = JSON.parse(await fs.readFile(bundlePath, 'utf-8'));
    bundle.prepare.checkpoint = { headSha: 'head-sha' };
    bundle.prepare.comparison = {
      targetCodeChangedSinceCheckpoint: false,
      threadsChangedSinceCheckpoint: false,
      descriptionChangedSinceCheckpoint: false,
    };
    await fs.writeFile(bundlePath, JSON.stringify(bundle), 'utf-8');
    const current = await loadPublishMaterial(tmpDir);

    expect(__testing.hasSelectablePublishMaterial(current)).toBe(false);
    const pendingVariants = [
      { ...current, findings: [{ index: 0, value: {}, raw: {} }] },
      { ...current, replies: [{ index: 0, value: {}, raw: {} }] },
      { ...current, summary: { ...current.summary, state: 'pending' as const } },
      { ...current, summary: { ...current.summary, state: 'modified since publish' as const } },
      { ...current, note: { ...current.note, state: 'pending' as const } },
      { ...current, checkpointState: 'outdated' as const },
    ];
    for (const material of pendingVariants) {
      expect(__testing.hasSelectablePublishMaterial(material as never)).toBe(true);
    }
  });

  it('reports successful publications, retained drafts, and refresh failure without treating publication as failed', () => {
    expect(() =>
      __testing.reportPublishResult({
        successes: [{ kind: 'reply', index: 1, label: 'T-002' }],
        failures: [],
        remainingReplies: 1,
        remainingFindings: 2,
        checkpoint: 'skipped',
        refresh: 'failed',
        refreshError: 'provider temporarily unavailable',
      }),
    ).not.toThrow();

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('1 item(s) published: T-002'));
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('3 draft(s) remain (2 finding(s), 1 reply/replies).'),
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Publishing succeeded, but the review bundle could not be refreshed'),
    );
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('provider temporarily unavailable'));
  });

  it('does not print a refresh-failure warning when refresh was intentionally skipped', () => {
    __testing.reportPublishResult({
      successes: [{ kind: 'reply', index: 0, label: 'T-001' }],
      failures: [],
      remainingReplies: 0,
      remainingFindings: 0,
      checkpoint: 'skipped',
      refresh: 'skipped',
    });

    expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining('review bundle could not be refreshed'));
  });

  it('strictly validates queues before creating a provider or opening the selector', async () => {
    await writeBundleState('gitlab');
    await fs.mkdir(path.join(tmpDir, '.revpack', 'outputs'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, '.revpack', 'outputs', 'replies.json'), '[{}]', 'utf-8');
    const runSelector = vi.fn();

    await expect(
      __testing.guidedPublish(
        { refresh: false },
        {
          terminal: makeTerminal(),
          runSelector,
        },
      ),
    ).rejects.toThrow('schema-invalid replies');
    expect(createOrchestrator).not.toHaveBeenCalled();
    expect(runSelector).not.toHaveBeenCalled();
  });

  it('blocks guided publishing when no repository can be determined', async () => {
    await writeBundleState('gitlab');
    const orchestrator = { publishReply: vi.fn() };

    await expect(
      __testing.guidedPublish(
        { refresh: false },
        {
          terminal: makeTerminal(),
          createOrchestrator: vi.fn().mockResolvedValue(orchestrator),
          getRepository: vi.fn().mockResolvedValue(undefined),
          runSelector: vi.fn(),
        },
      ),
    ).rejects.toThrow('Could not determine the repository for publishing.');

    expect(orchestrator.publishReply).not.toHaveBeenCalled();
  });

  it('offers only cancellation or refresh for a stale bundle and cancellation preserves drafts', async () => {
    await writeBundleState('gitlab');
    await fs.mkdir(path.join(tmpDir, '.revpack', 'outputs'), { recursive: true });
    const repliesPath = path.join(tmpDir, '.revpack', 'outputs', 'replies.json');
    const replies = [{ threadId: 'T-001', body: 'Keep this draft', resolve: false }];
    await fs.writeFile(repliesPath, JSON.stringify(replies), 'utf-8');
    const orchestrator = {
      open: vi.fn().mockResolvedValue({ diffRefs: { headSha: 'different-head' } }),
      prepare: vi.fn(),
    };
    const runStalePrompt = vi.fn().mockResolvedValue('cancel');
    const runSelector = vi.fn();

    await __testing.guidedPublish(
      { refresh: false },
      {
        terminal: makeTerminal(),
        createOrchestrator: vi.fn().mockResolvedValue(orchestrator),
        getRepository: vi.fn().mockResolvedValue('group/project'),
        runStalePrompt,
        runSelector,
      },
    );

    expect(runStalePrompt).toHaveBeenCalledTimes(1);
    expect(runSelector).not.toHaveBeenCalled();
    expect(orchestrator.prepare).not.toHaveBeenCalled();
    await expect(fs.readFile(repliesPath, 'utf-8').then(JSON.parse)).resolves.toEqual(replies);
  });

  it('refreshes a stale bundle with pending drafts preserved, then rebuilds the selector model', async () => {
    await writeBundleState('gitlab');
    await fs.mkdir(path.join(tmpDir, '.revpack', 'outputs'), { recursive: true });
    const repliesPath = path.join(tmpDir, '.revpack', 'outputs', 'replies.json');
    const replies = [{ threadId: 'T-001', body: 'Preserved draft', resolve: false }];
    await fs.writeFile(repliesPath, JSON.stringify(replies), 'utf-8');
    const bundlePath = path.join(tmpDir, '.revpack', 'bundle.json');
    const orchestrator = {
      open: vi.fn().mockResolvedValue({ diffRefs: { headSha: 'refreshed-head' } }),
      prepare: vi.fn().mockImplementation(async () => {
        const bundle = JSON.parse(await fs.readFile(bundlePath, 'utf-8'));
        bundle.target.diffRefs.headSha = 'refreshed-head';
        await fs.writeFile(bundlePath, JSON.stringify(bundle), 'utf-8');
      }),
    };
    const runSelector = vi.fn().mockResolvedValue(null);

    await __testing.guidedPublish(
      { refresh: false },
      {
        terminal: makeTerminal(),
        createOrchestrator: vi.fn().mockResolvedValue(orchestrator),
        getRepository: vi.fn().mockResolvedValue('group/project'),
        runStalePrompt: vi.fn().mockResolvedValue('refresh'),
        runSelector,
      },
    );

    expect(orchestrator.prepare).toHaveBeenCalledWith(undefined, 'group/project', {
      preservePendingOutputs: true,
    });
    expect(orchestrator.open).toHaveBeenCalledTimes(2);
    expect(runSelector).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ index: 0, value: expect.objectContaining({ body: 'Preserved draft' }) })],
        checkpoint: expect.objectContaining({ targetHeadSha: 'refreshed-head' }),
      }),
      expect.any(Object),
    );
    await expect(fs.readFile(repliesPath, 'utf-8').then(JSON.parse)).resolves.toEqual(replies);
  });

  it('rechecks freshness after confirmation and refuses to publish a newly stale selection', async () => {
    await writeBundleState('gitlab');
    await fs.mkdir(path.join(tmpDir, '.revpack', 'outputs'), { recursive: true });
    const repliesPath = path.join(tmpDir, '.revpack', 'outputs', 'replies.json');
    const replies = [{ threadId: 'T-001', body: 'Do not publish stale context', resolve: false }];
    await fs.writeFile(repliesPath, JSON.stringify(replies), 'utf-8');
    const orchestrator = {
      open: vi
        .fn()
        .mockResolvedValueOnce({ diffRefs: { headSha: 'head-sha' } })
        .mockResolvedValueOnce({ diffRefs: { headSha: 'advanced-head' } }),
      prepare: vi.fn(),
      workspace: { appendPublishedAction: vi.fn().mockResolvedValue(true) },
      publishReply: vi.fn().mockResolvedValue(undefined),
    };
    const runStalePrompt = vi.fn().mockResolvedValue('cancel');

    await __testing.guidedPublish(
      { refresh: false },
      {
        terminal: makeTerminal(),
        createOrchestrator: vi.fn().mockResolvedValue(orchestrator),
        getRepository: vi.fn().mockResolvedValue('group/project'),
        runSelector: vi.fn().mockResolvedValue({
          replyIndexes: [0],
          findingIndexes: [],
          summary: false,
          note: false,
          checkpoint: false,
        }),
        runStalePrompt,
      },
    );

    expect(orchestrator.open).toHaveBeenCalledTimes(2);
    expect(runStalePrompt).toHaveBeenCalledTimes(1);
    expect(orchestrator.publishReply).not.toHaveBeenCalled();
    await expect(fs.readFile(repliesPath, 'utf-8').then(JSON.parse)).resolves.toEqual(replies);
  });

  it('discards a stale confirmed selection and rebuilds the selector after refresh', async () => {
    await writeBundleState('gitlab');
    await fs.mkdir(path.join(tmpDir, '.revpack', 'outputs'), { recursive: true });
    const repliesPath = path.join(tmpDir, '.revpack', 'outputs', 'replies.json');
    await fs.writeFile(
      repliesPath,
      JSON.stringify([{ threadId: 'T-001', body: 'Reconfirm after refresh', resolve: false }]),
      'utf-8',
    );
    const bundlePath = path.join(tmpDir, '.revpack', 'bundle.json');
    const orchestrator = {
      open: vi
        .fn()
        .mockResolvedValueOnce({ diffRefs: { headSha: 'head-sha' } })
        .mockResolvedValue({ diffRefs: { headSha: 'advanced-head' } }),
      prepare: vi.fn().mockImplementation(async () => {
        const bundle = JSON.parse(await fs.readFile(bundlePath, 'utf-8'));
        bundle.target.diffRefs.headSha = 'advanced-head';
        await fs.writeFile(bundlePath, JSON.stringify(bundle), 'utf-8');
      }),
      workspace: { appendPublishedAction: vi.fn().mockResolvedValue(true) },
      publishReply: vi.fn(),
    };
    const runSelector = vi
      .fn()
      .mockResolvedValueOnce({
        replyIndexes: [0],
        findingIndexes: [],
        summary: false,
        note: false,
        checkpoint: false,
      })
      .mockResolvedValueOnce(null);

    await __testing.guidedPublish(
      { refresh: false },
      {
        terminal: makeTerminal(),
        createOrchestrator: vi.fn().mockResolvedValue(orchestrator),
        getRepository: vi.fn().mockResolvedValue('group/project'),
        runSelector,
        runStalePrompt: vi.fn().mockResolvedValue('refresh'),
      },
    );

    expect(orchestrator.prepare).toHaveBeenCalledWith(undefined, 'group/project', {
      preservePendingOutputs: true,
    });
    expect(runSelector).toHaveBeenCalledTimes(2);
    expect(runSelector.mock.calls[1][0]).toMatchObject({
      checkpoint: { targetHeadSha: 'advanced-head' },
      replies: [expect.objectContaining({ index: 0 })],
    });
    expect(orchestrator.publishReply).not.toHaveBeenCalled();
    await expect(fs.readFile(repliesPath, 'utf-8').then(JSON.parse)).resolves.toHaveLength(1);
  });

  it('surfaces stale refresh failure without changing pending drafts', async () => {
    await writeBundleState('gitlab');
    await fs.mkdir(path.join(tmpDir, '.revpack', 'outputs'), { recursive: true });
    const repliesPath = path.join(tmpDir, '.revpack', 'outputs', 'replies.json');
    const replies = [{ threadId: 'T-001', body: 'Still pending', resolve: false }];
    await fs.writeFile(repliesPath, JSON.stringify(replies), 'utf-8');
    const orchestrator = {
      open: vi.fn().mockResolvedValue({ diffRefs: { headSha: 'different-head' } }),
      prepare: vi.fn().mockRejectedValue(new Error('working tree is behind target')),
    };
    const runSelector = vi.fn();

    await expect(
      __testing.guidedPublish(
        { refresh: false },
        {
          terminal: makeTerminal(),
          createOrchestrator: vi.fn().mockResolvedValue(orchestrator as never),
          getRepository: vi.fn().mockResolvedValue('group/project'),
          runStalePrompt: vi.fn().mockResolvedValue('refresh'),
          runSelector,
        },
      ),
    ).rejects.toThrow('Could not refresh the stale review bundle. Pending drafts were left unchanged.');

    expect(runSelector).not.toHaveBeenCalled();
    await expect(fs.readFile(repliesPath, 'utf-8').then(JSON.parse)).resolves.toEqual(replies);
  });

  it('does not write draft queues when the current-bundle selector is cancelled', async () => {
    await writeBundleState('gitlab');
    await fs.mkdir(path.join(tmpDir, '.revpack', 'outputs'), { recursive: true });
    const repliesPath = path.join(tmpDir, '.revpack', 'outputs', 'replies.json');
    const original = '[ { "threadId": "T-001", "body": "Cancel me", "resolve": false } ]\n';
    await fs.writeFile(repliesPath, original, 'utf-8');
    const orchestrator = {
      open: vi.fn().mockResolvedValue({ diffRefs: { headSha: 'head-sha' } }),
      publishReply: vi.fn(),
    };

    await __testing.guidedPublish(
      { refresh: false },
      {
        terminal: makeTerminal(),
        createOrchestrator: vi.fn().mockResolvedValue(orchestrator),
        getRepository: vi.fn().mockResolvedValue('group/project'),
        runSelector: vi.fn().mockResolvedValue(null),
      },
    );

    expect(orchestrator.publishReply).not.toHaveBeenCalled();
    await expect(fs.readFile(repliesPath, 'utf-8')).resolves.toBe(original);
  });

  it('hands an accepted guided selection to the shared executor without refreshing when disabled', async () => {
    await writeBundleState('gitlab');
    await fs.mkdir(path.join(tmpDir, '.revpack', 'outputs'), { recursive: true });
    const repliesPath = path.join(tmpDir, '.revpack', 'outputs', 'replies.json');
    await fs.writeFile(
      repliesPath,
      JSON.stringify([{ threadId: 'T-001', body: 'Confirmed reply', resolve: false }]),
      'utf-8',
    );
    const orchestrator = {
      open: vi.fn().mockResolvedValue({ diffRefs: { headSha: 'head-sha' } }),
      workspace: { appendPublishedAction: vi.fn().mockResolvedValue(true) },
      publishReply: vi.fn().mockResolvedValue(undefined),
      prepare: vi.fn(),
    };

    await __testing.guidedPublish(
      { refresh: false },
      {
        terminal: makeTerminal(),
        createOrchestrator: vi.fn().mockResolvedValue(orchestrator),
        getRepository: vi.fn().mockResolvedValue('group/project'),
        runSelector: vi.fn().mockResolvedValue({
          replyIndexes: [0],
          findingIndexes: [],
          summary: false,
          note: false,
          checkpoint: false,
        }),
      },
    );

    expect(orchestrator.open).toHaveBeenCalledTimes(2);
    expect(orchestrator.publishReply).toHaveBeenCalledWith(undefined, 'T-001', 'Confirmed reply', 'group/project');
    expect(orchestrator.prepare).not.toHaveBeenCalled();
    await expect(fs.access(repliesPath)).rejects.toThrow();
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('Publishing cancelled'));
  });

  it('refreshes by default after an accepted guided selection', async () => {
    await writeBundleState('gitlab');
    await fs.mkdir(path.join(tmpDir, '.revpack', 'outputs'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, '.revpack', 'outputs', 'replies.json'),
      JSON.stringify([{ threadId: 'T-001', body: 'Confirmed reply', resolve: false }]),
      'utf-8',
    );
    const orchestrator = {
      open: vi.fn().mockResolvedValue({ diffRefs: { headSha: 'head-sha' } }),
      workspace: { appendPublishedAction: vi.fn().mockResolvedValue(true) },
      publishReply: vi.fn().mockResolvedValue(undefined),
      prepare: vi.fn().mockResolvedValue(undefined),
    };

    await __testing.guidedPublish(undefined, {
      terminal: makeTerminal(),
      createOrchestrator: vi.fn().mockResolvedValue(orchestrator),
      getRepository: vi.fn().mockResolvedValue('group/project'),
      runSelector: vi.fn().mockResolvedValue({
        replyIndexes: [0],
        findingIndexes: [],
        summary: false,
        note: false,
        checkpoint: false,
      }),
    });

    expect(orchestrator.prepare).toHaveBeenCalledWith(undefined, 'group/project', {
      preservePendingOutputs: true,
    });
  });

  it('exits without opening the selector when no material is pending and the checkpoint is current', async () => {
    await writeBundleState('gitlab');
    const bundlePath = path.join(tmpDir, '.revpack', 'bundle.json');
    const bundle = JSON.parse(await fs.readFile(bundlePath, 'utf-8'));
    bundle.prepare.checkpoint = { headSha: 'head-sha' };
    bundle.prepare.comparison = {
      targetCodeChangedSinceCheckpoint: false,
      threadsChangedSinceCheckpoint: false,
      descriptionChangedSinceCheckpoint: false,
    };
    await fs.writeFile(bundlePath, JSON.stringify(bundle), 'utf-8');
    const runSelector = vi.fn();

    await __testing.guidedPublish(
      { refresh: false },
      {
        terminal: makeTerminal(),
        createOrchestrator: vi.fn().mockResolvedValue({
          open: vi.fn().mockResolvedValue({ diffRefs: { headSha: 'head-sha' } }),
        }),
        getRepository: vi.fn().mockResolvedValue('group/project'),
        runSelector,
      },
    );

    expect(runSelector).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('checkpoint is current'));
  });

  it('removes the default review note after including it in a GitHub review batch', async () => {
    await writeBundleState('github');
    await writeValidFindingBundle();
    const reviewPath = path.join(tmpDir, '.revpack', 'outputs', 'note.md');
    await fs.writeFile(reviewPath, 'Batch review body', 'utf-8');

    const orchestrator = {
      publishReviewBatch: vi.fn().mockResolvedValue({ created: true }),
    };
    vi.mocked(createOrchestrator).mockResolvedValue(orchestrator as never);

    await expect(__testing.publishFindingsAndReviewBatch('Batch review body')).resolves.toBe(1);

    await expect(fs.access(reviewPath)).rejects.toThrow();
    await expect(fs.access(path.join(tmpDir, '.revpack', 'outputs', 'new-findings.json'))).rejects.toThrow();
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

  it('uses markdown heading summary markers for Bitbucket Cloud descriptions', async () => {
    await fs.mkdir(path.join(tmpDir, '.revpack', 'outputs'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, '.revpack', 'outputs', 'summary.md'), 'Generated summary', 'utf-8');

    const orchestrator = {
      open: vi.fn().mockResolvedValue({ provider: 'bitbucket-cloud', description: 'Existing description' }),
      updateDescription: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(createOrchestrator).mockResolvedValue(orchestrator as never);

    await expect(__testing.publishDescription({})).resolves.toBe(1);

    expect(orchestrator.updateDescription).toHaveBeenCalledWith(
      undefined,
      expect.stringContaining('###### revpack:summary\nGenerated summary\n###### revpack:end'),
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

  it('replaces the description from the default summary even when it is already published', async () => {
    const summary = 'Generated summary';
    await writeBundleState('gitlab', { summaryHash: computeContentHash(summary) });
    await fs.mkdir(path.join(tmpDir, '.revpack', 'outputs'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, '.revpack', 'outputs', 'summary.md'), summary, 'utf-8');

    const orchestrator = {
      open: vi.fn(),
      updateDescription: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(createOrchestrator).mockResolvedValue(orchestrator as never);

    await expect(__testing.publishDescription({ replace: true })).resolves.toBe(1);

    expect(orchestrator.open).not.toHaveBeenCalled();
    expect(orchestrator.updateDescription).toHaveBeenCalledWith(undefined, summary, 'group/project');
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
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Bundle refreshed.'));
  });

  it('publishes all Bitbucket outputs through individual non-GitHub operations', async () => {
    await writeBundleState('bitbucket-cloud');
    await writeValidFindingBundle();
    await fs.writeFile(
      path.join(tmpDir, '.revpack', 'outputs', 'replies.json'),
      JSON.stringify([{ threadId: '100', body: 'Reply body', resolve: false }]),
      'utf-8',
    );
    await fs.writeFile(path.join(tmpDir, '.revpack', 'outputs', 'summary.md'), 'Generated summary', 'utf-8');
    await fs.writeFile(path.join(tmpDir, '.revpack', 'outputs', 'note.md'), 'Review note', 'utf-8');

    const orchestrator = {
      workspace: {
        appendPublishedAction: vi.fn().mockResolvedValue(true),
        updateOutputPublishState: vi.fn().mockResolvedValue(true),
      },
      publishReply: vi.fn().mockResolvedValue(undefined),
      publishFinding: vi.fn().mockResolvedValue('finding-1'),
      publishReviewBatch: vi.fn().mockResolvedValue({ created: true }),
      open: vi.fn().mockResolvedValue({
        description: 'Existing description',
        diffRefs: { headSha: 'live-head-sha' },
      }),
      updateDescription: vi.fn().mockResolvedValue(undefined),
      publishReview: vi.fn().mockResolvedValue({ created: true, noteId: 'note-1' }),
      publishCheckpoint: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(createOrchestrator).mockResolvedValue(orchestrator as never);

    await expect(__testing.publishAllPending({ refresh: false })).resolves.toBeUndefined();

    expect(orchestrator.publishReply).toHaveBeenCalledWith(undefined, '100', 'Reply body', 'group/project');
    expect(orchestrator.publishFinding).toHaveBeenCalledTimes(1);
    expect(orchestrator.publishReviewBatch).not.toHaveBeenCalled();
    expect(orchestrator.updateDescription).toHaveBeenCalledWith(
      undefined,
      expect.stringContaining('Generated summary'),
      'group/project',
    );
    expect(orchestrator.publishReview).toHaveBeenCalledWith('Review note', 'group/project');
    expect(orchestrator.publishCheckpoint).toHaveBeenCalledWith('group/project');
  });

  it('warns about partial success when publish all fails after a Bitbucket reply succeeds', async () => {
    await writeBundleState('bitbucket-cloud');
    await fs.mkdir(path.join(tmpDir, '.revpack', 'outputs'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, '.revpack', 'outputs', 'replies.json'),
      JSON.stringify([{ threadId: '100', body: 'Reply body', resolve: false }]),
      'utf-8',
    );

    const orchestrator = {
      workspace: { appendPublishedAction: vi.fn().mockResolvedValue(true) },
      publishReply: vi.fn().mockResolvedValue(undefined),
      publishFinding: vi.fn(),
      publishReviewBatch: vi.fn(),
      publishReview: vi.fn(),
      publishCheckpoint: vi.fn().mockRejectedValue(new Error('checkpoint failed')),
    };
    vi.mocked(createOrchestrator).mockResolvedValue(orchestrator as never);

    await expect(__testing.publishAllPending({ refresh: false })).rejects.toThrow('checkpoint failed');

    expect(orchestrator.publishReply).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('✗ Checkpoint: checkpoint failed'));
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('The checkpoint failed and the review bundle was not refreshed.'),
    );
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Provider actions may already have succeeded'));
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Succeeded: 100'));
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Failed: Checkpoint'));
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Remaining drafts: 0 finding(s), 0 reply/replies.'),
    );
  });

  it('refreshes after publish all by default while preserving pending outputs', async () => {
    await writeBundleState('gitlab');
    const bundlePath = path.join(tmpDir, '.revpack', 'bundle.json');
    const bundle = JSON.parse(await fs.readFile(bundlePath, 'utf-8'));
    bundle.prepare.checkpoint = { headSha: 'head-sha' };
    bundle.prepare.comparison = {
      targetCodeChangedSinceCheckpoint: false,
      threadsChangedSinceCheckpoint: false,
      descriptionChangedSinceCheckpoint: false,
    };
    await fs.writeFile(bundlePath, JSON.stringify(bundle), 'utf-8');
    await fs.mkdir(path.join(tmpDir, '.revpack', 'outputs'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, '.revpack', 'outputs', 'replies.json'),
      JSON.stringify([{ threadId: 'T-001', body: 'Publish and refresh', resolve: false }]),
      'utf-8',
    );
    const orchestrator = {
      workspace: { appendPublishedAction: vi.fn().mockResolvedValue(true) },
      publishReply: vi.fn().mockResolvedValue(undefined),
      prepare: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(createOrchestrator).mockResolvedValue(orchestrator as never);

    await __testing.publishAllPending();

    expect(orchestrator.prepare).toHaveBeenCalledWith(undefined, 'group/project', {
      preservePendingOutputs: true,
    });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Replies'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('✓ T-001'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Refresh'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Bundle refreshed.'));
  });

  it('routes publish all --no-refresh through the non-interactive executor without refreshing', async () => {
    await writeBundleState('gitlab');
    const bundlePath = path.join(tmpDir, '.revpack', 'bundle.json');
    const bundle = JSON.parse(await fs.readFile(bundlePath, 'utf-8'));
    bundle.prepare.checkpoint = { headSha: 'head-sha' };
    bundle.prepare.comparison = {
      targetCodeChangedSinceCheckpoint: false,
      threadsChangedSinceCheckpoint: false,
      descriptionChangedSinceCheckpoint: false,
    };
    await fs.writeFile(bundlePath, JSON.stringify(bundle), 'utf-8');
    await fs.mkdir(path.join(tmpDir, '.revpack', 'outputs'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, '.revpack', 'outputs', 'replies.json'),
      JSON.stringify([{ threadId: 'T-001', body: 'Automation reply', resolve: false }]),
      'utf-8',
    );
    const orchestrator = {
      workspace: { appendPublishedAction: vi.fn().mockResolvedValue(true) },
      publishReply: vi.fn().mockResolvedValue(undefined),
      prepare: vi.fn(),
    };
    vi.mocked(createOrchestrator).mockResolvedValue(orchestrator as never);
    const program = new Command();
    registerPublishCommand(program);

    await program.parseAsync(['publish', '--no-refresh', 'all'], { from: 'user' });

    expect(orchestrator.publishReply).toHaveBeenCalledWith(undefined, 'T-001', 'Automation reply', 'group/project');
    expect(orchestrator.prepare).not.toHaveBeenCalled();
    expect(handleError).not.toHaveBeenCalled();
  });

  it('validates every queue before publish all performs any provider action', async () => {
    await writeBundleState('bitbucket-cloud');
    await fs.mkdir(path.join(tmpDir, '.revpack', 'outputs'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, '.revpack', 'outputs', 'replies.json'),
      JSON.stringify([{ threadId: '100', body: 'Reply body', resolve: false }]),
      'utf-8',
    );
    await fs.writeFile(path.join(tmpDir, '.revpack', 'outputs', 'new-findings.json'), '{not json', 'utf-8');

    const orchestrator = {
      publishReply: vi.fn().mockResolvedValue(undefined),
      publishCheckpoint: vi.fn(),
    };
    vi.mocked(createOrchestrator).mockResolvedValue(orchestrator as never);

    await expect(__testing.publishAllPending({ refresh: false })).rejects.toThrow('must contain valid JSON');

    expect(orchestrator.publishReply).not.toHaveBeenCalled();
    expect(orchestrator.publishCheckpoint).not.toHaveBeenCalled();
  });

  it('stops before checkpoint when description publishing fails unexpectedly', async () => {
    await writeBundleState('bitbucket-cloud');
    await fs.mkdir(path.join(tmpDir, '.revpack', 'outputs'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, '.revpack', 'outputs', 'summary.md'), 'Generated summary', 'utf-8');

    const orchestrator = {
      open: vi.fn().mockRejectedValue(new Error('provider unavailable')),
      updateDescription: vi.fn(),
      publishReview: vi.fn(),
      publishCheckpoint: vi.fn(),
    };
    vi.mocked(createOrchestrator).mockResolvedValue(orchestrator as never);

    await expect(__testing.publishAllPending({ refresh: false })).rejects.toThrow('provider unavailable');

    expect(orchestrator.open).toHaveBeenCalledTimes(1);
    expect(orchestrator.updateDescription).not.toHaveBeenCalled();
    expect(orchestrator.publishReview).not.toHaveBeenCalled();
    expect(orchestrator.publishCheckpoint).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('(no summary to publish)'));
  });
});
