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

describe('WorkspaceManager', () => {
  let tmpDir: string;
  let manager: WorkspaceManager;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-assist-test-'));
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

    expect(bundle.sessionId).toBeTruthy();
    expect(bundle.target.targetId).toBe('42');
    expect(bundle.threads).toHaveLength(1);
    expect(bundle.diffs).toHaveLength(1);

    // Verify directory structure
    const bundleDir = path.join(tmpDir, '.review-assist');
    const entries = await fs.readdir(bundleDir);
    expect(entries).toContain('session.json');
    expect(entries).toContain('target.json');
    expect(entries).toContain('threads');
    expect(entries).toContain('diffs');
    expect(entries).toContain('outputs');
  });

  it('writes session.json with correct structure', async () => {
    await createBundle(manager, makeTarget(), []);

    const sessionPath = path.join(tmpDir, '.review-assist', 'session.json');
    const session = JSON.parse(await fs.readFile(sessionPath, 'utf-8'));

    expect(session).toHaveProperty('id');
    expect(session).toHaveProperty('createdAt');
    expect(session.targetRef).toBeDefined();
  });

  it('writes target.json', async () => {
    await createBundle(manager, makeTarget(), []);

    const targetPath = path.join(tmpDir, '.review-assist', 'target.json');
    const target = JSON.parse(await fs.readFile(targetPath, 'utf-8'));

    expect(target.targetId).toBe('42');
    expect(target.title).toBe('Test MR');
  });

  it('writes thread JSON and markdown files', async () => {
    await createBundle(manager, makeTarget(), [makeThread()]);

    const threadDir = path.join(tmpDir, '.review-assist', 'threads');
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

    const patchPath = path.join(tmpDir, '.review-assist', 'diffs', 'latest.patch');
    const patch = await fs.readFile(patchPath, 'utf-8');

    expect(patch).toContain('diff --git');
    expect(patch).toContain('src/app.ts');
  });

  it('writes output files', async () => {
    await createBundle(manager, makeTarget(), []);
    const outputPath = await manager.writeOutput('test.md', '# Test');

    expect(outputPath).toContain('outputs');
    const content = await fs.readFile(outputPath, 'utf-8');
    expect(content).toBe('# Test');
  });

  it('loads session from disk', async () => {
    await createBundle(manager, makeTarget(), []);
    const session = await manager.loadSession();

    expect(session).toBeTruthy();
    expect(session!.targetRef.targetId).toBe('42');
  });

  it('returns null when no session exists', async () => {
    const session = await manager.loadSession();
    expect(session).toBeNull();
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

    const threadDir = path.join(tmpDir, '.review-assist', 'threads');
    const files = (await fs.readdir(threadDir)).sort();
    expect(files).toContain('T-001.json');
    expect(files).toContain('T-002.json');

    // No thread-map.json file should exist
    const mapPath = path.join(tmpDir, '.review-assist', 'thread-map.json');
    expect(await fileExists(mapPath)).toBe(false);

    // Second run with different threads: positions are recalculated
    const thread3 = { ...makeThread(), threadId: 'thread-new', comments: thread1.comments };
    await createBundle(manager, makeTarget(), [thread2, thread3]);

    const files2 = (await fs.readdir(threadDir)).filter(f => f.endsWith('.json')).sort();
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
    const repliesPath = path.join(tmpDir, '.review-assist', 'outputs', 'replies.json');
    await fs.writeFile(repliesPath, JSON.stringify([
      { threadId: 'T-001', body: 'reply1', resolve: true },
      { threadId: 'T-999', body: 'stale reply', resolve: false },
    ]), 'utf-8');

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

  it('clears session file', async () => {
    await createBundle(manager, makeTarget(), [makeThread()]);

    const sessionPath = path.join(tmpDir, '.review-assist', 'session.json');
    expect(await fileExists(sessionPath)).toBe(true);

    await manager.clearSession();

    expect(await fileExists(sessionPath)).toBe(false);
  });

  it('clearSession is safe when files do not exist', async () => {
    // Should not throw even if nothing to clear
    await expect(manager.clearSession()).resolves.not.toThrow();
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

    const patchPath = path.join(tmpDir, '.review-assist', 'diffs', 'incremental.patch');
    const patch = await fs.readFile(patchPath, 'utf-8');
    expect(patch).toContain('diff --git a/src/foo.ts b/src/foo.ts');
    expect(patch).toContain('+new incremental line');
  });

  describe('writeContext', () => {
    it('writes CONTEXT.md with MR metadata', async () => {
      const threads = [makeThread()];
      const { threadIndex } = await createBundle(manager, makeTarget(), threads, [makeDiff()]);

      const contextPath = await manager.writeContext(
        makeTarget(),
        threads,
        [makeDiff()],
        [{ threadId: 'thread-abc', severity: 'high', category: 'correctness', summary: 'Fix null check' }],
        threadIndex,
      );

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

      const contextPath = await manager.writeContext(
        makeTarget(),
        threads,
        [],
        [{ threadId: 'thread-abc', severity: 'high', category: 'correctness', summary: 'Fix null check' }],
        threadIndex,
      );

      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).toContain('## Unresolved Threads');
      expect(content).toContain('T-001');
      expect(content).toContain('src/app.ts');
      expect(content).toContain('high');
      expect(content).toContain('Fix null check');
    });

    it('includes changed files list', async () => {
      const newFileDiff: ReviewDiff = {
        ...makeDiff(),
        newFile: true,
        newPath: 'src/new-file.ts',
        oldPath: 'src/new-file.ts',
      };

      const { threadIndex } = await createBundle(manager, makeTarget(), [], [makeDiff(), newFileDiff]);

      const contextPath = await manager.writeContext(
        makeTarget(),
        [],
        [makeDiff(), newFileDiff],
        [],
        threadIndex,
      );

      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).toContain('## Changed Files');
      expect(content).toContain('`src/app.ts` (modified)');
      expect(content).toContain('`src/new-file.ts` (added)');
    });

    it('marks incremental mode and NEW threads', async () => {
      const thread1 = makeThread();
      const thread2 = { ...makeThread(), threadId: 'thread-new' };
      const allThreads = [thread1, thread2];
      const { threadIndex } = await createBundle(manager, makeTarget(), allThreads);

      const contextPath = await manager.writeContext(
        makeTarget(),
        allThreads,
        [],
        [
          { threadId: 'thread-abc', severity: 'high', category: 'correctness', summary: 'Old thread' },
          { threadId: 'thread-new', severity: 'low', category: 'general', summary: 'New thread' },
        ],
        threadIndex,
        {
          incremental: true,
          previousThreadIds: new Set(['thread-abc']),
        },
      );

      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).toContain('Incremental review');
      expect(content).toContain('**NEW**');
      expect(content).toContain('## Incremental Review Summary');
      expect(content).toContain('1 new thread(s)');
      expect(content).toContain('1 carried-over thread(s)');
    });

    it('includes workflow instructions', async () => {
      const { threadIndex } = await createBundle(manager, makeTarget(), []);

      const contextPath = await manager.writeContext(makeTarget(), [], [], [], threadIndex);

      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).toContain('## Suggested Workflow');
      expect(content).toContain('REVIEW.md');
      expect(content).toContain('replies.json');
      expect(content).toContain('T-NNN');
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

      const contextPath = await manager.writeContext(
        makeTarget(),
        allThreads,
        [],
        [{ threadId: 'thread-abc', severity: 'high', category: 'correctness', summary: 'Fix null check' }],
        threadIndex,
      );

      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).toContain('## Unresolved Threads');
      expect(content).toContain('T-001');
      expect(content).toContain('## General Comments');
      expect(content).toContain('T-002');
      expect(content).toContain('Great work on this MR overall!');
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
