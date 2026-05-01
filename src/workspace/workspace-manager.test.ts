import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { WorkspaceManager } from '../workspace/workspace-manager.js';
import type { ReviewTarget, ReviewThread, ReviewDiff, ReviewVersion } from '../core/types.js';

const makeTarget = (): ReviewTarget => ({
  provider: 'gitlab',
  repository: 'group/project',
  targetType: 'merge_request',
  targetId: '42',
  title: 'Test MR',
  description: 'A test merge request',
  author: 'alice',
  state: 'opened',
  sourceBranch: 'feature/test',
  targetBranch: 'main',
  webUrl: 'https://gitlab.example.com/group/project/-/merge_requests/42',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  labels: [],
  diffRefs: { baseSha: 'aaa', headSha: 'bbb', startSha: 'aaa' },
});

const makeThread = (): ReviewThread => ({
  provider: 'gitlab',
  targetRef: {
    provider: 'gitlab',
    repository: 'group/project',
    targetType: 'merge_request',
    targetId: '42',
  },
  threadId: 'thread-abc',
  resolved: false,
  resolvable: true,
  position: { filePath: 'src/app.ts', newLine: 10 },
  comments: [
    {
      id: 'note-1',
      body: 'Fix this null check',
      author: 'bob',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      origin: 'human',
      system: false,
    },
  ],
});

const makeDiff = (): ReviewDiff => ({
  oldPath: 'src/app.ts',
  newPath: 'src/app.ts',
  diff: '@@ -1,3 +1,4 @@\n import { foo } from "bar";\n+import { baz } from "qux";\n',
  newFile: false,
  renamedFile: false,
  deletedFile: false,
});

const makeStructuredDiff = (): ReviewDiff => ({
  oldPath: 'src/service.ts',
  newPath: 'src/service.ts',
  diff: [
    '@@ -10,4 +10,5 @@ function run()',
    ' const value = read();',
    '-oldCall(value);',
    '+newCall(value);',
    ' return value;',
    '+audit(value);',
  ].join('\n'),
  newFile: false,
  renamedFile: false,
  deletedFile: false,
});

