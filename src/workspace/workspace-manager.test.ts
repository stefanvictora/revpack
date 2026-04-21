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

  it('creates bundle directory structure', async () => {
    const bundle = await manager.createBundle(makeTarget(), [makeThread()], [makeDiff()], []);

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
    await manager.createBundle(makeTarget(), [], [], []);

    const sessionPath = path.join(tmpDir, '.review-assist', 'session.json');
    const session = JSON.parse(await fs.readFile(sessionPath, 'utf-8'));

    expect(session).toHaveProperty('id');
    expect(session).toHaveProperty('createdAt');
    expect(session.targetRef).toBeDefined();
  });

  it('writes target.json', async () => {
    await manager.createBundle(makeTarget(), [], [], []);

    const targetPath = path.join(tmpDir, '.review-assist', 'target.json');
    const target = JSON.parse(await fs.readFile(targetPath, 'utf-8'));

    expect(target.targetId).toBe('42');
    expect(target.title).toBe('Test MR');
  });

  it('writes thread JSON and markdown files', async () => {
    await manager.createBundle(makeTarget(), [makeThread()], [], []);

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
    await manager.createBundle(makeTarget(), [], [makeDiff()], []);

    const patchPath = path.join(tmpDir, '.review-assist', 'diffs', 'latest.patch');
    const patch = await fs.readFile(patchPath, 'utf-8');

    expect(patch).toContain('diff --git');
    expect(patch).toContain('src/app.ts');
  });

  it('writes output files', async () => {
    await manager.createBundle(makeTarget(), [], [], []);
    const outputPath = await manager.writeOutput('test.md', '# Test');

    expect(outputPath).toContain('outputs');
    const content = await fs.readFile(outputPath, 'utf-8');
    expect(content).toBe('# Test');
  });

  it('loads session from disk', async () => {
    await manager.createBundle(makeTarget(), [], [], []);
    const session = await manager.loadSession();

    expect(session).toBeTruthy();
    expect(session!.targetRef.targetId).toBe('42');
  });

  it('returns null when no session exists', async () => {
    const session = await manager.loadSession();
    expect(session).toBeNull();
  });

  it('assigns stable T-NNN IDs that persist across runs', async () => {
    const thread1 = makeThread();
    const thread2 = { ...makeThread(), threadId: 'thread-xyz', comments: thread1.comments };

    // First run: two threads
    await manager.createBundle(makeTarget(), [thread1, thread2], [], []);

    const threadDir = path.join(tmpDir, '.review-assist', 'threads');
    const files1 = (await fs.readdir(threadDir)).sort();
    expect(files1).toContain('T-001.json');
    expect(files1).toContain('T-002.json');

    // Verify the mapping file exists
    const mapPath = path.join(tmpDir, '.review-assist', 'thread-map.json');
    const map1 = JSON.parse(await fs.readFile(mapPath, 'utf-8'));
    expect(map1.entries['thread-abc']).toBe('T-001');
    expect(map1.entries['thread-xyz']).toBe('T-002');
    expect(map1.nextSeq).toBe(3);

    // Second run: thread1 resolved, thread2 remains, thread3 is new
    const thread3 = { ...makeThread(), threadId: 'thread-new', comments: thread1.comments };
    await manager.createBundle(makeTarget(), [thread2, thread3], [], []);

    // thread2 keeps T-002, thread3 gets T-003 (not T-001!)
    const map2 = JSON.parse(await fs.readFile(mapPath, 'utf-8'));
    expect(map2.entries['thread-abc']).toBe('T-001'); // still in map
    expect(map2.entries['thread-xyz']).toBe('T-002');
    expect(map2.entries['thread-new']).toBe('T-003');
    expect(map2.nextSeq).toBe(4);

    // Only current threads have files
    const files2 = (await fs.readdir(threadDir)).filter(f => f.endsWith('.json')).sort();
    expect(files2).toContain('T-002.json');
    expect(files2).toContain('T-003.json');
    expect(files2).not.toContain('T-001.json'); // old thread cleaned up
  });

  it('resolves T-NNN from thread-map.json', async () => {
    await manager.createBundle(makeTarget(), [makeThread()], [], []);

    const resolved = await manager.resolveThreadRef('T-001');
    expect(resolved).toBe('thread-abc');
  });

  it('passes through non-T-NNN refs unchanged', async () => {
    const resolved = await manager.resolveThreadRef('abc123def');
    expect(resolved).toBe('abc123def');
  });

  it('prunes stale replies on incremental runs', async () => {
    await manager.createBundle(makeTarget(), [makeThread()], [], []);

    // Write a replies.json with two entries
    const repliesPath = path.join(tmpDir, '.review-assist', 'outputs', 'replies.json');
    await fs.writeFile(repliesPath, JSON.stringify([
      { threadId: 'T-001', body: 'reply1', resolve: true },
      { threadId: 'T-999', body: 'stale reply', resolve: false },
    ]), 'utf-8');

    // Prune with only thread-abc active
    const activeIds = new Set(['thread-abc']);
    const pruned = await manager.pruneStaleReplies(activeIds);
    expect(pruned).toBe(1);

    const remaining = JSON.parse(await fs.readFile(repliesPath, 'utf-8'));
    expect(remaining).toHaveLength(1);
    expect(remaining[0].threadId).toBe('T-001');
  });

  it('returns 0 when pruning with no replies file', async () => {
    await manager.createBundle(makeTarget(), [], [], []);
    const pruned = await manager.pruneStaleReplies(new Set());
    expect(pruned).toBe(0);
  });

  it('clears session and thread map', async () => {
    await manager.createBundle(makeTarget(), [makeThread()], [], []);

    // Both files exist
    const sessionPath = path.join(tmpDir, '.review-assist', 'session.json');
    const mapPath = path.join(tmpDir, '.review-assist', 'thread-map.json');
    expect(await fileExists(sessionPath)).toBe(true);
    expect(await fileExists(mapPath)).toBe(true);

    await manager.clearSession();

    expect(await fileExists(sessionPath)).toBe(false);
    expect(await fileExists(mapPath)).toBe(false);
  });

  it('clearSession is safe when files do not exist', async () => {
    // Should not throw even if nothing to clear
    await expect(manager.clearSession()).resolves.not.toThrow();
  });

  it('writes incremental diff patch', async () => {
    await manager.createBundle(makeTarget(), [], [], []);

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
      await manager.createBundle(makeTarget(), [makeThread()], [makeDiff()], []);

      const contextPath = await manager.writeContext(
        makeTarget(),
        [makeThread()],
        [makeDiff()],
        [{ threadId: 'thread-abc', severity: 'high', category: 'correctness', summary: 'Fix null check' }],
      );

      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).toContain('# Review Context');
      expect(content).toContain('!42');
      expect(content).toContain('Test MR');
      expect(content).toContain('@alice');
      expect(content).toContain('feature/test');
    });

    it('includes thread overview table', async () => {
      await manager.createBundle(makeTarget(), [makeThread()], [], []);

      const contextPath = await manager.writeContext(
        makeTarget(),
        [makeThread()],
        [],
        [{ threadId: 'thread-abc', severity: 'high', category: 'correctness', summary: 'Fix null check' }],
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

      await manager.createBundle(makeTarget(), [], [makeDiff(), newFileDiff], []);

      const contextPath = await manager.writeContext(
        makeTarget(),
        [],
        [makeDiff(), newFileDiff],
        [],
      );

      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).toContain('## Changed Files');
      expect(content).toContain('`src/app.ts` (modified)');
      expect(content).toContain('`src/new-file.ts` (added)');
    });

    it('marks incremental mode and NEW threads', async () => {
      const thread1 = makeThread();
      const thread2 = { ...makeThread(), threadId: 'thread-new' };
      await manager.createBundle(makeTarget(), [thread1, thread2], [], []);

      const contextPath = await manager.writeContext(
        makeTarget(),
        [thread1, thread2],
        [],
        [
          { threadId: 'thread-abc', severity: 'high', category: 'correctness', summary: 'Old thread' },
          { threadId: 'thread-new', severity: 'low', category: 'general', summary: 'New thread' },
        ],
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
      await manager.createBundle(makeTarget(), [], [], []);

      const contextPath = await manager.writeContext(makeTarget(), [], [], []);

      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).toContain('## Suggested Workflow');
      expect(content).toContain('REVIEW.md');
      expect(content).toContain('replies.json');
      expect(content).toContain('T-NNN');
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