describe('WorkspaceManager', () => {
  let tmpDir: string;
  let manager: WorkspaceManager;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'revkit-test-'));
    manager = new WorkspaceManager(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /** Helper: build index and create bundle in one call */
  async function createBundle(
    m: WorkspaceManager,
    target: ReviewTarget,
    threads: ReviewThread[],
    diffs: ReviewDiff[] = [],
    versions: ReviewVersion[] = [],
  ) {
    const threadIndex = WorkspaceManager.buildThreadIndex(threads);
    return { bundle: await m.createBundle(target, threads, diffs, versions, threadIndex), threadIndex };
  }

  it('creates bundle directory structure', async () => {
    const { bundle } = await createBundle(manager, makeTarget(), [makeThread()], [makeDiff()]);

    expect(bundle.preparedAt).toBeTruthy();
    expect(bundle.target.targetId).toBe('42');
    expect(bundle.threads).toHaveLength(1);
    expect(bundle.diffs).toHaveLength(1);

    // Verify directory structure
    const bundleDir = path.join(tmpDir, '.revkit');
    const entries = await fs.readdir(bundleDir);
    expect(entries).toContain('description.md');
    expect(entries).toContain('threads');
    expect(entries).toContain('diffs');
    expect(entries).toContain('outputs');
  });

  it('writes description.md with MR description', async () => {
    await createBundle(manager, makeTarget(), []);

    const descPath = path.join(tmpDir, '.revkit', 'description.md');
    const content = await fs.readFile(descPath, 'utf-8');

    expect(content).toContain('A test merge request');
  });

  it('writes thread JSON and markdown files', async () => {
    await createBundle(manager, makeTarget(), [makeThread()]);

    const threadDir = path.join(tmpDir, '.revkit', 'threads');
    const files = await fs.readdir(threadDir);

    expect(files).toContain('T-001.json');
    expect(files).toContain('T-001.md');

    const threadJson = JSON.parse(await fs.readFile(path.join(threadDir, 'T-001.json'), 'utf-8'));
    expect(threadJson.threadId).toBe('thread-abc');

    const threadMd = await fs.readFile(path.join(threadDir, 'T-001.md'), 'utf-8');
    expect(threadMd).toContain('Thread thread-abc');
    expect(threadMd).toContain('Fix this null check');
    expect(threadMd).toContain('Unresolved');
  });

  it('writes latest.patch', async () => {
    await createBundle(manager, makeTarget(), [], [makeDiff()]);

    const patchPath = path.join(tmpDir, '.revkit', 'diffs', 'latest.patch');
    const patch = await fs.readFile(patchPath, 'utf-8');

    expect(patch).toContain('diff --git');
    expect(patch).toContain('src/app.ts');
  });

  it('writes structured diff artifacts and annotated views', async () => {
    await createBundle(manager, makeTarget(), [], [makeStructuredDiff()]);

    const diffDir = path.join(tmpDir, '.revkit', 'diffs');
    const filesJson = JSON.parse(await fs.readFile(path.join(diffDir, 'files.json'), 'utf-8'));
    expect(filesJson.files).toHaveLength(1);
    expect(filesJson.files[0]).toMatchObject({
      fileId: 'F001',
      status: 'modified',
      oldPath: 'src/service.ts',
      newPath: 'src/service.ts',
      added: 2,
      removed: 1,
      viewFile: 'views/by-file/F001-service.diff.md',
    });
    expect(filesJson.files[0].hunks[0]).toMatchObject({
      hunkId: 'F001-H001',
      oldStart: 10,
      oldEnd: 12,
      newStart: 10,
      newEnd: 13,
    });

    const lineMapLines = (await fs.readFile(path.join(diffDir, 'line-map.ndjson'), 'utf-8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(lineMapLines).toEqual([
      {
        fileId: 'F001',
        hunkId: 'F001-H001',
        kind: 'context',
        oldLine: 10,
        newLine: 10,
        oldPath: 'src/service.ts',
        newPath: 'src/service.ts',
        text: 'const value = read();',
      },
      {
        fileId: 'F001',
        hunkId: 'F001-H001',
        kind: 'removed',
        oldLine: 11,
        newLine: null,
        oldPath: 'src/service.ts',
        newPath: 'src/service.ts',
        text: 'oldCall(value);',
      },
      {
        fileId: 'F001',
        hunkId: 'F001-H001',
        kind: 'added',
        oldLine: null,
        newLine: 11,
        oldPath: 'src/service.ts',
        newPath: 'src/service.ts',
        text: 'newCall(value);',
      },
      {
        fileId: 'F001',
        hunkId: 'F001-H001',
        kind: 'context',
        oldLine: 12,
        newLine: 12,
        oldPath: 'src/service.ts',
        newPath: 'src/service.ts',
        text: 'return value;',
      },
      {
        fileId: 'F001',
        hunkId: 'F001-H001',
        kind: 'added',
        oldLine: null,
        newLine: 13,
        oldPath: 'src/service.ts',
        newPath: 'src/service.ts',
        text: 'audit(value);',
      },
    ]);

    const changeBlocks = JSON.parse(await fs.readFile(path.join(diffDir, 'change-blocks.json'), 'utf-8'));
    expect(changeBlocks.blocks).toEqual([
      {
        blockId: 'B001',
        fileId: 'F001',
        hunkId: 'F001-H001',
        kind: 'replace',
        oldStart: 11,
        oldEnd: 11,
        newStart: 11,
        newEnd: 11,
        preferredCommentTarget: { side: 'new', path: 'src/service.ts', line: 11 },
      },
      {
        blockId: 'B002',
        fileId: 'F001',
        hunkId: 'F001-H001',
        kind: 'insert',
        oldStart: 12,
        oldEnd: 12,
        newStart: 13,
        newEnd: 13,
        preferredCommentTarget: { side: 'new', path: 'src/service.ts', line: 13 },
      },
    ]);

    const annotated = await fs.readFile(path.join(diffDir, 'views', 'all.annotated.diff.md'), 'utf-8');
    expect(annotated).toContain('FILE F001');
    expect(annotated).toContain('@@ F001-H001 old:10-12 new:10-13 @@ function run()');
    expect(annotated).toContain('- old:    11            | oldCall(value);');
    expect(annotated).toContain('+            new:    11 | newCall(value);');
    expect(annotated).toContain('+            new:    13 | audit(value);');

    const perFile = await fs.readFile(path.join(diffDir, 'views', 'by-file', 'F001-service.diff.md'), 'utf-8');
    expect(annotated).toContain(perFile.trimEnd());
  });

  it('writes output files', async () => {
    await createBundle(manager, makeTarget(), []);
    const outputPath = await manager.writeOutput('test.md', '# Test');

    expect(outputPath).toContain('outputs');
    const content = await fs.readFile(outputPath, 'utf-8');
    expect(content).toBe('# Test');
  });

  it('loadBundleState returns null when no bundle exists', async () => {
    const state = await manager.loadBundleState();
    expect(state).toBeNull();
  });

  it('buildThreadIndex derives T-NNN from position', () => {
    const thread1 = { ...makeThread(), threadId: 'aaa' };
    const thread2 = { ...makeThread(), threadId: 'bbb' };
    const thread3 = { ...makeThread(), threadId: 'ccc' };

    const index = WorkspaceManager.buildThreadIndex([thread1, thread2, thread3]);
    expect(index.get('aaa')).toBe('T-001');
    expect(index.get('bbb')).toBe('T-002');
    expect(index.get('ccc')).toBe('T-003');
    expect(index.size).toBe(3);
  });

  it('derives T-NNN IDs from position in all-threads list', async () => {
    const thread1 = makeThread();
    const thread2 = { ...makeThread(), threadId: 'thread-xyz', comments: thread1.comments };

    // Two threads → T-001 and T-002 based on position
    await createBundle(manager, makeTarget(), [thread1, thread2]);

    const threadDir = path.join(tmpDir, '.revkit', 'threads');
    const files = (await fs.readdir(threadDir)).sort();
    expect(files).toContain('T-001.json');
    expect(files).toContain('T-002.json');

    // No thread-map.json file should exist
    const mapPath = path.join(tmpDir, '.revkit', 'thread-map.json');
    expect(await fileExists(mapPath)).toBe(false);

    // Second run with different threads: positions are recalculated
    const thread3 = { ...makeThread(), threadId: 'thread-new', comments: thread1.comments };
    await createBundle(manager, makeTarget(), [thread2, thread3]);

    const files2 = (await fs.readdir(threadDir)).filter((f) => f.endsWith('.json')).sort();
    // thread2 is now at position 0 → T-001, thread3 at position 1 → T-002
    expect(files2).toEqual(['T-001.json', 'T-002.json']);

    const t1 = JSON.parse(await fs.readFile(path.join(threadDir, 'T-001.json'), 'utf-8'));
    expect(t1.threadId).toBe('thread-xyz');
    const t2 = JSON.parse(await fs.readFile(path.join(threadDir, 'T-002.json'), 'utf-8'));
    expect(t2.threadId).toBe('thread-new');
  });

  it('resolves T-NNN from thread JSON files on disk', async () => {
    await createBundle(manager, makeTarget(), [makeThread()]);

    const resolved = await manager.resolveThreadRef('T-001');
    expect(resolved).toBe('thread-abc');
  });

  it('passes through non-T-NNN refs unchanged', async () => {
    const resolved = await manager.resolveThreadRef('abc123def');
    expect(resolved).toBe('abc123def');
  });

  it('prunes stale replies on incremental runs', async () => {
    const threads = [makeThread()];
    const { threadIndex } = await createBundle(manager, makeTarget(), threads);

    // Write a replies.json with two entries
    const repliesPath = path.join(tmpDir, '.revkit', 'outputs', 'replies.json');
    await fs.writeFile(
      repliesPath,
      JSON.stringify([
        { threadId: 'T-001', body: 'reply1', resolve: true },
        { threadId: 'T-999', body: 'stale reply', resolve: false },
      ]),
      'utf-8',
    );

    // Prune with only thread-abc active
    const activeIds = new Set(['thread-abc']);
    const pruned = await manager.pruneStaleReplies(activeIds, threadIndex);
    expect(pruned).toBe(1);

    const remaining = JSON.parse(await fs.readFile(repliesPath, 'utf-8'));
    expect(remaining).toHaveLength(1);
    expect(remaining[0].threadId).toBe('T-001');
  });

  it('returns 0 when pruning with no replies file', async () => {
    await createBundle(manager, makeTarget(), []);
    const pruned = await manager.pruneStaleReplies(new Set(), new Map());
    expect(pruned).toBe(0);
  });

  it('removeBundle removes entire directory', async () => {
    await createBundle(manager, makeTarget(), [makeThread()]);

    const bundleDir = path.join(tmpDir, '.revkit');
    expect(await fileExists(bundleDir)).toBe(true);

    await manager.removeBundle();
    expect(await fileExists(bundleDir)).toBe(false);
  });

  it('removeBundle is safe when nothing exists', async () => {
    await expect(manager.removeBundle()).resolves.not.toThrow();
  });

  it('only emits thread items for threads written to the bundle', () => {
    const activeThread = makeThread();
    const resolvedThread = { ...makeThread(), threadId: 'thread-resolved', resolved: true };
    const allThreads = [activeThread, resolvedThread];
    const threadIndex = WorkspaceManager.buildThreadIndex(allThreads);

    const bundleState = manager.buildBundleState(
      makeTarget(),
      allThreads,
      [],
      threadIndex,
      {
        mode: 'fresh',
        checkpoint: null,
        current: { targetHeadSha: 'bbb', localHeadSha: 'bbb', threadsDigest: null },
        comparison: {
          targetCodeChangedSinceCheckpoint: null,
          threadsChangedSinceCheckpoint: null,
          descriptionChangedSinceCheckpoint: null,
        },
      },
      {
        repositoryRoot: tmpDir,
        branch: 'feature/test',
        headSha: 'bbb',
        matchesTargetSourceBranch: true,
        matchesTargetHead: true,
        workingTreeClean: true,
        checkedAt: '2026-01-01T00:00:00Z',
      },
      undefined,
      undefined,
      [activeThread],
    );

    expect(bundleState.threads.items.map((item) => item.providerThreadId)).toEqual(['thread-abc']);
  });

  it('writes incremental diff patch', async () => {
    await createBundle(manager, makeTarget(), []);

    const incrementalDiff: ReviewDiff = {
      oldPath: 'src/foo.ts',
      newPath: 'src/foo.ts',
      diff: '+new incremental line',
      newFile: false,
      renamedFile: false,
      deletedFile: false,
    };
    await manager.writeIncrementalDiff([incrementalDiff]);

    const patchPath = path.join(tmpDir, '.revkit', 'diffs', 'incremental.patch');
    const patch = await fs.readFile(patchPath, 'utf-8');
    expect(patch).toContain('diff --git a/src/foo.ts b/src/foo.ts');
    expect(patch).toContain('+new incremental line');
  });

  describe('writeContext', () => {
    it('writes CONTEXT.md with MR metadata', async () => {
      const threads = [makeThread()];
      const { threadIndex } = await createBundle(manager, makeTarget(), threads, [makeDiff()]);

      const contextPath = await manager.writeContext(makeTarget(), threads, [makeDiff()], threadIndex);

      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).toContain('# Review Context');
      expect(content).toContain('!42');
      expect(content).toContain('Test MR');
      expect(content).toContain('@alice');
      expect(content).toContain('feature/test');
    });

    it('includes thread overview table', async () => {
      const threads = [makeThread()];
      const { threadIndex } = await createBundle(manager, makeTarget(), threads);

      const contextPath = await manager.writeContext(makeTarget(), threads, [], threadIndex);

      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).toContain('## Unresolved Threads');
      expect(content).toContain('T-001');
      expect(content).toContain('src/app.ts');
    });

    it('includes changed files list', async () => {
      const newFileDiff: ReviewDiff = {
        ...makeDiff(),
        newFile: true,
        newPath: 'src/new-file.ts',
        oldPath: 'src/new-file.ts',
      };

      const { threadIndex } = await createBundle(manager, makeTarget(), [], [makeDiff(), newFileDiff]);

      const contextPath = await manager.writeContext(makeTarget(), [], [makeDiff(), newFileDiff], threadIndex);

      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).toContain('## Changed Files');
      expect(content).toContain('`src/app.ts`');
      expect(content).toContain('modified');
      expect(content).toContain('`src/new-file.ts`');
      expect(content).toContain('added');
    });

    it('includes resolved changed threads from the full checkpoint comparison set', async () => {
      const activeThread = makeThread();
      const resolvedThread: ReviewThread = {
        ...makeThread(),
        threadId: 'thread-resolved',
        resolved: true,
        comments: [
          {
            id: 'resolved-note',
            body: 'This was fixed in the latest push',
            author: 'reviewer',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            origin: 'human',
            system: false,
          },
        ],
      };
      const allThreads = [activeThread, resolvedThread];
      const threadIndex = WorkspaceManager.buildThreadIndex(allThreads);
      await manager.createBundle(makeTarget(), [activeThread], [], [], threadIndex);

      const contextPath = await manager.writeContext(makeTarget(), [activeThread], [], threadIndex, {
        changedThreadIds: new Set(['thread-resolved']),
        allThreads,
      });

      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).toContain('## Changed Threads Since Last Checkpoint');
      expect(content).toContain('| T-002 | resolved |');
      expect(content).toContain('This was fixed in the latest push');
    });

    it('escapes markdown table separators in thread snippets', async () => {
      const threadWithPipe: ReviewThread = {
        ...makeThread(),
        comments: [
          {
            id: 'note-with-pipe',
            body: 'Use foo | bar handling here',
            author: 'reviewer',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            origin: 'human',
            system: false,
          },
        ],
      };
      const { threadIndex } = await createBundle(manager, makeTarget(), [threadWithPipe]);

      const contextPath = await manager.writeContext(makeTarget(), [threadWithPipe], [], threadIndex);

      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).toContain('Use foo \\| bar handling here');
    });

    it('shows review checkpoint summary with checkpoint and code changes', async () => {
      const threads = [makeThread()];
      const { threadIndex } = await createBundle(manager, makeTarget(), threads);

      const contextPath = await manager.writeContext(makeTarget(), threads, [], threadIndex, {
        prepareSummary: {
          mode: 'refresh',
          checkpoint: {
            source: 'managed_review_note',
            providerNoteId: 'note-1',
            headSha: 'aaa',
            baseSha: 'xxx',
            startSha: 'xxx',
            threadsDigest: null,
            descriptionDigest: null,
            threadDigests: {},
            createdAt: '2026-01-01T00:00:00Z',
          },
          current: { providerVersionId: 'v1', targetHeadSha: 'bbb', localHeadSha: 'bbb', threadsDigest: null },
          comparison: {
            targetCodeChangedSinceCheckpoint: true,
            threadsChangedSinceCheckpoint: null,
            descriptionChangedSinceCheckpoint: null,
          },
        },
      });

      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).toContain('## Review Checkpoint Summary');
      expect(content).toContain('Last review checkpoint');
      expect(content).toContain('Target code changed since checkpoint');
      expect(content).toContain('yes');
    });

    it('includes workflow instructions', async () => {
      const { threadIndex } = await createBundle(manager, makeTarget(), []);

      const contextPath = await manager.writeContext(makeTarget(), [], [], threadIndex);

      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).toContain('## Suggested Reading Order');
      expect(content).toContain('REVIEW.md');
      expect(content).toContain('INSTRUCTIONS.md');
    });

    it('shows general comments section for non-resolvable human threads', async () => {
      const resolvableThread = makeThread();
      const generalComment: ReviewThread = {
        ...makeThread(),
        threadId: 'general-1',
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

      const allThreads = [resolvableThread, generalComment];
      const threadIndex = WorkspaceManager.buildThreadIndex(allThreads);
      await manager.createBundle(makeTarget(), allThreads, [], [], threadIndex);

      const contextPath = await manager.writeContext(makeTarget(), allThreads, [], threadIndex);

      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).toContain('## Unresolved Threads');
      expect(content).toContain('T-001');
      expect(content).toContain('## General Comments');
      expect(content).toContain('T-002');
      expect(content).toContain('Great work on this MR overall!');
    });

    it('shows Previous Actions section when publishedActions are provided', async () => {
      const threads = [makeThread()];
      const { threadIndex } = await createBundle(manager, makeTarget(), threads);

      const contextPath = await manager.writeContext(makeTarget(), threads, [], threadIndex, {
        publishedActions: [
          {
            type: 'reply',
            providerThreadId: 'thread-abc',
            title: 'Fixed, good catch!',
            publishedAt: '2026-01-01T12:00:00Z',
          },
          {
            type: 'finding',
            location: { oldPath: 'src/auth.ts', newPath: 'src/auth.ts', newLine: 42 },
            severity: 'high',
            category: 'correctness',
            title: 'Unsafe token',
            publishedAt: '2026-01-01T12:01:00Z',
          },
        ],
      });

      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).toContain('## Previous Actions');
      expect(content).toContain('Reply');
      expect(content).toContain('Finding');
      expect(content).toContain('src/auth.ts');
    });

    it('tags SELF on threads created by published findings', async () => {
      const selfThread: ReviewThread = {
        ...makeThread(),
        threadId: 'self-thread-sha',
        position: { filePath: 'src/auth.ts', newLine: 42 },
        comments: [
          {
            id: 'self-note',
            body: '<!-- revkit -->\nUnsafe token comparison',
            author: 'bot',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            origin: 'bot',
            system: false,
          },
        ],
      };
      const threads = [makeThread(), selfThread];
      const threadIndex = WorkspaceManager.buildThreadIndex(threads);
      await manager.createBundle(makeTarget(), threads, [], [], threadIndex);

      const contextPath = await manager.writeContext(makeTarget(), threads, [], threadIndex);

      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).toContain('SELF');
      // T-001 should NOT be tagged SELF
      expect(content).not.toMatch(/T-001.*SELF/);
    });

    it('derives SELF and REPLIED from chronological comments, not provider order', async () => {
      const selfThread: ReviewThread = {
        ...makeThread(),
        threadId: 'self-thread',
        comments: [
          {
            id: 'later-human',
            body: 'Follow-up question',
            author: 'reviewer',
            createdAt: '2026-01-01T01:00:00Z',
            updatedAt: '2026-01-01T01:00:00Z',
            origin: 'human',
            system: false,
          },
          {
            id: 'first-bot',
            body: '<!-- revkit -->\nOriginal finding',
            author: 'bot',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            origin: 'bot',
            system: false,
          },
        ],
      };
      const repliedThread: ReviewThread = {
        ...makeThread(),
        threadId: 'replied-thread',
        comments: [
          {
            id: 'later-bot',
            body: '<!-- revkit -->\nFixed now',
            author: 'bot',
            createdAt: '2026-01-01T01:00:00Z',
            updatedAt: '2026-01-01T01:00:00Z',
            origin: 'bot',
            system: false,
          },
          {
            id: 'first-human',
            body: 'Please fix',
            author: 'reviewer',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            origin: 'human',
            system: false,
          },
        ],
      };
      const threads = [selfThread, repliedThread];
      const threadIndex = WorkspaceManager.buildThreadIndex(threads);
      await manager.createBundle(makeTarget(), threads, [], [], threadIndex);

      const contextPath = await manager.writeContext(makeTarget(), threads, [], threadIndex);

      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).toMatch(/T-001 \| SELF/);
      expect(content).toMatch(/T-002 \| REPLIED/);
    });

    it('tags REPLIED on threads that have a bot reply', async () => {
      const repliedThread: ReviewThread = {
        ...makeThread(),
        threadId: 'replied-thread-sha',
        comments: [
          {
            id: 'human-note',
            body: 'This needs fixing',
            author: 'reviewer',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            origin: 'human',
            system: false,
          },
          {
            id: 'bot-reply',
            body: '<!-- revkit -->\nFixed, good catch!',
            author: 'bot',
            createdAt: '2026-01-01T01:00:00Z',
            updatedAt: '2026-01-01T01:00:00Z',
            origin: 'bot',
            system: false,
          },
        ],
      };
      const threads = [repliedThread];
      const threadIndex = WorkspaceManager.buildThreadIndex(threads);
      await manager.createBundle(makeTarget(), threads, [], [], threadIndex);

      const contextPath = await manager.writeContext(makeTarget(), threads, [], threadIndex);

      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).toContain('REPLIED');
    });

    it('omits Previous Actions section when no actions exist', async () => {
      const { threadIndex } = await createBundle(manager, makeTarget(), []);

      const contextPath = await manager.writeContext(makeTarget(), [], [], threadIndex, {
        publishedActions: [],
      });

      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).not.toContain('## Previous Actions');
    });

    it('references description.md for MR description', async () => {
      const { threadIndex } = await createBundle(manager, makeTarget(), []);

      const contextPath = await manager.writeContext(makeTarget(), [], [makeDiff()], threadIndex);

      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).toContain('description.md');
    });
  });

  describe('appendPublishedAction', () => {
    it('appends action to existing bundle.json', async () => {
      await createBundle(manager, makeTarget(), []);

      // First save a bundle state
      const bundleState = manager.buildBundleState(
        makeTarget(),
        [],
        [],
        new Map(),
        {
          mode: 'fresh',
          checkpoint: null,
          current: { targetHeadSha: 'bbb', localHeadSha: 'bbb', threadsDigest: null },
          comparison: {
            targetCodeChangedSinceCheckpoint: null,
            threadsChangedSinceCheckpoint: null,
            descriptionChangedSinceCheckpoint: null,
          },
        },
        {
          repositoryRoot: tmpDir,
          branch: 'feature/test',
          headSha: 'bbb',
          matchesTargetSourceBranch: true,
          matchesTargetHead: true,
          workingTreeClean: true,
          checkedAt: '2026-01-01T00:00:00Z',
        },
      );
      await manager.saveBundleState(bundleState);

      const appended = await manager.appendPublishedAction({
        type: 'reply',
        providerThreadId: 'thread-abc',
        title: 'Fixed!',
        publishedAt: '2026-01-01T12:00:00Z',
      });
      expect(appended).toBe(true);

      const state = await manager.loadBundleState();
      expect(state!.publishedActions).toHaveLength(1);
      expect(state!.publishedActions[0].providerThreadId).toBe('thread-abc');
    });

    it('accumulates multiple actions', async () => {
      await createBundle(manager, makeTarget(), []);

      const bundleState = manager.buildBundleState(
        makeTarget(),
        [],
        [],
        new Map(),
        {
          mode: 'fresh',
          checkpoint: null,
          current: { targetHeadSha: 'bbb', localHeadSha: 'bbb', threadsDigest: null },
          comparison: {
            targetCodeChangedSinceCheckpoint: null,
            threadsChangedSinceCheckpoint: null,
            descriptionChangedSinceCheckpoint: null,
          },
        },
        {
          repositoryRoot: tmpDir,
          branch: 'feature/test',
          headSha: 'bbb',
          matchesTargetSourceBranch: true,
          matchesTargetHead: true,
          workingTreeClean: true,
          checkedAt: '2026-01-01T00:00:00Z',
        },
      );
      await manager.saveBundleState(bundleState);

      await manager.appendPublishedAction({
        type: 'reply',
        providerThreadId: 'thread-abc',
        title: 'First',
        publishedAt: '2026-01-01T12:00:00Z',
      });
      await manager.appendPublishedAction({
        type: 'finding',
        location: { oldPath: 'src/app.ts', newPath: 'src/app.ts', newLine: 10 },
        severity: 'high',
        category: 'correctness',
        title: 'Second',
        publishedAt: '2026-01-01T12:01:00Z',
      });

      const state = await manager.loadBundleState();
      expect(state!.publishedActions).toHaveLength(2);
    });

    it('returns false when no bundle exists', async () => {
      const result = await manager.appendPublishedAction({
        type: 'reply',
        providerThreadId: 'thread-1',
        title: 'No bundle',
        publishedAt: '2026-01-01T12:00:00Z',
      });
      expect(result).toBe(false);
    });
  });

  describe('files.json status and binary metadata', () => {
    it('marks a text addition as added with oldExists=false, newExists=true', async () => {
      const addedDiff: ReviewDiff = {
        oldPath: 'src/New.ts',
        newPath: 'src/New.ts',
        diff: '--- /dev/null\n+++ b/src/New.ts\n@@ -0,0 +1,2 @@\n+const x = 1;\n+export default x;\n',
        newFile: true,
        renamedFile: false,
        deletedFile: false,
      };
      await createBundle(manager, makeTarget(), [], [addedDiff]);

      const filesJson = JSON.parse(await fs.readFile(path.join(tmpDir, '.revkit', 'diffs', 'files.json'), 'utf-8'));
      const entry = filesJson.files[0];
      expect(entry.status).toBe('added');
      expect(entry.binary).toBe(false);
      expect(entry.oldExists).toBe(false);
      expect(entry.newExists).toBe(true);
    });

    it('marks a text deletion as deleted with oldExists=true, newExists=false', async () => {
      const deletedDiff: ReviewDiff = {
        oldPath: 'src/Gone.ts',
        newPath: 'src/Gone.ts',
        diff: '--- a/src/Gone.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-const x = 1;\n-export default x;\n',
        newFile: false,
        renamedFile: false,
        deletedFile: true,
      };
      await createBundle(manager, makeTarget(), [], [deletedDiff]);

      const filesJson = JSON.parse(await fs.readFile(path.join(tmpDir, '.revkit', 'diffs', 'files.json'), 'utf-8'));
      const entry = filesJson.files[0];
      expect(entry.status).toBe('deleted');
      expect(entry.binary).toBe(false);
      expect(entry.oldExists).toBe(true);
      expect(entry.newExists).toBe(false);
    });

    it('marks a binary addition as added with binary=true', async () => {
      // GitLab returns an empty diff for binary files
      const binaryAddedDiff: ReviewDiff = {
        oldPath: 'assets/logo.png',
        newPath: 'assets/logo.png',
        diff: '',
        newFile: true,
        renamedFile: false,
        deletedFile: false,
      };
      await createBundle(manager, makeTarget(), [], [binaryAddedDiff]);

      const filesJson = JSON.parse(await fs.readFile(path.join(tmpDir, '.revkit', 'diffs', 'files.json'), 'utf-8'));
      const entry = filesJson.files[0];
      expect(entry.status).toBe('added');
      expect(entry.binary).toBe(true);
      expect(entry.oldExists).toBe(false);
      expect(entry.newExists).toBe(true);
      expect(entry.added).toBe(0);
      expect(entry.removed).toBe(0);
    });

    it('marks a binary deletion as deleted with binary=true', async () => {
      const binaryDeletedDiff: ReviewDiff = {
        oldPath: 'assets/old.png',
        newPath: 'assets/old.png',
        diff: '',
        newFile: false,
        renamedFile: false,
        deletedFile: true,
      };
      await createBundle(manager, makeTarget(), [], [binaryDeletedDiff]);

      const filesJson = JSON.parse(await fs.readFile(path.join(tmpDir, '.revkit', 'diffs', 'files.json'), 'utf-8'));
      const entry = filesJson.files[0];
      expect(entry.status).toBe('deleted');
      expect(entry.binary).toBe(true);
      expect(entry.oldExists).toBe(true);
      expect(entry.newExists).toBe(false);
    });

    it('marks a regular modification as modified with binary=false, both exist', async () => {
      await createBundle(manager, makeTarget(), [], [makeDiff()]);

      const filesJson = JSON.parse(await fs.readFile(path.join(tmpDir, '.revkit', 'diffs', 'files.json'), 'utf-8'));
      const entry = filesJson.files[0];
      expect(entry.status).toBe('modified');
      expect(entry.binary).toBe(false);
      expect(entry.oldExists).toBe(true);
      expect(entry.newExists).toBe(true);
    });
  });

  describe('thread JSON targetRef', () => {
    it('writes only the 4 minimal targetRef fields, not the full ReviewTarget', async () => {
      // Simulate what happens when the provider passes a full ReviewTarget as targetRef
      // (ReviewTarget extends ReviewTargetRef, so extra fields bleed through at runtime)
      const threadWithFullTargetRef: ReviewThread = {
        ...makeThread(),
        // Cast to satisfy the type but include extra fields that would come from a ReviewTarget
        targetRef: {
          provider: 'gitlab',
          repository: 'group/project',
          targetType: 'merge_request',
          targetId: '42',
          // Extra fields that must NOT appear in the written JSON
          ...({ title: 'Should not be here', author: 'alice', state: 'opened' } as object),
        } as ReviewThread['targetRef'],
      };

      await createBundle(manager, makeTarget(), [threadWithFullTargetRef]);

      const threadJson = JSON.parse(await fs.readFile(path.join(tmpDir, '.revkit', 'threads', 'T-001.json'), 'utf-8'));

      expect(Object.keys(threadJson.targetRef)).toEqual(['provider', 'repository', 'targetType', 'targetId']);
      expect(threadJson.targetRef.provider).toBe('gitlab');
      expect(threadJson.targetRef.repository).toBe('group/project');
      expect(threadJson.targetRef.targetType).toBe('merge_request');
      expect(threadJson.targetRef.targetId).toBe('42');
      // Must NOT have extra fields
      expect((threadJson.targetRef as Record<string, unknown>).title).toBeUndefined();
      expect((threadJson.targetRef as Record<string, unknown>).author).toBeUndefined();
    });
  });
});

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
